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
 * When settlement happens relative to the resource running. §6.1 of the specification defines
 * the first three; `conditional` is proposed by `specs/quorum-scheme.md` §2.
 */
export type PaymentFlow = "authorization" | "upfront" | "escrow" | "conditional";

/**
 * What the resource server demands. On Hedera, `extra.feePayer` is required: it names the
 * account that pays network fees, which is the facilitator, and whose signature completes
 * the partially signed transaction.
 *
 * This is the **binding-level** shape, and deliberately the only one the facilitator ever
 * sees - a facilitator serves `exact`, not `quorum` (`quorum-scheme.md` §7 rule 3). The
 * `quorum` requirement that wraps it is `QuorumRequirements` below.
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
  /**
   * `paymentFlow` is optional here because a bare `exact` payment that is not fronting a
   * quorum pool has nothing to declare - the Hedera binding defines no default, and the
   * specification requires the field only once the resolved flow is not `authorization`.
   * A server offering this entry as a quorum fallback MUST set it: `quorum-scheme.md` §5.
   */
  extra: { feePayer: string; paymentFlow?: PaymentFlow };
}

/**
 * How one payer's funds are held between commitment and outcome. `quorum` names three
 * bindings and builds one (`quorum-scheme.md` §10); this is the built one.
 */
export interface HoldBinding {
  scheme: "exact";
  extra: { feePayer: string };
}

/**
 * `PaymentRequirements` for the `quorum` scheme - `quorum-scheme.md` §3.
 *
 * `amount`, `asset`, `payTo` and `network` describe the payment itself and sit at this level
 * rather than inside `extra.binding`; the binding inherits them.
 */
export interface QuorumRequirements {
  scheme: "quorum";
  network: Network;
  /** **One seat**, not the pool total. What this payer pays. */
  amount: string;
  asset: string;
  /** Where the hold lives. Under the `exact` binding, the pool contract's own account. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    paymentFlow: "conditional";
    /** A `uint256` on-chain, so a string - it is not safely a JSON number. */
    poolId: string;
    threshold: number;
    /**
     * Seats counted when this response was written. **Advisory, and stale by construction**
     * (§3). A client MAY omit it when echoing the entry back, so it is optional here.
     */
    filled?: number;
    /** Unix seconds. */
    deadline: number;
    binding: HoldBinding;
  };
}

/** One entry of `PaymentRequired.accepts`. */
export type AcceptsEntry = QuorumRequirements | PaymentRequirements;

/**
 * The `PAYMENT-REQUIRED` header's payload - what a 402 offers.
 *
 * `error` and `resource.description` carry the human-readable half, because
 * `PaymentRequirements` has no field for it and a legacy client selecting the `exact`
 * fallback has nowhere else to learn that the resource may never run (§5).
 */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error: string;
  resource: ResourceDescriptor;
  accepts: AcceptsEntry[];
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

/**
 * The `quorum` payload - `quorum-scheme.md` §4.
 *
 * `binding` is **the hold binding's own payload, verbatim**. A resource server unwraps it and
 * hands it to the facilitator unchanged; nothing in the `quorum` layer rewrites, re-signs or
 * re-encodes it. That is the structural claim of the scheme expressed in the format: swap the
 * binding, and only this inner object changes.
 */
export interface QuorumPayloadBody {
  poolId: string;
  binding: HederaExactPayload;
}

export interface QuorumPaymentPayload {
  x402Version: typeof X402_VERSION;
  resource: ResourceDescriptor;
  /**
   * The client's echo of the entry it chose. **A statement, not evidence** - a server MUST
   * validate it against what it actually advertised, and MUST ignore `extra.filled` (§4).
   */
  accepted: QuorumRequirements;
  payload: QuorumPayloadBody;
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

/**
 * A Hedera transaction id: `<shard>.<realm>.<num>@<seconds>.<nanos>` as the SDK renders it,
 * or the same with `-` separators as the mirror node does.
 */
const HEDERA_TX_ID = /^\d+\.\d+\.\d+[@-]\d+[.-]\d+$/;

/**
 * Pull the on-chain transaction id out of a settlement response, whatever it called it.
 *
 * Every candidate is format-checked rather than returned on presence alone. A facilitator may
 * put an EVM-style hex hash in one of these fields, and handing that back as a transaction id
 * yields a dead mirror-node lookup and a broken HashScan link - a silent failure that looks
 * like a successful settlement. Returning `undefined` is the honest answer; the caller then
 * reports the raw body instead of a link that goes nowhere.
 */
export function settlementTxId(res: SettlementResponse): string | undefined {
  for (const key of ["transactionId", "transaction", "txHash"] as const) {
    const value = res[key];
    if (typeof value === "string" && HEDERA_TX_ID.test(value)) return value;
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
