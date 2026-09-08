/**
 * What a quorum-gated resource offers, and what the facilitator is handed for it.
 *
 * Both come out of one pool's terms, and - the point of this file - the second is a function
 * of the first rather than a parallel construction. `quorum-scheme.md` §5's fallback entry and
 * §7 rule 3's binding-level requirement are the *same object*: the payment a legacy client
 * makes against the fallback and the payment the coordinator asks the facilitator to settle
 * are the same payment, described under the binding's own scheme. `bindingRequirements` builds
 * it once and both callers use it.
 */
import type { PoolTerms } from "../pool/client.js";
import { HBAR_ASSET } from "../x402/hedera-exact.js";
import type {
  Network,
  PaymentRequired,
  PaymentRequirements,
  QuorumRequirements,
  ResourceDescriptor,
} from "../x402/types.js";
import { X402_VERSION } from "../x402/types.js";

/**
 * How long a payer has to build, sign and return a payment.
 *
 * Also clamped to Hedera's 15-180 second valid-duration window when the transfer is built
 * (`hedera-exact.ts`), so a value outside it would be silently narrowed rather than honoured.
 */
export const MAX_TIMEOUT_SECONDS = 120;

export interface OfferParams {
  terms: PoolTerms;
  network: Network;
  /** The pool contract's Hedera account id. Where the hold lives. */
  payTo: string;
  /** Resolved from the facilitator's `/supported`. Never hardcoded. */
  feePayer: string;
}

/**
 * The binding-level requirement: `exact` on Hedera, for one seat.
 *
 * This is what goes to `/verify` and `/settle` (§7 rule 3 - a facilitator serves the binding's
 * scheme, not `quorum`, and rejects an envelope naming one it does not implement), and it is
 * also §5's fallback `accepts[]` entry verbatim.
 *
 * `paymentFlow` is `upfront` because that is what is true of this payment on its own: the
 * funds commit before the resource runs. It cannot express that the resource may never run at
 * all - `PaymentRequirements` has no field for that - which is the residual silence §5 names
 * and carries at the response level instead.
 */
export function bindingRequirements(params: OfferParams): PaymentRequirements {
  return {
    scheme: "exact",
    network: params.network,
    amount: params.terms.unitTinybars.toString(),
    asset: HBAR_ASSET,
    payTo: params.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { paymentFlow: "upfront", feePayer: params.feePayer },
  };
}

/** The `quorum` entry - §3. */
export function quorumRequirements(params: OfferParams): QuorumRequirements {
  const binding = bindingRequirements(params);
  return {
    scheme: "quorum",
    network: binding.network,
    amount: binding.amount,
    asset: binding.asset,
    payTo: binding.payTo,
    maxTimeoutSeconds: binding.maxTimeoutSeconds,
    extra: {
      paymentFlow: "conditional",
      poolId: params.terms.poolId.toString(),
      threshold: params.terms.threshold,
      filled: params.terms.seats,
      deadline: params.terms.deadline,
      binding: { scheme: "exact", extra: { feePayer: params.feePayer } },
    },
  };
}

/**
 * The whole 402 offer: the `quorum` entry, then the `exact` fallback.
 *
 * Order matters to a client picking the first entry it understands, so the scheme that
 * describes what is actually happening comes first and the lossy one is the fallback.
 */
export function paymentRequired(params: OfferParams): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: paymentRequiredError(params.terms),
    resource: resourceDescriptor(params.terms),
    accepts: [quorumRequirements(params), bindingRequirements(params)],
  };
}

/**
 * The warning a legacy client cannot read off a protocol field.
 *
 * §5: a client selecting the `exact` fallback learns from `paymentFlow: "upfront"` that its
 * funds commit before the resource runs, and does not learn that the resource may never run.
 * `PaymentRequirements` has nowhere to say so, so it is said here and in the resource
 * description, both of which belong to the whole `PaymentRequired` rather than to one entry.
 */
function paymentRequiredError(terms: PoolTerms): string {
  return (
    `This resource is sold to a group. Payment is held and the resource unlocks only if ` +
    `${terms.threshold} distinct payers pay before the deadline; if they do not, every payer ` +
    `is refunded and the resource is never served. Paying does not by itself buy access.`
  );
}

function resourceDescriptor(terms: PoolTerms): ResourceDescriptor {
  return {
    url: terms.resourceUrl,
    description:
      `Pool ${terms.poolId}: ${terms.seats} of ${terms.threshold} seats taken. ` +
      `All-or-nothing - refunded in full if the threshold is not reached by the deadline.`,
    mimeType: "application/json",
  };
}
