/**
 * The envelope around a presented payment: checking it, and unwrapping it.
 *
 * Two rules from `quorum-scheme.md` §7 live here, and they bracket the money without touching
 * it. Rule 1 matches the payload to an entry the server actually advertised, before any
 * facilitator call. Rule 3 unwraps the hold binding's payload and builds the binding-level
 * request the facilitator can serve - because a facilitator serves `exact`, not `quorum`, and
 * rejects an envelope naming a scheme it does not implement.
 */
import { decodeHeaderValue } from "../x402/http.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  QuorumPaymentPayload,
  QuorumRequirements,
  ResourceDescriptor,
} from "../x402/types.js";
import { X402_VERSION } from "../x402/types.js";

export type PayloadRejection =
  /** Header missing, not base64 JSON, or not shaped like a payload at all. */
  | "unreadable"
  | "wrong-version"
  | "wrong-scheme"
  /** §4: `payload.poolId` disagrees with the echo's `accepted.extra.poolId`. */
  | "pool-mismatch"
  /** The echo names a pool this resource is not selling. */
  | "wrong-pool"
  /** The echo's terms are not the ones advertised. */
  | "terms-mismatch"
  /** No hold-binding payload to hand the facilitator. */
  | "no-binding-payload";

export type PayloadValidation =
  | { ok: true; payload: QuorumPaymentPayload }
  | { ok: false; reason: PayloadRejection; detail: string };

function reject(reason: PayloadRejection, detail: string): PayloadValidation {
  return { ok: false, reason, detail };
}

/**
 * Fields the client's echo must reproduce, and the ones it must not be trusted on.
 *
 * `filled` is absent deliberately. §3 makes it advisory and stale by construction, and §4
 * requires a server to ignore it in the echo - a client's copy of a number that was already
 * out of date when it was written says nothing at all. Comparing it would reject honest
 * payments for the crime of having been signed a moment after somebody else's.
 */
const COMPARED = [
  "scheme",
  "network",
  "amount",
  "asset",
  "payTo",
  "maxTimeoutSeconds",
] as const satisfies readonly (keyof QuorumRequirements)[];

/**
 * Check a presented payment against what this server is advertising right now.
 *
 * **The echo is the client's statement, not evidence** (§4). Nothing here reads terms *out* of
 * the payload to act on: the amount that gets settled, the pool that gets credited and the
 * requirement handed to the facilitator all come from `advertised`. The echo is compared and
 * then discarded, which is the only safe thing to do with a number an unauthenticated caller
 * chose.
 */
export function validateQuorumPayload(params: {
  header: string | undefined;
  advertised: QuorumRequirements;
}): PayloadValidation {
  const payload = decodeHeaderValue<QuorumPaymentPayload>(params.header);
  if (!payload) return reject("unreadable", "PAYMENT-SIGNATURE is missing or is not base64 JSON");
  if (payload.x402Version !== X402_VERSION) {
    return reject("wrong-version", `x402Version ${String(payload.x402Version)} is not ${X402_VERSION}`);
  }

  const { accepted } = payload;
  if (!accepted || typeof accepted !== "object") return reject("unreadable", "no accepted entry");
  if (accepted.scheme !== "quorum") {
    return reject("wrong-scheme", `accepted.scheme is ${String(accepted.scheme)}, not "quorum"`);
  }

  const binding = payload.payload;
  if (!binding || typeof binding !== "object") return reject("unreadable", "no payload object");
  if (typeof binding.binding?.transaction !== "string" || !binding.binding.transaction) {
    return reject("no-binding-payload", "payload.binding.transaction is missing or not a string");
  }

  // §4, stated as a MUST because the two ids travel separately and a server that reads one and
  // credits the other would attribute a payment to a pool the payer never chose.
  if (binding.poolId !== accepted.extra?.poolId) {
    return reject(
      "pool-mismatch",
      `payload.poolId ${binding.poolId} disagrees with accepted.extra.poolId ${String(accepted.extra?.poolId)}`,
    );
  }
  if (binding.poolId !== params.advertised.extra.poolId) {
    return reject(
      "wrong-pool",
      `this resource is selling pool ${params.advertised.extra.poolId}, not ${binding.poolId}`,
    );
  }

  for (const field of COMPARED) {
    if (accepted[field] !== params.advertised[field]) {
      return reject(
        "terms-mismatch",
        `accepted.${field} is ${String(accepted[field])}, advertised ${String(params.advertised[field])}`,
      );
    }
  }
  for (const field of ["threshold", "deadline", "paymentFlow"] as const) {
    if (accepted.extra[field] !== params.advertised.extra[field]) {
      return reject(
        "terms-mismatch",
        `accepted.extra.${field} is ${String(accepted.extra[field])}, advertised ${String(params.advertised.extra[field])}`,
      );
    }
  }
  // The fee payer comes from the facilitator's `/supported` and can change under us. When it
  // does, the buyer's transaction is already frozen against the old one and could not settle
  // anyway - so this refuses early rather than spending the irreversible call to find out.
  if (accepted.extra.binding?.extra?.feePayer !== params.advertised.extra.binding.extra.feePayer) {
    return reject(
      "terms-mismatch",
      `accepted fee payer ${String(accepted.extra.binding?.extra?.feePayer)} is not the advertised ` +
        `${params.advertised.extra.binding.extra.feePayer}; the 402 this was built from is stale`,
    );
  }

  return { ok: true, payload };
}

/**
 * Build the binding-level request the facilitator is given - §7 rule 3.
 *
 * `payload.binding` is passed **by reference and unchanged**. The binding payload is signed
 * data; re-serialising it would be enough to invalidate it, so nothing here rewrites, re-signs
 * or re-encodes it. Only the envelope around it is built, and `accepted` is the binding's own
 * requirement rather than the `quorum` one.
 */
export function bindingRequestFor(params: {
  payload: QuorumPaymentPayload;
  resource: ResourceDescriptor;
  binding: PaymentRequirements;
}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    resource: params.resource,
    accepted: params.binding,
    payload: params.payload.payload.binding,
  };
}
