/**
 * The envelope around a payment, and what happens after the irreversible call.
 *
 * The tests that matter here are the ones about the second half. Once `/settle` reports
 * success the money has moved, and §7 rule 6 says the request does not fail - so every path
 * below that line has to end in a 202 or a 200, never a refusal and never a throw.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FailureReporter } from "../src/server/failures.js";
import { bindingRequestFor, validateQuorumPayload } from "../src/server/payment.js";
import { settleAndRecord } from "../src/server/record.js";
import type { RecordDeps, SettleAndRecordParams } from "../src/server/record.js";
import { bindingRequirements, quorumRequirements } from "../src/server/requirements.js";
import { encodeHeaderValue } from "../src/x402/http.js";
import type { QuorumPaymentPayload, SettlementResponse } from "../src/x402/types.js";
import type { PoolTerms } from "../src/pool/client.js";

const FEE_PAYER = "0.0.7162784";
const PAY_TO = "0.0.10409980";
const TX_ID = "0.0.7162784@1789171200.000000000";
const PAYER = "0x00000000000000000000000000000000009f16e9";

const terms: PoolTerms = {
  poolId: 7n,
  recipient: "0x0000000000000000000000000000000000000001",
  coordinator: "0x0000000000000000000000000000000000000002",
  unitTinybars: 100_000_000n,
  threshold: 3,
  seats: 1,
  deadline: 1_789_171_200,
  state: "Open",
  resourceUrl: "https://quorum402.example/benchmark/agent-spend-eu",
};

const offer = { terms, network: "hedera:testnet" as const, payTo: PAY_TO, feePayer: FEE_PAYER };
const advertised = quorumRequirements(offer);

function payload(overrides: (p: QuorumPaymentPayload) => void = () => {}): QuorumPaymentPayload {
  const built: QuorumPaymentPayload = {
    x402Version: 2,
    resource: { url: terms.resourceUrl, description: "d", mimeType: "application/json" },
    accepted: structuredClone(advertised),
    payload: { poolId: "7", binding: { transaction: "AAAA" } },
  };
  overrides(built);
  return built;
}

function validate(p: QuorumPaymentPayload) {
  return validateQuorumPayload({ header: encodeHeaderValue(p), advertised });
}

describe("payment envelope", () => {
  it("accepts a payload that echoes what was advertised", async () => {
    assert.equal(validate(payload()).ok, true);
  });

  it("ignores the advisory seat count in the echo", async () => {
    // §3 makes `filled` stale by construction and §4 requires a server to ignore it. Comparing
    // it would reject an honest payment for being signed a moment after somebody else's.
    const stale = validate(payload((p) => (p.accepted.extra.filled = 0)));
    const absent = validate(payload((p) => delete p.accepted.extra.filled));

    assert.equal(stale.ok, true);
    assert.equal(absent.ok, true);
  });

  it("refuses a payload whose two pool ids disagree", async () => {
    // The ids travel separately. Reading one and crediting the other would attribute a payment
    // to a pool the payer never chose.
    const result = validate(payload((p) => (p.payload.poolId = "8")));

    assert.ok(!result.ok);
    assert.equal(result.reason, "pool-mismatch");
  });

  it("refuses a payload naming a pool this resource is not selling", async () => {
    const result = validateQuorumPayload({
      header: encodeHeaderValue(payload((p) => {
        p.payload.poolId = "9";
        p.accepted.extra.poolId = "9";
      })),
      advertised,
    });

    assert.ok(!result.ok);
    assert.equal(result.reason, "wrong-pool");
  });

  it("refuses an echo that quietly changes the price", async () => {
    const result = validate(payload((p) => (p.accepted.amount = "1")));

    assert.ok(!result.ok);
    assert.equal(result.reason, "terms-mismatch");
  });

  it("refuses an echo built against a fee payer that has since rotated", async () => {
    // The buyer's transfer is frozen against the old fee payer and could not settle. Refusing
    // here spends a 400 instead of the irreversible call.
    const result = validate(payload((p) => (p.accepted.extra.binding.extra.feePayer = "0.0.1")));

    assert.ok(!result.ok);
    assert.equal(result.reason, "terms-mismatch");
  });

  it("refuses a header that is not a payload at all", async () => {
    assert.equal(validateQuorumPayload({ header: undefined, advertised }).ok, false);
    assert.equal(validateQuorumPayload({ header: "nonsense", advertised }).ok, false);
  });

  it("hands the facilitator the binding's payload, by reference and unrewritten", async () => {
    // §7 rule 3. The binding payload is signed data - re-serialising it would be enough to
    // invalidate it, so identity is the assertion, not deep equality.
    const p = payload();
    const request = bindingRequestFor({
      payload: p,
      resource: p.resource,
      binding: bindingRequirements(offer),
    });

    assert.equal(request.payload, p.payload.binding, "the same object, not a copy");
    assert.equal(request.accepted.scheme, "exact", "the binding's scheme, not quorum");
    assert.equal(request.accepted.payTo, advertised.payTo);
  });
});

describe("settle and record", () => {
  const params: SettleAndRecordParams = {
    request: {} as never,
    requirements: bindingRequirements(offer),
    poolId: 7n,
    payer: PAYER,
    payerAccountId: "0.0.10407152",
    tinybars: 100_000_000n,
    expectedTxId: TX_ID,
  };

  function deps(over: {
    isValid?: boolean;
    settlement?: SettlementResponse;
    record?: () => Promise<{ depositId: bigint; counted: boolean; transactionId: string; gasUsed: bigint }>;
    revert?: string;
  }): RecordDeps & { logged: string[] } {
    const logged: string[] = [];
    return {
      logged,
      facilitator: {
        verify: async () => ({ isValid: over.isValid ?? true, invalidReason: "declined" }),
        settle: async () => over.settlement ?? { success: true, transactionId: TX_ID },
      },
      pools: {
        recordDeposit:
          over.record ??
          (async () => ({
            depositId: 3n,
            counted: true,
            transactionId: "0.0.1@1.0",
            gasUsed: 100n,
          })),
        revertReasonOf: async () => over.revert,
      },
      failures: new FailureReporter({ write: (line) => logged.push(line) }),
      sleep: async () => {},
      attempts: 3,
    };
  }

  it("records the deposit and reports the seat it took", async () => {
    const outcome = await settleAndRecord(deps({}), params);

    assert.ok(outcome.settled && outcome.attributed);
    assert.equal(outcome.deposit?.depositId, 3n);
    assert.equal(outcome.deposit?.counted, true);
    assert.equal(outcome.hederaTxId, TX_ID);
  });

  it("refuses before settling when the facilitator will not verify", async () => {
    // §2: spend the cheap refusal before the expensive one. Nothing has moved here.
    const outcome = await settleAndRecord(deps({ isValid: false }), params);

    assert.equal(outcome.settled, false);
  });

  it("treats settlement_pending as settled, because the money is on its way", async () => {
    // The specification makes it non-terminal and requires a non-empty transaction with it.
    // Refusing would tell a payer nothing happened while their funds were in flight.
    const outcome = await settleAndRecord(
      deps({
        settlement: { success: false, errorReason: "settlement_pending", transactionId: TX_ID },
      }),
      params,
    );

    assert.equal(outcome.settled, true);
  });

  it("retries a recording that failed, and succeeds on a later attempt", async () => {
    let calls = 0;
    const outcome = await settleAndRecord(
      deps({
        record: async () => {
          if (++calls < 3) throw new Error("CONTRACT_REVERT_EXECUTED");
          return { depositId: 5n, counted: true, transactionId: "0.0.1@1.0", gasUsed: 100n };
        },
      }),
      params,
    );

    assert.equal(calls, 3);
    assert.ok(outcome.settled && outcome.attributed);
    assert.equal(outcome.deposit?.depositId, 5n);
  });

  it("treats a duplicate on retry as the success it is, and claims nothing more", async () => {
    // The previous attempt landed and its response was lost. Reporting a failure would put a
    // phantom in the log that a maintainer would replay forever. But the transaction id is not
    // contract state, so this path cannot say which deposit it is or whether it took a seat -
    // and does not pretend to.
    const outcome = await settleAndRecord(
      deps({
        record: async () => {
          throw Object.assign(new Error("CONTRACT_REVERT_EXECUTED"), {
            transactionId: { toString: () => "0.0.1@1.0" },
          });
        },
        revert: "DuplicateTransaction",
      }),
      params,
    );

    assert.ok(outcome.settled && outcome.attributed);
    assert.equal(outcome.deposit, undefined, "counted is unknown, and is not guessed");
  });

  it("never fails the request when recording will not land, and logs it for replay", async () => {
    // The whole of §7 rule 6 in one case: the money moved, nothing can attribute it, and the
    // answer is still a 202 carrying the transaction id rather than a 500 that destroys the
    // payer's only evidence.
    const d = deps({
      record: async () => {
        throw new Error("INSUFFICIENT_PAYER_BALANCE");
      },
    });
    const outcome = await settleAndRecord(d, params);

    assert.ok(outcome.settled && !outcome.attributed);
    assert.equal(outcome.hederaTxId, TX_ID);
    assert.match(outcome.error, /INSUFFICIENT_PAYER_BALANCE/);

    assert.equal(d.logged.length, 1);
    const line = JSON.parse(d.logged[0]!) as Record<string, string>;
    assert.equal(line.hederaTxId, TX_ID);
    assert.equal(line.payer, PAYER);
    assert.match(line.retry!, /npm run record -- 7 /);
  });

  it("records under the id the payer signed, and flags a facilitator that reports another", async () => {
    const other = "0.0.9999@1789171200.000000000";
    const d = deps({ settlement: { success: true, transactionId: other } });
    const outcome = await settleAndRecord(d, params);

    assert.ok(outcome.settled && outcome.attributed);
    assert.equal(outcome.hederaTxId, TX_ID, "the frozen id, not the reported one");
    assert.equal(d.logged.length, 1, "and the disagreement is written down");
    assert.match(d.logged[0]!, /expected 0\.0\.7162784@/);
  });
});
