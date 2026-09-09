/**
 * The x402 HTTP transport: header names, and the encoding all of them share.
 *
 * Read from `x402-foundation/x402` at `specs/transports-v2/http.md` on 2026-09-08. Two things
 * from it govern this file:
 *
 *   - the three headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`,
 *     and every one of them is **base64-encoded JSON**
 *   - *"Response bodies are a server implementation concern. All x402 protocol information is
 *     communicated through headers"* - so the `PaymentRequired` goes in the header and is not
 *     duplicated into the body, and the receipt (`quorum-scheme.md` §6.1) is a body precisely
 *     because it is not protocol information
 */
import type { PaymentRequired } from "./types.js";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * `quorum`'s own header, for redeeming a seat after the threshold is met (§8).
 *
 * Not an x402 header. Redemption is not a payment handshake - no funds move and no facilitator
 * is involved - so it is ordinary HTTP carrying a proof, and it is named outside the
 * `PAYMENT-` space to say so.
 */
export const QUORUM_RECEIPT_HEADER = "QUORUM-RECEIPT";

export function encodeHeaderValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/**
 * Decode a base64 JSON header.
 *
 * Returns `undefined` rather than throwing on anything malformed, because every caller is a
 * request handler that answers 400 for a header it cannot read, and an exception would have to
 * be caught and converted at each one.
 */
export function decodeHeaderValue<T>(header: string | undefined): T | undefined {
  if (!header) return undefined;
  try {
    const json = Buffer.from(header, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    // `JSON.parse` accepts bare scalars, and every header this decodes carries an object.
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

export function encodePaymentRequired(paymentRequired: PaymentRequired): string {
  return encodeHeaderValue(paymentRequired);
}
