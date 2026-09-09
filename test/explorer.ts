/**
 * HashScan links, because a dead one is a silent failure.
 *
 * This is the only module in the project whose defects show up nowhere but in a browser: nothing
 * calls these URLs, so a wrong separator passes every other check and fails in front of whoever
 * clicks it. The rewrite is one regex and it is worth pinning exactly.
 *
 * The form is not a guess. `https://testnet.mirrornode.hedera.com/api/v1/transactions/` answers
 * 200 for `0.0.10404217-1788803605-204518884` and **400** for the `@`-and-dot spelling the SDK
 * prints, and HashScan reads the mirror node.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashscanAccount,
  hashscanContract,
  hashscanTransaction,
} from "../src/hedera/explorer.js";

describe("hashscanTransaction", () => {
  it("rewrites both separators and leaves the account's own dots alone", () => {
    assert.equal(
      hashscanTransaction("testnet", "0.0.10404217@1788803605.204518884"),
      "https://hashscan.io/testnet/transaction/0.0.10404217-1788803605-204518884",
    );
  });

  it("accepts an id already in the mirror node's dashed spelling", () => {
    // The two sources disagree - the SDK prints `@`, the mirror node prints `-` - and a caller
    // holding one should not have to know which it has.
    assert.equal(
      hashscanTransaction("testnet", "0.0.10404217-1788803605-204518884"),
      "https://hashscan.io/testnet/transaction/0.0.10404217-1788803605-204518884",
    );
  });

  it("takes either spelling of the network", () => {
    const caip2 = hashscanTransaction("hedera:testnet", "0.0.1@2.3");
    assert.equal(caip2, hashscanTransaction("testnet", "0.0.1@2.3"));
    assert.equal(caip2, "https://hashscan.io/testnet/transaction/0.0.1-2-3");
  });

  it("keeps mainnet off the testnet explorer", () => {
    assert.match(
      hashscanTransaction("hedera:mainnet", "0.0.1@2.3") ?? "",
      /^https:\/\/hashscan\.io\/mainnet\//,
    );
  });

  it("answers undefined rather than a link that goes nowhere", () => {
    // An EVM hash is the realistic case: a facilitator may return one where a transaction id was
    // expected, and `settlementTxId` refuses it upstream for exactly this reason.
    assert.equal(hashscanTransaction("testnet", `0x${"ab".repeat(32)}`), undefined);
    assert.equal(hashscanTransaction("testnet", ""), undefined);
    assert.equal(hashscanTransaction("testnet", "0.0.10404217"), undefined);
    assert.equal(hashscanTransaction("testnet", "not an id"), undefined);
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(
      hashscanTransaction("testnet", "  0.0.1@2.3\n"),
      "https://hashscan.io/testnet/transaction/0.0.1-2-3",
    );
  });
});

describe("hashscanContract and hashscanAccount", () => {
  it("address an entity by its id, on the network given", () => {
    assert.equal(
      hashscanContract("hedera:testnet", "0.0.10409980"),
      "https://hashscan.io/testnet/contract/0.0.10409980",
    );
    assert.equal(
      hashscanAccount("testnet", "0.0.10434979"),
      "https://hashscan.io/testnet/account/0.0.10434979",
    );
  });
});
