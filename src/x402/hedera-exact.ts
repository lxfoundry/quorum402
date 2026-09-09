import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import type { PaymentPayload, PaymentRequirements, ResourceDescriptor } from "./types.js";
import { X402_VERSION } from "./types.js";

export const HBAR_ASSET = "0.0.0";

/**
 * Build the buyer's side of a Hedera `exact` payment.
 *
 * The binding is unusual and worth stating plainly: the buyer does NOT submit anything. They
 * build a TransferTransaction whose *transaction id belongs to the facilitator*, sign it, and
 * hand over a partially signed blob. The facilitator adds the fee-payer signature and submits,
 * sponsoring the gas.
 *
 * The facilitator will reject anything that is not a bare transfer - it MUST NOT be wrapped in
 * a ScheduleCreateTransaction, MUST contain only transfer operations, and every asset's
 * transfers MUST net to zero. That constraint is why the payment cannot itself join a pool;
 * see ADR 0002.
 */
export async function buildPartiallySignedTransfer(params: {
  client: Client;
  payerId: AccountId | string;
  payerKey: PrivateKey;
  requirements: PaymentRequirements;
}): Promise<string> {
  const { client, payerKey, requirements } = params;
  const payerId = AccountId.fromString(params.payerId.toString());
  const payTo = AccountId.fromString(requirements.payTo);
  const feePayer = AccountId.fromString(requirements.extra.feePayer);

  const amount = BigInt(requirements.amount);
  if (amount <= 0n) {
    throw new Error(`Payment amount must be positive, got "${requirements.amount}"`);
  }
  if (requirements.asset !== HBAR_ASSET) {
    // HTS fungible tokens are a supported extension of this binding, but they require the
    // receiver to be associated with the token. Out of scope until the HBAR path is proven.
    throw new Error(
      `Only native HBAR (asset "${HBAR_ASSET}") is implemented; got asset "${requirements.asset}"`,
    );
  }

  const tx = new TransferTransaction()
    // fromTinybars rejects bigint, so route through a decimal string - never a JS number,
    // which loses precision above 2^53 tinybars (~90m HBAR).
    .addHbarTransfer(payerId, Hbar.fromTinybars((-amount).toString()))
    .addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()))
    // The fee payer at the network level is the facilitator, expressed by whose account the
    // transaction id belongs to. The facilitator checks this exact equality before signing.
    .setTransactionId(TransactionId.generate(feePayer))
    .setTransactionValidDuration(clampValidDuration(requirements.maxTimeoutSeconds))
    .freezeWith(client);

  const signed = await tx.sign(payerKey);
  return Buffer.from(signed.toBytes()).toString("base64");
}

/**
 * Hedera accepts a valid duration between 15 and 180 seconds. `maxTimeoutSeconds` comes from
 * the resource server and is not guaranteed to be inside that window, so clamp rather than
 * letting the network reject a transaction for a reason unrelated to the payment.
 */
function clampValidDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return 120;
  return Math.min(180, Math.max(15, Math.floor(seconds)));
}

export function buildPaymentPayload(params: {
  resource: ResourceDescriptor;
  requirements: PaymentRequirements;
  transactionBase64: string;
}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    resource: params.resource,
    accepted: params.requirements,
    payload: { transaction: params.transactionBase64 },
  };
}

/** Sign a payload for transport in the `PAYMENT-SIGNATURE` style header. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
}

export const TINYBARS_PER_HBAR = 100_000_000n;

/** A plain decimal HBAR amount, at most 8 fractional digits. No exponent form. */
const HBAR_DECIMAL = /^\d+(?:\.\d{1,8})?$/;

/**
 * Convert an HBAR amount to tinybars.
 *
 * Takes a string rather than a number deliberately. `Number.prototype.toString()` switches to
 * scientific notation for small magnitudes - `0.00000001` stringifies as `"1e-8"` - and those
 * digits then fail to parse as a BigInt. Working from the caller's original text avoids that
 * and the float drift that afflicts values like 0.1 at the same time.
 */
export function hbarToTinybars(hbar: string): bigint {
  if (!HBAR_DECIMAL.test(hbar)) {
    throw new Error(
      `Amount must be a plain decimal with at most 8 fractional digits (tinybar precision), ` +
        `got "${hbar}". Scientific notation is not accepted.`,
    );
  }
  const [whole = "0", frac = ""] = hbar.split(".");
  return BigInt(whole) * TINYBARS_PER_HBAR + BigInt(frac.padEnd(8, "0"));
}

/**
 * Tinybars as a plain decimal HBAR amount - the inverse of `hbarToTinybars`, and its neighbour
 * so the pair can be read, and tested, as one convention.
 *
 * Exact: the whole and fractional halves are divided out as BigInts and joined as text, so no
 * float goes near a price. Trailing zeros are trimmed, and the sign is carried on the front
 * rather than left to fall out of the arithmetic - `-1n / 100_000_000n` is `0n`, so a negative
 * amount formatted naively loses its sign and reads as a positive fraction.
 *
 * No unit suffix: a log line wants `"1.5 HBAR"` and a UI wants `1.5 ℏ`, and that is the caller's
 * to append.
 */
export function tinybarsToHbar(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const absolute = negative ? -tinybars : tinybars;
  const whole = absolute / TINYBARS_PER_HBAR;
  const fraction = (absolute % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
