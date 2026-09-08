/**
 * Settling a payment, and attributing it.
 *
 * The irreversible half. Everything that could have refused this payment has already run
 * (`preflight.ts`), so from here `quorum-scheme.md` §7 rule 6 applies without exception: once
 * `/settle` reports success the request **does not fail**, whatever else goes wrong. The worst
 * outcome available is a 202 saying the money moved and the attribution has not landed yet.
 */
import type { PoolsClient } from "../pool/client.js";
import type { Facilitator } from "../x402/facilitator.js";
import type { PaymentPayload, PaymentRequirements } from "../x402/types.js";
import { settlementTxId } from "../x402/types.js";
import type { FailureReporter } from "./failures.js";

/**
 * `settlement_pending` is **not** a failure.
 *
 * The specification makes it a non-terminal `SettleResponse.errorReason` and requires it to
 * carry a non-empty `transaction`, so the payment is on its way and the payer has a hash to
 * reconcile against the chain. §7 rule 6 says to treat it exactly like a success whose
 * attribution has not landed: a 202 with the transaction id, never a refusal.
 */
const SETTLEMENT_PENDING = "settlement_pending";

/** How many times to re-attempt `recordDeposit`, and how long to wait between attempts. */
export const RECORD_ATTEMPTS = 4;
export const RECORD_RETRY_MS = 1_500;

export type SettlementOutcome =
  /** Nothing moved. The payer still has their money and gets a 402. */
  | { settled: false; reason: string }
  /** The money moved and the payment is attributed. */
  | {
      settled: true;
      attributed: true;
      hederaTxId: string;
      /**
       * What the recording call returned.
       *
       * **Absent when the attribution was recovered from the contract's replay guard** rather
       * than observed: that path knows the deposit exists and cannot say which one it is or
       * whether it took a seat. `hederaTxId` is not contract state - it is emitted, not stored
       * (ADR 0004) - so there is no view that resolves it back, and the honest answer is to
       * say nothing rather than guess `counted`. A caller reports it as unknown and the payer
       * resolves it at redemption, where entitlement is derived from chain state anyway (§8).
       */
      deposit?: { depositId: bigint; counted: boolean };
    }
  /** The money moved and the attribution did not land. Never a 500 - §7 rule 6. */
  | { settled: true; attributed: false; hederaTxId: string; error: string };

export interface RecordDeps {
  facilitator: Pick<Facilitator, "verify" | "settle">;
  pools: Pick<PoolsClient, "recordDeposit" | "revertReasonOf">;
  failures: FailureReporter;
  /** Injectable so a test does not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  retryMs?: number;
}

export interface SettleAndRecordParams {
  request: PaymentPayload;
  requirements: PaymentRequirements;
  poolId: bigint;
  /** The payer's EVM address, derived from the transfer - §7 rule 5, never from the response. */
  payer: string;
  payerAccountId: string;
  tinybars: bigint;
  /**
   * The transaction id frozen into the buyer's transfer.
   *
   * Authoritative. The facilitator adds a signature to those exact bytes and submits them, so
   * the id on chain is this one - the settlement response is a cross-check against it, not the
   * source of it.
   */
  expectedTxId: string;
}

/**
 * Verify, settle, and record - in that order, and the order is the point.
 *
 * §2: `/verify` is part of this flow, unlike `upfront`. Before `/settle`, refusing a payer
 * costs them nothing; after it, the money has moved and cannot be un-moved by refusing. A flow
 * that promises reversal should spend its cheap refusal before its expensive one.
 */
export async function settleAndRecord(
  deps: RecordDeps,
  params: SettleAndRecordParams,
): Promise<SettlementOutcome> {
  const verification = await deps.facilitator.verify(params.request, params.requirements);
  if (!verification.isValid) {
    return { settled: false, reason: verification.invalidReason || "facilitator declined to verify" };
  }

  const settlement = await deps.facilitator.settle(params.request, params.requirements);
  const pending = settlement.errorReason === SETTLEMENT_PENDING;
  if (!settlement.success && !pending) {
    return { settled: false, reason: settlement.errorReason || "facilitator declined to settle" };
  }

  // Past this line the money has moved. Nothing below may return `settled: false`.
  const reported = settlementTxId(settlement);
  if (reported && reported !== params.expectedTxId) {
    // Should be impossible: the facilitator signs and submits the payer's own bytes, so the
    // id on chain is the one frozen into them. Recorded rather than acted on - the frozen id
    // is still what the payer can find their transaction under, and swapping to a contested
    // one would attribute the deposit to something nobody validated.
    deps.failures.attributionFailed({
      poolId: params.poolId.toString(),
      payer: params.payer,
      payerAccountId: params.payerAccountId,
      tinybars: params.tinybars.toString(),
      hederaTxId: params.expectedTxId,
      error: `facilitator reported transaction ${reported}, expected ${params.expectedTxId}`,
    });
  }

  return recordWithRetry(deps, params);
}

async function recordWithRetry(
  deps: RecordDeps,
  params: SettleAndRecordParams,
): Promise<SettlementOutcome> {
  const attempts = deps.attempts ?? RECORD_ATTEMPTS;
  const retryMs = deps.retryMs ?? RECORD_RETRY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const hederaTxId = params.expectedTxId;
  let lastError = "recordDeposit was never attempted";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const deposit = await deps.pools.recordDeposit({
        poolId: params.poolId,
        payer: params.payer,
        tinybars: params.tinybars,
        hederaTxId,
      });
      return {
        settled: true,
        attributed: true,
        hederaTxId,
        deposit: { depositId: deposit.depositId, counted: deposit.counted },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const reason = await revertReason(deps, error);

      // The previous attempt landed and its response was lost. This is a success, and calling
      // it a failure would put a phantom in the log that a maintainer would replay forever -
      // the contract would refuse every one of those replays for the same reason.
      if (reason === "DuplicateTransaction") {
        return { settled: true, attributed: true, hederaTxId };
      }

      // After a clean pre-flight the contract was solvent a moment ago (ADR 0006), so a
      // shortfall now can only be this payment not yet being visible to the node being asked.
      // Anything else transient is retried too; there is nothing better to do with it.
      if (attempt < attempts) await sleep(retryMs);
    }
  }

  deps.failures.attributionFailed({
    poolId: params.poolId.toString(),
    payer: params.payer,
    payerAccountId: params.payerAccountId,
    tinybars: params.tinybars.toString(),
    hederaTxId,
    error: lastError,
  });
  return { settled: true, attributed: false, hederaTxId, error: lastError };
}

/**
 * Which custom error a revert raised, if the failure was a revert and the reason can be read.
 *
 * The transaction id comes off the SDK's `ReceiptStatusError`, which carries the id of the
 * transaction whose receipt failed.
 */
async function revertReason(deps: RecordDeps, error: unknown): Promise<string | undefined> {
  const transactionId = (error as { transactionId?: { toString(): string } } | null)?.transactionId;
  if (!transactionId) return undefined;
  return deps.pools.revertReasonOf(transactionId.toString());
}
