// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title  GasBurner
 * @notice A payer that burns every unit of gas forwarded to it.
 * @dev    Test support only. `_payout` sends without a gas cap - deliberately, because a
 *         2300-gas stipend would break any payer that is itself a contract - so the callee
 *         receives 63/64 of the frame and can consume all of it. One of these sitting at a
 *         low index is what makes a refund scan that must start at zero unable to finish,
 *         and it is the reason `refundAll` lets its caller choose where to start.
 */
contract GasBurner {
    uint256 public sink;

    receive() external payable {
        while (true) {
            sink++;
        }
    }
}
