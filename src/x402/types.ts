/**
 * Wire types for x402 v2, narrowed to the `exact` scheme on Hedera.
 *
 * Field names and shapes follow the x402 v2 specification and its Hedera binding
 * (`specs/schemes/exact/scheme_exact_hedera.md` upstream). They are deliberately not
 * abbreviated or renamed - this is a wire format, and divergence here is silent breakage.
 */

export const X402_VERSION = 2 as const;

/** CAIP-2 network id. Hedera testnet is `hedera:testnet`. */
export type Network = `hedera:${"testnet" | "mainnet"}` | (string & {});

/**
 * What the resource server demands. On Hedera, `extra.feePayer` is required: it names the
 * account that pays network fees, which is the facilitator, and whose signature completes
 * the partially signed transaction.
 */
export interface PaymentRequirements {
  scheme: "exact";
  network: Network;
  /**
   * Smallest unit of `asset`. For HBAR (`asset` `"0.0.0"`) this is TINYBARS,
   * where 1 HBAR = 100_000_000 tinybars.
   */
  amount: string;
  /** Hedera entity id of the HTS token, or `"0.0.0"` for native HBAR. */
  asset: string;
  /** Hedera account id receiving the funds. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string };
}

export interface ResourceDescriptor {
  url: string;
  description: string;
  mimeType: string;
}

/** The Hedera `exact` payload: one base64 partially signed transaction, nothing else. */
export interface HederaExactPayload {
  transaction: string;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource: ResourceDescriptor;
  accepted: PaymentRequirements;
  payload: HederaExactPayload;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string | null;
  payer?: string;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string | null;
  /**
   * Hedera transaction id, e.g. `0.0.1235@1700000000.000000000`.
   *
   * Facilitators are inconsistent about this field's name - the Hedera binding document shows
   * `transactionId`, while the generic v2 settlement response uses `transaction`. Read it
   * through `settlementTxId()` rather than off one property.
   */
  transactionId?: string;
  transaction?: string;
  txHash?: string;
  network?: Network;
  /** The fee payer that sponsored the transaction. */
  payer?: string;
  [key: string]: unknown;
}

/** Pull the on-chain transaction id out of a settlement response, whatever it called it. */
export function settlementTxId(res: SettlementResponse): string | undefined {
  for (const key of ["transactionId", "transaction", "txHash"] as const) {
    const value = res[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: { feePayer?: string };
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: unknown[];
  signers?: Record<string, string[]>;
}
