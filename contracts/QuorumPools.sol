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

    Pool[] private _pools;

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

    error BadThreshold();
    error BadUnitAmount();
    error DeadlineInPast();
    error ZeroAddress();
    error NoSuchPool(uint256 poolId);

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

    function _effectiveState(Pool storage pool) private view returns (State) {
        if (pool.state == State.Open && block.timestamp >= pool.deadline) return State.Expired;
        return pool.state;
    }
}
