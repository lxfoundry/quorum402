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

export function hbarToTinybars(hbar: number): bigint {
  // Route through a string to avoid float drift on values like 0.1.
  const [whole = "0", frac = ""] = hbar.toString().split(".");
  const padded = (frac + "00000000").slice(0, 8);
  return BigInt(whole) * TINYBARS_PER_HBAR + BigInt(padded || "0");
}
