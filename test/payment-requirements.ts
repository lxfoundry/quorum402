/**
 * What a quorum-gated 402 offers.
 *
 * `quorum-scheme.md` §5 puts two MUSTs on the pair of entries, and both are the kind of thing
 * that breaks silently: a client picks an entry, builds a payment against it, and the mismatch
 * only surfaces as a facilitator rejection or - worse - as money sent somewhere unintended.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindingRequirements, paymentRequired, quorumRequirements } from "../src/server/requirements.js";
import { decodeHeaderValue, encodeHeaderValue } from "../src/x402/http.js";
import type { PaymentRequired } from "../src/x402/types.js";
import type { PoolTerms } from "../src/pool/client.js";

const FEE_PAYER = "0.0.7162784";
const PAY_TO = "0.0.10409980";

const terms: PoolTerms = {
  poolId: 7n,
  recipient: "0x0000000000000000000000000000000000000001",
  coordinator: "0x0000000000000000000000000000000000000002",
  unitTinybars: 100_000_000n,
  threshold: 3,
  seats: 1,
  deadline: 1_789_171_200,
  state: "Open",
  resourceUrl: "https://quorum402.example/resource/7",
};

const offer = { terms, network: "hedera:testnet" as const, payTo: PAY_TO, feePayer: FEE_PAYER };

describe("payment requirements", () => {
  it("offers the quorum entry first, then the exact fallback", async () => {
    // A client takes the first entry it understands, so the lossy description must not be it.
    const { accepts } = paymentRequired(offer);

    assert.equal(accepts.length, 2);
    assert.equal(accepts[0]?.scheme, "quorum");
    assert.equal(accepts[1]?.scheme, "exact");
  });

  it("describes the same payment in both entries", async () => {
    // §5: the fallback MUST declare the same payTo, amount, asset and network. It is the same
    // payment under the binding's own scheme, not a second offer.
    const [quorum, exact] = paymentRequired(offer).accepts;

    assert.ok(quorum && exact);
    assert.equal(quorum.payTo, exact.payTo);
    assert.equal(quorum.amount, exact.amount);
    assert.equal(quorum.asset, exact.asset);
    assert.equal(quorum.network, exact.network);
  });

  it("declares a payment flow on both entries", async () => {
    // §5: the Hedera exact binding declares no default flow, so a client has nothing to
    // resolve against and the field is required once the flow is not `authorization`.
    const [quorum, exact] = paymentRequired(offer).accepts;

    assert.equal(quorum?.extra.paymentFlow, "conditional");
    assert.equal(exact?.extra.paymentFlow, "upfront");
  });

  it("prices one seat, not the pool", async () => {
    // The pool is worth 3 HBAR at quorum. A payer owes 1.
    assert.equal(quorumRequirements(offer).amount, "100000000");
  });

  it("sends the payment to the contract, not to the seller", async () => {
    // ADR 0004: the money must be in the hold before the coordinator records it. A payTo of
    // the recipient would settle successfully and leave nothing to attribute.
    const quorum = quorumRequirements(offer);

    assert.equal(quorum.payTo, PAY_TO);
    assert.notEqual(quorum.payTo, terms.recipient);
  });

  it("carries the pool id as a string", async () => {
    // uint256 on-chain. A JSON number silently loses pool ids above 2^53.
    const { poolId } = quorumRequirements(offer).extra;

    assert.equal(poolId, "7");
    assert.equal(typeof poolId, "string");
  });

  it("reports the seats taken when the offer was written", async () => {
    const quorum = quorumRequirements(offer);

    assert.equal(quorum.extra.filled, 1);
    assert.equal(quorum.extra.threshold, 3);
    assert.equal(quorum.extra.deadline, terms.deadline);
  });

  it("names the same fee payer inside the binding as the fallback does at its top level", async () => {
    // The binding inherits amount, asset, payTo and network from the quorum level, and carries
    // only what the binding's own requirement needs. If these two disagree the client signs
    // against one fee payer and the facilitator checks the other.
    const quorum = quorumRequirements(offer);

    assert.equal(quorum.extra.binding.extra.feePayer, bindingRequirements(offer).extra.feePayer);
  });

  it("says the resource may never be served, where a client can actually read it", async () => {
    // §5's residual silence: `paymentFlow: "upfront"` is accurate about timing and cannot
    // express conditionality, and an accepts entry has no human-readable field. So the warning
    // lives on the PaymentRequired instead.
    const required = paymentRequired(offer);

    assert.match(required.error, /refunded/);
    assert.match(required.resource.description, /All-or-nothing/);
    assert.equal(required.resource.url, terms.resourceUrl);
  });

  it("survives the header encoding intact", async () => {
    // All three x402 headers are base64 JSON (`specs/transports-v2/http.md`, read 2026-09-08).
    const required = paymentRequired(offer);

    const decoded = decodeHeaderValue<PaymentRequired>(encodeHeaderValue(required));

    assert.deepEqual(decoded, required);
  });

  it("reads an unusable header as absent rather than throwing", async () => {
    // Every caller is a request handler that answers 400. Throwing would make each one catch.
    assert.equal(decodeHeaderValue(undefined), undefined);
    assert.equal(decodeHeaderValue("not base64 JSON at all"), undefined);
    assert.equal(decodeHeaderValue(encodeHeaderValue("a bare string")), undefined);
  });
});
