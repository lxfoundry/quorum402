/**
 * A buyer that answers a quorum-gated 402 on its own.
 *
 * The mirror of the coordinator, and deliberately symmetrical with it: where the server
 * unwraps `payload.binding` to hand the facilitator something it can serve
 * (`quorum-scheme.md` §7 rule 3), the buyer derives the binding's *requirement* from the
 * `quorum` entry and builds its payment against that. Only the inner object is binding-
 * specific on either side, which is the structural claim of the scheme expressed twice.
 *
 * Nothing here needs a human. That is the point of x402, and the reason a pool of autonomous
 * buyers is the natural shape for a resource that only exists once enough of them show up.
 */
import { Transaction } from "@hiero-ledger/sdk";
import type { Client, PrivateKey } from "@hiero-ledger/sdk";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  QUORUM_RECEIPT_HEADER,
  decodeHeaderValue,
  encodeHeaderValue,
} from "../x402/http.js";
import { canonicalRedemptionMessage, encodeRedemptionReceipt } from "../x402/redemption.js";
import { buildPartiallySignedTransfer } from "../x402/hedera-exact.js";
import type {
  PaymentRequired,
  PaymentRequirements,
  QuorumPaymentPayload,
  QuorumRequirements,
} from "../x402/types.js";
import { X402_VERSION } from "../x402/types.js";

export interface PaymentResult {
  status: number;
  /** 402 on the first request; the second status is what the payment achieved. */
  offered?: PaymentRequired;
  body: unknown;
  paymentResponse?: unknown;
  /** The transaction id the buyer froze in, so it can be checked against the receipt. */
  transactionId?: string;
}

/**
 * Pull the binding's own requirement out of a `quorum` entry.
 *
 * §3: `amount`, `asset`, `payTo` and `network` sit at the `quorum` level and the binding
 * inherits them; `extra.binding` carries only what the binding itself needs. So this is a
 * lift, not a translation - and if it needed to be a translation the scheme would not be
 * orthogonal to its bindings the way it claims.
 */
export function bindingRequirementOf(entry: QuorumRequirements): PaymentRequirements {
  return {
    scheme: "exact",
    network: entry.network,
    amount: entry.amount,
    asset: entry.asset,
    payTo: entry.payTo,
    maxTimeoutSeconds: entry.maxTimeoutSeconds,
    extra: { feePayer: entry.extra.binding.extra.feePayer },
  };
}

/**
 * The entry a `quorum`-speaking client should pay.
 *
 * §5: a client that does not recognise `paymentFlow: "conditional"` MUST NOT construct a
 * payment for the `quorum` entry and SHOULD skip it. This one does recognise it, so it selects
 * on the flow rather than on the scheme name - the flow is what says the funds may be returned
 * and the resource may never run, and that is the part a buyer is consenting to.
 */
export function selectQuorumEntry(offered: PaymentRequired): QuorumRequirements | undefined {
  return offered.accepts.find(
    (entry): entry is QuorumRequirements =>
      entry.scheme === "quorum" && entry.extra.paymentFlow === "conditional",
  );
}

/**
 * Fetch a quorum-gated resource, paying for a seat if one is on offer.
 *
 * Returns whatever the second request answered: 200 with the resource if this payment filled
 * the pool, 202 with a receipt if it did not, and the refusal otherwise.
 */
export async function buySeat(params: {
  client: Client;
  resourceUrl: string;
  payerId: string;
  payerKey: PrivateKey;
}): Promise<PaymentResult> {
  const challenge = await fetch(params.resourceUrl);
  if (challenge.status !== 402) {
    return { status: challenge.status, body: await challenge.json() };
  }

  const offered = decodeHeaderValue<PaymentRequired>(
    challenge.headers.get(PAYMENT_REQUIRED_HEADER) ?? undefined,
  );
  if (!offered) throw new Error(`402 carried no readable ${PAYMENT_REQUIRED_HEADER} header`);

  const entry = selectQuorumEntry(offered);
  if (!entry) {
    throw new Error(
      `no quorum entry on offer. Schemes: ${offered.accepts.map((a) => a.scheme).join(", ")}`,
    );
  }

  const requirements = bindingRequirementOf(entry);
  const transaction = await buildPartiallySignedTransfer({
    client: params.client,
    payerId: params.payerId,
    payerKey: params.payerKey,
    requirements,
  });

  const payload: QuorumPaymentPayload = {
    x402Version: X402_VERSION,
    resource: offered.resource,
    // The entry echoed back. `filled` is dropped: §3 makes it advisory and stale by
    // construction, and §4 lets a client omit it - sending a number this buyer knows is out of
    // date would only invite the server to compare it.
    accepted: { ...entry, extra: { ...entry.extra, filled: undefined } },
    payload: { poolId: entry.extra.poolId, binding: { transaction } },
  };

  const paid = await fetch(params.resourceUrl, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: encodeHeaderValue(payload) },
  });

  return {
    status: paid.status,
    offered,
    body: await paid.json(),
    paymentResponse: decodeHeaderValue(paid.headers.get(PAYMENT_RESPONSE_HEADER) ?? undefined),
    transactionId: transactionIdOf(transaction),
  };
}

/**
 * The transaction id the buyer froze in, read back out of its own bytes.
 *
 * For reporting only - it is what lets a caller check that the receipt names the settlement
 * this payment actually built, rather than taking the server's word for it.
 */
function transactionIdOf(transactionBase64: string): string | undefined {
  try {
    return Transaction.fromBytes(Buffer.from(transactionBase64, "base64")).transactionId?.toString();
  } catch {
    return undefined;
  }
}

/** What a redemption attempt came back with. */
export interface RedemptionResult {
  status: number;
  body: unknown;
  /** The receipt as presented, so a failed attempt can be re-sent or inspected by hand. */
  presented: string;
}

/**
 * How long a buyer asks its receipt to stay good for.
 *
 * Short deliberately, and shorter than the server's ceiling: inside its window the receipt can
 * be replayed by anyone who sees it (§8), so the buyer has no reason to sign a longer-lived one
 * than the request it is about to make needs.
 */
export const RECEIPT_VALIDITY_SECONDS = 120;

/**
 * Redeem a seat - `quorum-scheme.md` §8, from the payer's side.
 *
 * Everything signed here is a fact the buyer already holds: which pool, which settlement, which
 * resource. Nothing is asked of the coordinator first, and nothing the coordinator says can
 * change what is signed - which is what makes the proof checkable by a third party rather than
 * a conversation between these two.
 */
export async function redeemSeat(params: {
  resourceUrl: string;
  accountId: string;
  key: PrivateKey;
  network: string;
  /** The pool contract's Hedera id, bound in so a signature cannot cross deployments. */
  contractId: string;
  poolId: string;
  /** The settlement the seat descends from - the transaction id the payment returned. */
  transaction: string;
  now?: () => number;
  validitySeconds?: number;
}): Promise<RedemptionResult> {
  const now = Math.floor((params.now?.() ?? Date.now()) / 1000);
  const validUntil = now + (params.validitySeconds ?? RECEIPT_VALIDITY_SECONDS);
  const message = canonicalRedemptionMessage({
    accountId: params.accountId,
    network: params.network,
    contract: params.contractId,
    poolId: params.poolId,
    transaction: params.transaction,
    resource: params.resourceUrl,
    validUntil,
  });
  const presented = encodeRedemptionReceipt({
    accountId: params.accountId,
    poolId: params.poolId,
    transaction: params.transaction,
    validUntil,
    signature: Buffer.from(params.key.sign(message)).toString("base64"),
  });

  const res = await fetch(params.resourceUrl, {
    headers: { [QUORUM_RECEIPT_HEADER]: presented },
  });
  return { status: res.status, body: await res.json(), presented };
}
