/**
 * Redeeming a seat - `quorum-scheme.md` §8.
 *
 * Entitlement is derived from the hold binding's state, never from a session. This server keeps
 * no record of who has redeemed and a restart loses nothing, because every fact the decision
 * rests on is either on chain or in the payer's signature.
 *
 * §8 fixes the order of the checks and this file follows it literally, because the order is what
 * makes the refusals honest. Verifying the signature *before* looking anything up means an
 * unsigned request can never learn whether a pool, a transaction or a seat exists; checking the
 * deposit before the pool state means a payer whose payment took no seat is told that, rather
 * than being told the pool is still filling and left waiting for a seat they will never get.
 *
 * The decisions are separated from the network reads for the same reason as `preflight.ts`: what
 * is worth testing here is the ruling, and a ruling over injected facts can be tested as one.
 */
import { PublicKey } from "@hiero-ledger/sdk";
import type { Deposit, PoolState, PoolTerms } from "../pool/client.js";
import type { AccountKeyType, MirrorAccount } from "../hedera/mirror.js";
import { CLAIM_REFUND } from "./receipt.js";
import { canonicalRedemptionMessage } from "../x402/redemption.js";
import type { RedemptionReceipt } from "../x402/redemption.js";

/**
 * How far ahead a receipt may claim to be valid.
 *
 * §8 rule 1 asks for "implausibly far ahead" to be refused and does not put a number on it. This
 * is the number, and it is short on purpose: within its window a receipt can be replayed by
 * anyone who observes it, so the window *is* the containment. Fifteen minutes is long enough to
 * absorb a badly set clock and short enough that an intercepted receipt is not a lasting key.
 */
export const MAX_VALIDITY_WINDOW_SECONDS = 900;

/**
 * Clock skew tolerated on expiry.
 *
 * Only ever applied in the payer's favour, and only to expiry. A receipt is refused a few
 * seconds late rather than a few seconds early, because the cost of the first is one retry and
 * the cost of the second is a valid seat that will not open.
 */
const EXPIRY_SKEW_SECONDS = 30;

export type RedemptionRefusal =
  /** The header would not decode, or the signature does not verify. §6: 401. */
  | { reason: "invalid-proof"; detail: string }
  /** Valid when signed, not any more. §6: 401. */
  | { reason: "expired-proof"; detail: string }
  /** Signed correctly, but this deposit belongs to another account. 403 - see below. */
  | { reason: "not-your-deposit"; detail: string }
  /** No such payment in this pool, or the index has not caught up. 404 - see below. */
  | { reason: "no-such-deposit"; detail: string; indexedBlock?: bigint }
  /**
   * A read this decision needs could not be made. 503 - see below.
   *
   * `cause` is for the server's log, never for the payer: it is upstream text about how this
   * coordinator is wired, and the payer can do nothing with it.
   */
  | { reason: "index-unavailable"; detail: string; cause: string }
  /** The payment settled but took no seat. §6: 409, with where to reclaim. */
  | { reason: "no-seat"; detail: string; reclaim: Reclaim }
  /** The crowd has not arrived yet. §6: 202, with the current fill. */
  | { reason: "still-filling"; detail: string; filled: number; threshold: number }
  /** The deadline passed without a quorum. §6: 409, with where to reclaim. */
  | { reason: "pool-expired"; detail: string; reclaim: Reclaim };

/** Where a payer goes to get their money back without this server's help. §9. */
export interface Reclaim {
  contract: string;
  method: string;
  poolId: string;
}

export type RedemptionResult =
  /** The address the seat belongs to. The pool's fill is the caller's `terms`, not repeated here. */
  | { ok: true; payer: string }
  | ({ ok: false } & RedemptionRefusal);

export interface RedeemDeps {
  network: string;
  /** The pool contract's Hedera id. Bound into the signature, so it cannot cross deployments. */
  contractId: string;
  /** §8 step 2. Both facts, from one record. */
  accountOf: (accountId: string) => Promise<MirrorAccount>;
  /**
   * §8 step 4, first half: the id resolves to a position through the binding's logs.
   *
   * Answers with how far the index has read as well, because the refusal that needs that is
   * the one where there is no position - and asking separately would charge the most retried
   * answer on this path two round trips instead of one.
   */
  depositFor: (
    poolId: string,
    hederaTxId: string,
  ) => Promise<{ depositId?: bigint; indexedBlock?: bigint }>;
  /** §8 step 4, second half: payer and `counted` come back from consensus state. */
  depositAt: (poolId: bigint, depositId: bigint) => Promise<Deposit>;
  now?: () => number;
}

/**
 * May this receipt open this resource?
 *
 * Takes the pool's terms and live state rather than reading them, so that "what is this pool
 * doing" keeps one implementation, exactly as `preflight` takes availability rather than
 * re-deriving it.
 */
export async function redeem(
  deps: RedeemDeps,
  params: { receipt: RedemptionReceipt; resourceUrl: string; terms: PoolTerms; state: PoolState },
): Promise<RedemptionResult> {
  const { receipt, resourceUrl, terms, state } = params;
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);

  // §8 rule 1, first and cheapest. Repeated here rather than trusted from the caller: `redeem`
  // is the unit that answers §8, and a caller that forgot would fail open.
  const stale = expiredProof(receipt, now);
  if (stale) return { ok: false, ...stale };

  // The pool named in the receipt must be the pool this URL is selling. Checked here rather than
  // trusted from the signature: the signature proves the payer meant this pool, not that this
  // pool is the one being asked for.
  if (receipt.poolId !== terms.poolId.toString()) {
    return {
      ok: false,
      reason: "invalid-proof",
      detail: `receipt names pool ${receipt.poolId}, ${resourceUrl} is sold by pool ${terms.poolId}`,
    };
  }

  // §8 steps 2 and 3.
  let account: MirrorAccount;
  try {
    account = await deps.accountOf(receipt.accountId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid-proof", detail };
  }

  const message = canonicalRedemptionMessage({
    accountId: receipt.accountId,
    network: deps.network,
    contract: deps.contractId,
    poolId: receipt.poolId,
    transaction: receipt.transaction,
    resource: resourceUrl,
    validUntil: receipt.validUntil,
  });
  if (!verifySignature(account.key, message, receipt.signature)) {
    // Deliberately says nothing about which part failed. The signature covers the resource and
    // the contract as well as the pool, and naming the mismatch would turn this into an oracle
    // for what this server is selling.
    return { ok: false, reason: "invalid-proof", detail: "signature does not verify" };
  }

  // §8 step 4. The index resolves the id to a position; the contract answers for the row.
  //
  // Both reads cross the network and both can fail for reasons that say nothing about this
  // receipt: the index unreachable, past its timeout, or disagreeing with consensus. None of
  // those is a bad proof or a missing deposit, so they get their own answer rather than
  // borrowing 401 or 404 - and in particular the payer must not be told their seat does not
  // exist because the index is down.
  let found: { depositId?: bigint; indexedBlock?: bigint };
  try {
    found = await deps.depositFor(receipt.poolId, receipt.transaction);
  } catch (error) {
    return unavailable("the index could not be reached", error);
  }
  const { depositId, indexedBlock } = found;
  if (depositId === undefined) {
    return {
      ok: false,
      reason: "no-such-deposit",
      // Both causes, because they are genuinely indistinguishable from here and a payer who has
      // just paid must not be told their payment does not exist.
      detail: `no deposit for ${receipt.transaction} in pool ${receipt.poolId} - either it never settled, or it is not indexed yet`,
      indexedBlock,
    };
  }

  let deposit: Deposit;
  try {
    deposit = await deps.depositAt(terms.poolId, depositId);
  } catch (error) {
    // Covers the index naming a row the contract does not have, which is the index disagreeing
    // with consensus - still not an answer about this payer, and still not theirs to fix.
    return unavailable("the deposit could not be read back from the contract", error);
  }
  if (deposit.payer.toLowerCase() !== account.evmAddress.toLowerCase()) {
    return {
      ok: false,
      reason: "not-your-deposit",
      detail: `deposit ${depositId} was recorded against ${deposit.payer}, ${receipt.accountId} is ${account.evmAddress}`,
    };
  }

  const reclaim: Reclaim = {
    contract: deps.contractId,
    method: CLAIM_REFUND,
    poolId: receipt.poolId,
  };

  if (!deposit.counted) {
    // §6: 409. A late payment is refundable at once and will never become a seat, so telling
    // this payer to wait would be telling them to wait forever.
    return {
      ok: false,
      reason: "no-seat",
      detail: `deposit ${depositId} settled but took no seat, and is refundable now`,
      reclaim,
    };
  }

  // §8 step 5. `Met` **or** `Released`: a pool that has already paid the seller out still
  // entitles every counted payer, and testing for `Met` alone would withhold the resource the
  // moment the payout landed - the coupling §6 forbids.
  if (state === "Met" || state === "Released") {
    return { ok: true, payer: deposit.payer };
  }
  if (state === "Expired") {
    return {
      ok: false,
      reason: "pool-expired",
      detail: `pool ${receipt.poolId} expired without reaching ${terms.threshold} seats`,
      reclaim,
    };
  }
  return {
    ok: false,
    reason: "still-filling",
    detail: `pool ${receipt.poolId} holds ${terms.seats} of ${terms.threshold} seats`,
    filled: terms.seats,
    threshold: terms.threshold,
  };
}

/** A read failed, and the failure is this server's rather than the payer's. */
function unavailable(detail: string, error: unknown): RedemptionResult {
  return { ok: false, ...unreadable(detail, error) };
}

/**
 * A read this decision needed could not be made.
 *
 * Exported because the caller has reads of its own - which pool sells this URL, and what it is
 * doing - that fail the same way and owe the payer the same answer. One constructor, so a
 * failure before `redeem` is reached and one inside it cannot be reported differently.
 */
export function unreadable(detail: string, error: unknown): RedemptionRefusal {
  return {
    reason: "index-unavailable",
    detail,
    cause: error instanceof Error ? error.message : String(error),
  };
}

/**
 * §8 rule 1: is this receipt in date? The only check on the path that touches no network.
 *
 * Exported so a caller can run it before paying for a single read. §8 puts expiry first, and
 * that ordering buys nothing if the pool has already been fetched from the chain by the time
 * the clock is consulted - which is the difference between a stale receipt costing three
 * contract queries and costing none.
 */
export function expiredProof(
  receipt: { validUntil: number },
  now: number = Math.floor(Date.now() / 1000),
): RedemptionRefusal | undefined {
  if (receipt.validUntil + EXPIRY_SKEW_SECONDS < now) {
    return {
      reason: "expired-proof",
      detail: `receipt expired at ${receipt.validUntil}, now ${now}`,
    };
  }
  if (receipt.validUntil > now + MAX_VALIDITY_WINDOW_SECONDS) {
    return {
      reason: "expired-proof",
      detail: `receipt is valid until ${receipt.validUntil}, more than ${MAX_VALIDITY_WINDOW_SECONDS}s ahead of ${now}`,
    };
  }
  return undefined;
}

/**
 * The HTTP status each outcome maps to - `quorum-scheme.md` §6's last five rows, plus three.
 *
 * §6's table answers 401 for any proof that does not stand up, which is right for a signature
 * that does not verify and wrong for the three cases below, so each is stated separately rather
 * than folded into 401:
 *
 *   - **403** for a signature that verifies against an account the deposit does not belong to.
 *     401 invites a client to present a better credential; there is no better credential, and
 *     a payer who re-signs learns nothing. The proof was good and the claim was not theirs
 *   - **404** for a transaction this pool has no deposit for. It is not a bad proof either, and
 *     the ordinary cause is an index a second behind the payment that just settled
 *   - **503** when a read the decision needs could not be made at all. The receipt may well be
 *     good; this server cannot currently tell, and saying 404 would report a seat as missing
 *     because an index is down
 */
export function statusFor(refusal: RedemptionRefusal): number {
  switch (refusal.reason) {
    case "invalid-proof":
    case "expired-proof":
      return 401;
    case "not-your-deposit":
      return 403;
    case "no-such-deposit":
      return 404;
    case "index-unavailable":
      return 503;
    case "no-seat":
    case "pool-expired":
      return 409;
    case "still-filling":
      return 202;
  }
}

/**
 * Verify raw signature bytes against an account's key, whatever its type.
 *
 * §8 says "whatever its type" for a reason: Hedera accounts carry ED25519 or ECDSA keys and a
 * payer does not choose which the scheme supports. Both verify 64 raw bytes here.
 *
 * Never throws. A malformed key or signature is a refusal, not a 500 - the input is attacker-
 * controlled, and every way it can be wrong has the same answer.
 */
function verifySignature(
  key: { type: AccountKeyType; hex: string },
  message: Buffer,
  signature: string,
): boolean {
  try {
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length === 0) return false;
    const publicKey =
      key.type === "ED25519" ? PublicKey.fromStringED25519(key.hex) : PublicKey.fromStringECDSA(key.hex);
    return publicKey.verify(message, bytes);
  } catch {
    return false;
  }
}
