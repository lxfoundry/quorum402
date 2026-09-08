/**
 * The gate in front of the irreversible step - ADR 0006.
 *
 * Each refusal here is a `recordDeposit` revert that would otherwise have happened *after*
 * settlement, where the payer has paid and §7 rule 6 forbids failing the request. So what is
 * being tested is not really the conditions; it is that each one costs the buyer nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FailureReporter } from "../src/server/failures.js";
import { MIN_COORDINATOR_TINYBARS, preflight } from "../src/server/preflight.js";
import type { PreflightDeps } from "../src/server/preflight.js";
import type { PoolAvailability } from "../src/server/pools.js";
import type { PoolTerms } from "../src/pool/client.js";

const COORDINATOR = "0x0000000000000000000000000000000000000002";
const TX_ID = "0.0.7162784@1789171200.000000000";

const terms: PoolTerms = {
  poolId: 7n,
  recipient: "0x0000000000000000000000000000000000000001",
  coordinator: COORDINATOR,
  unitTinybars: 100_000_000n,
  threshold: 3,
  seats: 1,
  deadline: 1_789_171_200,
  state: "Open",
  resourceUrl: "https://quorum402.example/resource/7",
};

const selling: PoolAvailability = { available: true, terms, state: "Open" };

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    contract: {
      committedTinybars: async () => 1_000_000_000n,
      balanceTinybars: async () => 1_000_000_000n,
    },
    coordinatorAccountId: "0.0.10404217",
    coordinatorAddress: COORDINATOR,
    coordinatorBalanceTinybars: async () => MIN_COORDINATOR_TINYBARS,
    ...overrides,
  };
}

function run(overrides: Partial<PreflightDeps> = {}, availability: PoolAvailability = selling) {
  return preflight(deps(overrides), { availability, hederaTxId: TX_ID });
}

describe("settle preflight", () => {
  it("lets a payment through when every recordDeposit precondition holds", async () => {
    assert.deepEqual(await run(), { ok: true });
  });

  it("settles a deposit into a contract that owes exactly what it holds", async () => {
    // The cancellation ADR 0006 turns on. `recordDeposit` reverts on
    // `_totalCommitted + tinybars > balance`, and the balance already includes this payment by
    // then - so the deposit's own amount is on both sides and `C == B` is solvent, however
    // large the incoming payment is.
    const exact = await run({
      contract: {
        committedTinybars: async () => 5_000_000_000n,
        balanceTinybars: async () => 5_000_000_000n,
      },
    });

    assert.deepEqual(exact, { ok: true });
  });

  it("refuses to settle into a contract that cannot cover what it already owes", async () => {
    const result = await run({
      contract: {
        committedTinybars: async () => 1_000_000_001n,
        balanceTinybars: async () => 1_000_000_000n,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "contract-insolvent");
  });

  it("refuses to settle when it could not pay to record the result", async () => {
    // The case a maintainer fixes by funding the wallet. Caught here, it costs a 402; caught
    // after settling, it costs an attribution that has to be replayed by hand.
    const result = await run({
      coordinatorBalanceTinybars: async () => MIN_COORDINATOR_TINYBARS - 1n,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "coordinator-underfunded");
  });

  it("refuses a pool it does not coordinate", async () => {
    // ADR 0003: `recordDeposit` is the pool's own coordinator's to call. Settling first and
    // discovering that afterwards would leave the money in the contract, unattributed, with
    // nobody able to attribute it.
    const result = await run({ coordinatorAddress: "0x00000000000000000000000000000000000000ff" });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-our-pool");
  });

  it("does not care how a coordinator address is cased", async () => {
    const result = await run({ coordinatorAddress: COORDINATOR.toUpperCase().replace("0X", "0x") });

    assert.deepEqual(result, { ok: true });
  });

  it("refuses a pool that is no longer selling, before calling anything", async () => {
    // §7 rule 2, and the reason it is a rule: a closed pool records a late deposit rather than
    // reverting (ADR 0004), so settling would take the payer's money for a seat that does not
    // exist and hand them a refund to claim.
    let contractRead = false;
    const closing: PoolAvailability = {
      available: false,
      terms,
      state: "Open",
      reason: "closing",
    };

    const result = await run(
      {
        contract: {
          committedTinybars: async () => {
            contractRead = true;
            return 0n;
          },
          balanceTinybars: async () => 0n,
        },
      },
      closing,
    );

    assert.ok(!result.ok && result.reason === "pool-not-selling");
    assert.equal(result.cause, "closing");
    assert.equal(contractRead, false, "refused without reading the chain at all");
  });

  it("refuses a settlement that has already been attributed, when an index can say so", async () => {
    const result = await run({ isAlreadyRecorded: async () => true });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "duplicate-transaction");
  });

  it("proceeds when no index is wired in", async () => {
    // The check is optional and soft by design: the contract exposes no getter for it, and
    // Hedera refuses a duplicate transaction id before the contract ever sees it.
    assert.deepEqual(await run({ isAlreadyRecorded: undefined }), { ok: true });
  });
});

describe("failure reporting", () => {
  const failure = {
    poolId: "7",
    payer: "0x00000000000000000000000000000000000003e9",
    payerAccountId: "0.0.1001",
    tinybars: "100000000",
    hederaTxId: TX_ID,
    error: "CONTRACT_REVERT_EXECUTED",
  };

  it("writes one line carrying everything a manual retry needs", async () => {
    const lines: string[] = [];
    new FailureReporter({ write: (line) => lines.push(line) }).attributionFailed(failure);

    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]!) as Record<string, string>;
    assert.equal(logged.event, "attribution-failed");
    assert.equal(logged.hederaTxId, TX_ID);
    assert.equal(logged.payer, failure.payer);
    assert.equal(logged.tinybars, "100000000");
    assert.match(logged.retry!, /^npm run record -- 7 0x[0-9a-f]+ 100000000 /);
  });

  it("never throws, whatever the sink does", async () => {
    // It is called after the money moved, on a path where §7 rule 6 forbids failing the
    // request. A reporter that could throw would destroy the payer's only evidence.
    const reporter = new FailureReporter({
      write: () => {
        throw new Error("stderr is gone");
      },
    });

    assert.doesNotThrow(() => reporter.attributionFailed(failure));
  });
});
