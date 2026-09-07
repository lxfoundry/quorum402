// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRefundable {
    function claimRefund(uint256 poolId) external returns (uint256 tinybars);
}

/**
 * @title  ReentrantPayer
 * @notice A payer that tries to claim its refund a second time from inside the first one.
 * @dev    Test support only. `claimRefund` sends HBAR while it is still walking the deposit
 *         list, so the ordering it uses - mark the deposit refunded, then send - is load
 *         bearing rather than stylistic. This contract is what turns that into something the
 *         test suite can check instead of something a comment asserts.
 */
contract ReentrantPayer {
    address public pools;
    uint256 public poolId;

    uint256 public reentryAttempts;
    bool public reentryPaid;

    bool private _inside;

    function arm(address pools_, uint256 poolId_) external {
        pools = pools_;
        poolId = poolId_;
    }

    function claim() external returns (uint256) {
        return IRefundable(pools).claimRefund(poolId);
    }

    receive() external payable {
        if (_inside || pools == address(0)) return;
        _inside = true;
        reentryAttempts++;
        // A second refund would arrive here as a second `receive()`. Swallow the revert, so
        // the outer refund still succeeds and the test sees what was paid rather than a
        // transaction that failed for the wrong reason.
        try IRefundable(pools).claimRefund(poolId) returns (uint256) {
            reentryPaid = true;
        } catch {}
        _inside = false;
    }
}
