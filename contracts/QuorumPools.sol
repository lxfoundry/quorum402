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
 *         `PaymentRequirements.amount`. Hedera's EVM denominates HBAR in weibars, so
 *         `TINYBAR_TO_WEIBAR` appears at exactly the two places value crosses into the EVM:
 *         the solvency ceiling and a payout. Nowhere else.
 */
contract QuorumPools {
    /// 1 tinybar = 1e10 weibar. `address(this).balance` and `call{value:}` speak weibars.
    uint256 internal constant TINYBAR_TO_WEIBAR = 1e10;

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

    error BadThreshold();
    error BadUnitAmount();
    error DeadlineInPast();
    error ZeroAddress();
    error NoSuchPool(uint256 poolId);
    error NoSuchDeposit(uint256 poolId, uint256 depositId);
    error NotCoordinator(address caller, address coordinator);
    error DuplicateTransaction(string hederaTxId);
    error Insolvent(uint256 wouldCommit, uint256 availableTinybars);

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
     *         The three reverts left are all coordinator-side, and every one of them means the
     *         call is describing something that did not happen: an unknown pool, a payment
     *         already recorded, or money that is not in this contract.
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

        {
            bytes32 txKey = keccak256(bytes(hederaTxId));
            if (_txIdSeen[txKey]) revert DuplicateTransaction(hederaTxId);
            _txIdSeen[txKey] = true;
        }

        // The money must already be here. This is the check that stops a threshold being
        // crossed - or a refund being promised - against HBAR that never arrived.
        {
            uint256 wouldCommit = _totalCommitted + tinybars;
            uint256 available = address(this).balance / TINYBAR_TO_WEIBAR;
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

    /// @notice Tinybars owed to payers and recipients. The left side of the solvency invariant.
    function committedTinybars() external view returns (uint256) {
        return _totalCommitted;
    }

    /// @notice This contract's HBAR balance, in tinybars. Includes funds never attributed.
    function balanceTinybars() external view returns (uint256) {
        return address(this).balance / TINYBAR_TO_WEIBAR;
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
}
