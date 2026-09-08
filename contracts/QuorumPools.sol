// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title  QuorumPools
 * @notice One contract, many pools. A pool is a threshold, a deadline, a unit price and a
 *         recipient. Buyers pay the unit price over x402 to this contract's own Hedera
 *         account, and the pool's coordinator records each settled payment. If enough
 *         distinct buyers pay before the deadline the funds go to the recipient; otherwise
 *         every buyer gets their money back. Nobody can do anything else with the funds,
 *         including whoever deployed this.
 *
 * @dev    Specified in `specs/pool-contract.md`, written before this file. The decisions it
 *         implements are in `specs/adr/0001`-`0004`.
 *
 *         The ledger is kept entirely in TINYBARS, matching what x402 quotes in
 *         `PaymentRequirements.amount` - and matching what Hedera's EVM itself moves, so no
 *         conversion appears anywhere in this contract. `address(this).balance` and
 *         `call{value:}` are both denominated in tinybars here, which is NOT what a contract
 *         written for Ethereum would assume: 18-decimal weibars are what the JSON-RPC relay
 *         presents to Ethereum tooling, not what the EVM runs on. Observed on testnet, see
 *         `scripts/check-payout.ts`.
 */
contract QuorumPools {

    enum State {
        Open,
        Met,
        Expired,
        Released
    }

    /// Why a settled payment took no seat. Emitted with `LateDeposit`; never inferred.
    enum LateReason {
        ThresholdMet,
        DeadlinePassed,
        SeatTaken,
        WrongAmount
    }

    /**
     * @dev Field order follows the spec rather than the tightest possible packing. Reordering
     *      would save one slot per pool - paid once, at creation - at the cost of changing the
     *      tuple order `poolOf` returns, which is a published interface. Deposits are the
     *      frequent write, and those are packed (see `Deposit`).
     */
    struct Pool {
        address recipient;
        address coordinator;
        uint64 unitTinybars;
        uint32 threshold;
        uint32 seats; // counted deposits so far
        uint64 deadline; // unix seconds
        State state;
        string resourceUrl;
    }

    /**
     * @dev One settled x402 payment, attributed to a pool.
     *
     *      20 bytes of address, 8 of amount and 2 of flags fit a single slot, which is why the
     *      amount is `uint64`: total HBAR supply is 5e18 tinybars against a `uint64` ceiling of
     *      1.8e19, so no real amount can overflow one.
     *
     *      `hederaTxId` is deliberately absent. No logic here reads it - the uniqueness guard
     *      hashes it straight from calldata - so it is emitted rather than stored, where the
     *      indexer and any human can still find it and it costs nothing to keep.
     */
    struct Deposit {
        address payer; // the EVM address `claimRefund` matches `msg.sender` against
        uint64 tinybars;
        bool counted; // false => late: no seat, refundable at once
        bool refunded;
    }

    Pool[] private _pools;

    /// Deposits per pool, in the order they were recorded. A payer may hold several.
    mapping(uint256 => Deposit[]) private _deposits;

    /// One seat per payer per pool.
    mapping(uint256 => mapping(address => bool)) private _seatTaken;

    /**
     * @dev `keccak256(hederaTxId)` of every payment ever recorded, across all pools, so one
     *      settlement cannot be counted into two of them. Global on purpose, and permanent:
     *      it has to outlive the deposit it guards, or a coordinator could record the same
     *      payment again once that deposit was settled.
     */
    mapping(bytes32 => bool) private _txIdSeen;

    /// Tinybars this contract owes to a payer or a recipient. Never derived from `balance`.
    uint256 private _totalCommitted;

    /// Owed to someone whose push transfer failed. The escape hatch, not a routine path.
    mapping(address => uint256) private _credit;

    event PoolCreated(
        uint256 indexed poolId,
        address indexed coordinator,
        address indexed recipient,
        uint64 unitTinybars,
        uint32 threshold,
        uint64 deadline,
        string resourceUrl
    );

    event DepositRecorded(
        uint256 indexed poolId,
        address indexed payer,
        uint256 depositId,
        uint64 tinybars,
        string hederaTxId,
        uint32 seatsAfter
    );

    event LateDeposit(
        uint256 indexed poolId,
        address indexed payer,
        uint256 depositId,
        uint64 tinybars,
        string hederaTxId,
        LateReason reason
    );

    event ThresholdMet(uint256 indexed poolId, uint32 seats, uint64 at);

    event PoolExpired(uint256 indexed poolId, uint64 at);

    event Released(uint256 indexed poolId, address indexed recipient, uint64 tinybars);

    event Refunded(uint256 indexed poolId, address indexed payer, uint256 depositId, uint64 tinybars);

    /**
     * @dev A state transition happened and the HBAR did not move with it. Always paired with
     *      the transition's own event - `Released` or `Refunded` - which is what a subgraph
     *      reads to track state. This one says the money is now sitting in `credit`.
     */
    event PayoutFailed(uint256 indexed poolId, address indexed to, uint64 tinybars);

    event Withdrawn(address indexed to, uint64 tinybars);

    error BadThreshold();
    error BadUnitAmount();
    error DeadlineInPast();
    error ZeroAddress();
    error NoSuchPool(uint256 poolId);
    error NoSuchDeposit(uint256 poolId, uint256 depositId);
    error NotCoordinator(address caller, address coordinator);
    error DuplicateTransaction(string hederaTxId);
    error Insolvent(uint256 wouldCommit, uint256 availableTinybars);
    error NotMet(uint256 poolId, State state);
    error NotDue(uint256 poolId, State state);
    error NoCredit();
    error PayoutRejected(address to, uint256 tinybars);
    error NothingToRefund(uint256 poolId, address payer);
    error ZeroAmount();
    error PoolTooLarge(uint256 totalTinybars);

    /**
     * @notice Open a pool. Anyone may; the caller gains no authority by doing so.
     * @dev    Terms are immutable once set - there is no method that changes any of them.
     * @return poolId The new pool's id, allocated sequentially from zero.
     */
    function createPool(
        address recipient,
        address coordinator,
        uint64 unitTinybars,
        uint32 threshold,
        uint64 deadline,
        string calldata resourceUrl
    ) external returns (uint256 poolId) {
        if (recipient == address(0) || coordinator == address(0)) revert ZeroAddress();
        if (threshold == 0) revert BadThreshold();
        if (unitTinybars == 0) revert BadUnitAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        // A full pool pays `threshold * unitTinybars`, and `release` emits that as a `uint64`.
        // Refusing an unpayable pool here is what makes that cast safe, rather than an appeal
        // to HBAR's total supply being small enough that no real pool could reach the ceiling.
        // The supply argument happens to hold; it is not this contract's to enforce.
        uint256 fullPool = uint256(threshold) * uint256(unitTinybars);
        if (fullPool > type(uint64).max) revert PoolTooLarge(fullPool);

        poolId = _pools.length;
        _pools.push(
            Pool({
                recipient: recipient,
                coordinator: coordinator,
                unitTinybars: unitTinybars,
                threshold: threshold,
                seats: 0,
                deadline: deadline,
                state: State.Open,
                resourceUrl: resourceUrl
            })
        );

        emit PoolCreated(poolId, coordinator, recipient, unitTinybars, threshold, deadline, resourceUrl);
    }

    /**
     * @notice Attribute one settled x402 payment to a pool.
     * @dev    The pool's coordinator alone may call this, and calling it is the whole of the
     *         coordinator's authority: it cannot move funds, change terms, or refund anyone.
     *
     *         It never reverts for a buyer-side reason. By the time this runs the buyer's HBAR
     *         has already landed - a native CryptoTransfer executes no code, so there was
     *         nothing to reject at the moment it arrived, and refusing it now would only
     *         strand it (ADR 0004). A payment that cannot take a seat is recorded as a late
     *         deposit and becomes refundable at once.
     *
     *         The reverts left are all coordinator-side, and every one of them means the call
     *         is describing something that did not happen: an unknown pool, a payment already
     *         recorded, money that is not in this contract, or a payment of nothing.
     *
     *         That last one is not in tension with ADR 0004. Refusing a deposit is only
     *         dangerous when HBAR has arrived and rejecting the record would strand it; zero
     *         tinybars is the case where nothing arrived, so there is nothing to strand. A
     *         zero-amount deposit is also the one kind its payer could never clear - a refund
     *         of nothing leaves `claimRefund` with nothing to pay and it reverts - so it would
     *         sit in the scan forever.
     * @return depositId Index of the deposit within the pool.
     * @return counted   Whether it took a seat.
     */
    function recordDeposit(uint256 poolId, address payer, uint64 tinybars, string calldata hederaTxId)
        external
        returns (uint256 depositId, bool counted)
    {
        Pool storage pool = _pool(poolId);
        if (msg.sender != pool.coordinator) revert NotCoordinator(msg.sender, pool.coordinator);
        if (payer == address(0)) revert ZeroAddress();
        if (tinybars == 0) revert ZeroAmount();

        {
            bytes32 txKey = keccak256(bytes(hederaTxId));
            if (_txIdSeen[txKey]) revert DuplicateTransaction(hederaTxId);
            _txIdSeen[txKey] = true;
        }

        // The money must already be here. This is the check that stops a threshold being
        // crossed - or a refund being promised - against HBAR that never arrived.
        {
            uint256 wouldCommit = _totalCommitted + tinybars;
            uint256 available = address(this).balance;
            if (wouldCommit > available) revert Insolvent(wouldCommit, available);
            _totalCommitted = wouldCommit;
        }

        depositId = _deposits[poolId].length;

        (bool late, LateReason reason) = _lateness(pool, poolId, payer, tinybars);
        counted = !late;

        _deposits[poolId].push(Deposit({payer: payer, tinybars: tinybars, counted: counted, refunded: false}));

        if (late) {
            emit LateDeposit(poolId, payer, depositId, tinybars, hederaTxId, reason);
            return (depositId, false);
        }

        _seatTaken[poolId][payer] = true;
        uint32 seats = pool.seats + 1;
        pool.seats = seats;
        emit DepositRecorded(poolId, payer, depositId, tinybars, hederaTxId, seats);

        if (seats == pool.threshold) {
            pool.state = State.Met;
            emit ThresholdMet(poolId, seats, uint64(block.timestamp));
        }
    }

    /**
     * @notice Record that a pool's deadline passed without its threshold being reached.
     * @dev    Permissionless, because it decides nothing: it writes down a fact the clock had
     *         already settled, and `statusOf` reports that fact whether or not anyone has
     *         called this. Optional, too - the refund paths stamp it themselves.
     *
     *         Idempotent once stamped. It reverts on a pool that is not due, which includes a
     *         met pool at any time: quorum was reached, and no clock un-reaches it.
     */
    function expire(uint256 poolId) external {
        Pool storage pool = _pool(poolId);
        State state = _effectiveState(pool);
        if (state != State.Expired) revert NotDue(poolId, state);
        _stampExpired(pool, poolId);
    }

    /**
     * @notice Pay a met pool's counted total to the recipient it named at creation.
     * @dev    Permissionless, and for the same reason `expire` is: it chooses nothing. The
     *         recipient and the amount were both fixed when the pool was created, and the
     *         only thing that unlocks this is the threshold having been reached. Gating it
     *         would add someone who can stall the outcome without adding anyone who can
     *         change it.
     *
     *         Late deposits are not paid out. Only seats are, at the unit price - the rest of
     *         the pool's balance is still owed to the payers who sent it.
     */
    function release(uint256 poolId) external {
        Pool storage pool = _pool(poolId);
        State state = _effectiveState(pool);
        if (state != State.Met) revert NotMet(poolId, state);

        address recipient = pool.recipient;
        // `seats <= threshold`, and `createPool` refused any pool whose full total would not
        // fit a `uint64`, so the casts below cannot truncate.
        uint256 amount = uint256(pool.seats) * uint256(pool.unitTinybars);

        // Terminal before the transfer, so nothing that reenters can be paid twice.
        pool.state = State.Released;
        emit Released(poolId, recipient, uint64(amount));

        if (!_payout(recipient, amount)) {
            _credit[recipient] += amount;
            emit PayoutFailed(poolId, recipient, uint64(amount));
        }
    }

    /**
     * @notice Take back every refundable deposit you hold in a pool.
     * @dev    The trust-minimal path: the payer needs nobody's cooperation to be repaid. It
     *         expires the pool first if the deadline has passed, so a refund never waits on
     *         someone else having called `expire`.
     *
     *         The scan is over the pool's whole deposit list, because refundability is not
     *         monotonic in index - a late deposit is refundable the moment it is recorded,
     *         while a counted one only becomes refundable when the pool expires - so there is
     *         no prefix that can be skipped. The caller pays for that scan, and it is bounded
     *         by the pool's own deposit count - which on a large enough pool is not a bound
     *         worth having. `refundAll` takes a window for that reason; this one does not,
     *         because the payer sweeping their own deposits has to reach all of them in one
     *         call to know they are done, and a payer's deposits are few.
     * @return tinybars The total refunded to the caller.
     */
    function claimRefund(uint256 poolId) external returns (uint256 tinybars) {
        Pool storage pool = _pool(poolId);
        _expireIfDue(pool, poolId);
        bool expired = pool.state == State.Expired;

        Deposit[] storage deposits = _deposits[poolId];
        uint256 total = deposits.length;
        for (uint256 i = 0; i < total; i++) {
            Deposit storage deposit = deposits[i];
            if (deposit.payer != msg.sender || !_isRefundable(deposit, expired)) continue;
            tinybars += deposit.tinybars;
            _refundOne(poolId, i, deposit);
        }

        if (tinybars == 0) revert NothingToRefund(poolId, msg.sender);
    }

    /**
     * @notice Push refunds out to the payers of deposits `startIndex` through
     *         `startIndex + maxDeposits`.
     * @dev    Not a convenience. A buyer who spent their HBAR paying may not be able to afford
     *         the gas to claim it back, so this is the path that actually runs at a failed
     *         deadline - and it is permissionless for the same reason the rest of the outcome
     *         is: it moves each deposit to the payer who made it, and nowhere else.
     *
     *         `maxDeposits` bounds the deposits **examined**, not the refunds made, because
     *         examining is what costs gas. A window that turns out to be all already-refunded
     *         costs a bounded scan and returns zero. Drive it by advancing `startIndex` a
     *         window at a time until `startIndex >= depositCount(poolId)` - not by calling
     *         until it returns zero, which would stop at the first exhausted window while
     *         money remained further down the list.
     *
     *         `startIndex` is a hint from the caller, not state this contract keeps, and the
     *         difference is the whole point. A stored cursor would be wrong: late deposits
     *         become refundable at different times from counted ones, so an index the scan
     *         has already passed can hold money that is only now owed, and a cursor could
     *         never go back for it. Already-refunded deposits are skipped rather than cursored
     *         past, so any window may be re-scanned safely, in any order, by anyone.
     *
     *         It also buys the one thing a from-zero scan could not. `_payout` forwards all
     *         remaining gas, so a payer contract that burns gas in its `receive()` takes
     *         63/64 of the frame; sitting at a low index, it would block every call that had
     *         to start at zero. A caller can now step over it and refund everyone else.
     * @return refunded How many deposits this call actually refunded.
     */
    function refundAll(uint256 poolId, uint256 startIndex, uint256 maxDeposits)
        external
        returns (uint256 refunded)
    {
        Pool storage pool = _pool(poolId);
        _expireIfDue(pool, poolId);
        bool expired = pool.state == State.Expired;

        Deposit[] storage deposits = _deposits[poolId];
        uint256 total = deposits.length;
        if (startIndex >= total) return 0; // Past the end. The expiry above still stands.

        // Clamped rather than added, so a caller passing a huge window gets the rest of the
        // list instead of an overflow revert.
        uint256 remaining = total - startIndex;
        uint256 end = startIndex + (maxDeposits < remaining ? maxDeposits : remaining);

        for (uint256 i = startIndex; i < end; i++) {
            Deposit storage deposit = deposits[i];
            if (!_isRefundable(deposit, expired)) continue;
            refunded++;
            _refundOne(poolId, i, deposit);
        }
    }

    /**
     * @notice Pull whatever this contract owes you after a push transfer failed.
     * @dev    The escape hatch. Nothing reaches `credit` on a path that worked.
     */
    function withdraw() external returns (uint256 tinybars) {
        tinybars = _credit[msg.sender];
        if (tinybars == 0) revert NoCredit();

        _credit[msg.sender] = 0;
        if (!_payout(msg.sender, tinybars)) revert PayoutRejected(msg.sender, tinybars);
        emit Withdrawn(msg.sender, uint64(tinybars));
    }

    /// @notice How many pools exist. Ids are `0 .. poolCount() - 1`.
    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    /// @notice A pool's terms and its *stored* state. For the effective state use `statusOf`.
    function poolOf(uint256 poolId) external view returns (Pool memory) {
        return _pool(poolId);
    }

    /**
     * @notice A pool's effective state.
     * @dev    A pool still `Open` when its deadline passes reads as `Expired` here before
     *         anyone has stamped it. Stored state and effective state differ exactly in that
     *         window, and every method that acts on state resolves it first.
     */
    function statusOf(uint256 poolId) external view returns (State) {
        return _effectiveState(_pool(poolId));
    }

    /// @notice How many deposits a pool has recorded, counted and late alike.
    function depositCount(uint256 poolId) external view returns (uint256) {
        _pool(poolId);
        return _deposits[poolId].length;
    }

    /// @notice One deposit, by its index within the pool.
    function depositAt(uint256 poolId, uint256 depositId) external view returns (Deposit memory) {
        _pool(poolId);
        if (depositId >= _deposits[poolId].length) revert NoSuchDeposit(poolId, depositId);
        return _deposits[poolId][depositId];
    }

    /// @notice Tinybars owed to one address whose push transfer failed. Claim with `withdraw`.
    function creditOf(address who) external view returns (uint256) {
        return _credit[who];
    }

    /// @notice Tinybars owed to payers and recipients. The left side of the solvency invariant.
    function committedTinybars() external view returns (uint256) {
        return _totalCommitted;
    }

    /// @notice This contract's HBAR balance, in tinybars. Includes funds never attributed.
    function balanceTinybars() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @dev Not needed by the x402 path - a native CryptoTransfer credits this account without
     *      executing any code - but present so an EVM-side top-up is not silently rejected.
     */
    receive() external payable {}

    function _pool(uint256 poolId) private view returns (Pool storage) {
        if (poolId >= _pools.length) revert NoSuchPool(poolId);
        return _pools[poolId];
    }

    /**
     * @dev Whether a payment can take a seat, and if not, why.
     *
     *      Resolved in the order that tells the payer the most useful thing: a pool that has
     *      ended says so first, and only a pool still taking payments reports a taken seat or
     *      a wrong amount.
     */
    function _lateness(Pool storage pool, uint256 poolId, address payer, uint64 tinybars)
        private
        view
        returns (bool late, LateReason reason)
    {
        State state = _effectiveState(pool);
        if (state == State.Expired) return (true, LateReason.DeadlinePassed);
        if (state != State.Open) return (true, LateReason.ThresholdMet); // Met, or Released
        if (_seatTaken[poolId][payer]) return (true, LateReason.SeatTaken);
        if (tinybars != pool.unitTinybars) return (true, LateReason.WrongAmount);
        return (false, LateReason.ThresholdMet); // unread when `late` is false
    }

    function _effectiveState(Pool storage pool) private view returns (State) {
        if (pool.state == State.Open && block.timestamp >= pool.deadline) return State.Expired;
        return pool.state;
    }

    /**
     * @dev A counted deposit is refundable only once the pool has expired - quorum was the
     *      thing it was waiting on. A late deposit never took a seat, so it is refundable in
     *      every state, including `Met` and `Released`.
     */
    function _isRefundable(Deposit storage deposit, bool expired) private view returns (bool) {
        if (deposit.refunded) return false;
        return expired || !deposit.counted;
    }

    /**
     * @dev Marked refunded *before* the HBAR is sent, so a payer who reenters from their own
     *      `receive()` finds nothing left to claim. That ordering is what makes the loops in
     *      `claimRefund` and `refundAll` safe to send from while they are still walking.
     */
    function _refundOne(uint256 poolId, uint256 depositId, Deposit storage deposit) private {
        deposit.refunded = true;

        address payer = deposit.payer;
        uint64 tinybars = deposit.tinybars;
        emit Refunded(poolId, payer, depositId, tinybars);

        if (!_payout(payer, tinybars)) {
            _credit[payer] += tinybars;
            emit PayoutFailed(poolId, payer, tinybars);
        }
    }

    /// @dev Stamps a pool that is due. Refund paths call this so nobody has to call `expire`.
    function _expireIfDue(Pool storage pool, uint256 poolId) private {
        if (_effectiveState(pool) == State.Expired) _stampExpired(pool, poolId);
    }

    /// @dev Writes the stamp if it is not already there. The caller has checked it is due.
    function _stampExpired(Pool storage pool, uint256 poolId) private {
        if (pool.state == State.Expired) return;
        pool.state = State.Expired;
        emit PoolExpired(poolId, uint64(block.timestamp));
    }

    /**
     * @dev Send tinybars. No conversion: Hedera's EVM denominates `value` in tinybars, the
     *      same unit this contract's ledger is kept in.
     *
     *      `call` rather than `transfer`, because the 2300-gas stipend is not a safe assumption
     *      on Hedera. `_totalCommitted` falls only when the HBAR has actually left - a failed
     *      send leaves the debt exactly where it was, because it is still owed.
     */
    function _payout(address to, uint256 tinybars) private returns (bool ok) {
        if (tinybars == 0) return true;
        (ok,) = payable(to).call{value: tinybars}("");
        if (ok) _totalCommitted -= tinybars;
    }
}
