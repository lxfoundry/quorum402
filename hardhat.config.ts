import type { HardhatUserConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";

/**
 * The contract is written for Hedera's smart contract service, but its tests run on the
 * local EVM, which is the point: the escrow arithmetic, the state machine and the refund
 * paths are network-independent, and testing them against a real testnet would trade
 * seconds for minutes and determinism for flakiness.
 *
 * The two settings below are what keep that trade honest. `evmVersion: "cancun"` matches
 * what Hedera compiles against, so the local EVM is the one the contract is deployed to.
 * Deployment itself is not configured here - there is no JSON-RPC network entry - because
 * Hedera deployment goes through the SDK already in this repo, not through a relay.
 */
const config: HardhatUserConfig = {
  plugins: [hardhatViem, hardhatViemAssertions, hardhatNetworkHelpers, hardhatNodeTestRunner],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
};

export default config;
