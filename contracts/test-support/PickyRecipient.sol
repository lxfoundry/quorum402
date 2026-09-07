// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IWithdrawable {
    function withdraw() external returns (uint256 tinybars);
}

/**
 * @title  PickyRecipient
 * @notice A recipient that can refuse HBAR, so the failed-payout path can be tested.
 * @dev    Test support only. It is never deployed by anything in `scripts/` and is not part
 *         of the system - it exists because the alternative is trusting that the `credit`
 *         fallback works without ever having seen it run.
 */
contract PickyRecipient {
    bool public accepting;

    function setAccepting(bool value) external {
        accepting = value;
    }

    /// Pulls whatever the pool contract owes this address after a push failed.
    function withdrawFrom(address pools) external returns (uint256) {
        return IWithdrawable(pools).withdraw();
    }

    receive() external payable {
        require(accepting, "PickyRecipient: not accepting");
    }
}
