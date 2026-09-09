/**
 * The bytes a redemption signature covers.
 *
 * `quorum-scheme.md` §8 makes this layout normative, so these assertions are against the exact
 * octets rather than against a parsed shape. That is deliberate and it is the whole point of the
 * file: a change that keeps the fields and moves a separator still breaks every signature ever
 * issued, and the only symptom is a verification failure that names nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalRedemptionMessage,
  decodeRedemptionReceipt,
  encodeRedemptionReceipt,
} from "../src/x402/redemption.js";
import type { RedemptionClaim, RedemptionReceipt } from "../src/x402/redemption.js";

const claim: RedemptionClaim = {
  accountId: "0.0.1235",
  network: "hedera:testnet",
  contract: "0.0.10409980",
  poolId: "7",
  transaction: "0.0.1235@1700000000.000000000",
  resource: "https://example.test/resource/7",
  validUntil: 1_789_171_500,
};

describe("the canonical redemption message", () => {
  it("is the exact byte sequence §8 specifies", () => {
    // Written out in full rather than assembled, so that this test fails if the builder and the
    // specification drift apart. Assembling it the same way the code does would only assert
    // that the code is self-consistent.
    const expected =
      "quorum402:redeem:v1\n" +
      "network hedera:testnet\n" +
      "contract 0.0.10409980\n" +
      "poolId 7\n" +
      "transaction 0.0.1235@1700000000.000000000\n" +
      "resource https://example.test/resource/7\n" +
      "validUntil 1789171500\n";

    assert.equal(canonicalRedemptionMessage(claim).toString("utf8"), expected);
  });

  it("terminates the last line, like every other line", () => {
    // The easiest detail to lose to a `join("\n")`, and it shifts nothing visible.
    const bytes = canonicalRedemptionMessage(claim);

    assert.equal(bytes[bytes.length - 1], 0x0a);
  });

  it("separates key from value with exactly one space", () => {
    const lines = canonicalRedemptionMessage(claim).toString("utf8").split("\n").slice(1, -1);

    for (const line of lines) {
      assert.match(line, /^[a-zA-Z]+ \S/, `"${line}" is not a single-space key/value pair`);
    }
  });

  it("keeps the version tag first and bare", () => {
    // A v2 message must not verify as a v1 one, and this line is what prevents it.
    const [first] = canonicalRedemptionMessage(claim).toString("utf8").split("\n");

    assert.equal(first, "quorum402:redeem:v1");
  });

  it("changes when any bound fact changes", () => {
    // §8's replay argument rests on this: a signature is good for one pool, on one contract, on
    // one network, for one resource, until one moment. Each of those has to reach the bytes.
    const base = canonicalRedemptionMessage(claim).toString("utf8");
    const variants: Array<[string, RedemptionClaim]> = [
      ["network", { ...claim, network: "hedera:mainnet" }],
      ["contract", { ...claim, contract: "0.0.99" }],
      ["poolId", { ...claim, poolId: "8" }],
      ["transaction", { ...claim, transaction: "0.0.1235@1700000001.000000000" }],
      ["resource", { ...claim, resource: "https://example.test/resource/8" }],
      ["validUntil", { ...claim, validUntil: 1_789_171_501 }],
    ];

    for (const [field, variant] of variants) {
      assert.notEqual(
        canonicalRedemptionMessage(variant).toString("utf8"),
        base,
        `${field} does not reach the signed bytes`,
      );
    }
  });

  it("does not bind the account id, which the signature settles instead", () => {
    // Binding it as well would let the envelope and the message disagree about who is claiming.
    const other = canonicalRedemptionMessage({ ...claim, accountId: "0.0.9999" });

    assert.equal(other.toString("utf8"), canonicalRedemptionMessage(claim).toString("utf8"));
  });
});

describe("the receipt envelope", () => {
  const receipt: RedemptionReceipt = {
    accountId: "0.0.1235",
    poolId: "7",
    transaction: "0.0.1235@1700000000.000000000",
    validUntil: 1_789_171_500,
    signature: Buffer.from("not-a-real-signature").toString("base64"),
  };

  it("round-trips through the header encoding", () => {
    assert.deepEqual(decodeRedemptionReceipt(encodeRedemptionReceipt(receipt)), receipt);
  });

  it("rejects anything malformed rather than throwing", () => {
    // Every caller answers 400, so a payer cannot act on which of these it was.
    const bad = [
      undefined,
      "",
      "not base64 at all!!",
      Buffer.from("[]").toString("base64"),
      Buffer.from('"a string"').toString("base64"),
      Buffer.from(JSON.stringify({ ...receipt, accountId: undefined })).toString("base64"),
      Buffer.from(JSON.stringify({ ...receipt, poolId: "" })).toString("base64"),
      Buffer.from(JSON.stringify({ ...receipt, signature: 7 })).toString("base64"),
    ];

    for (const header of bad) {
      assert.equal(decodeRedemptionReceipt(header), undefined, `accepted ${String(header)}`);
    }
  });

  it("refuses a validUntil that is not whole seconds", () => {
    // Milliseconds here would be a receipt valid for 56,000 years; a float rounds differently on
    // the two sides of the signature. Both are shapes, not values, so they belong at the door.
    const fractional = { ...receipt, validUntil: 1_789_171_500.5 };

    assert.equal(
      decodeRedemptionReceipt(Buffer.from(JSON.stringify(fractional)).toString("base64")),
      undefined,
    );
  });
});
