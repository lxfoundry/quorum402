/**
 * `QUORUM-RECEIPT`: the proof a payer presents to redeem a seat - `quorum-scheme.md` §8.
 *
 * Not an x402 payment. No funds move and no facilitator is involved; what the payer presents is
 * a signature over facts already on chain, and the server's job is to check that the signer is
 * the account a counted deposit was recorded against.
 *
 * This module is the half both sides share. A buyer builds and signs the message here, a server
 * reproduces and verifies it here, and neither has its own copy of the layout - which matters
 * more than usual, because the message is signed as **exact bytes**. Two implementations that
 * agree on the fields and disagree on the separators produce signatures that never verify, and
 * the failure says only "bad signature".
 */

/** The claim a payer presents, base64-encoded into the header. */
export interface RedemptionReceipt {
  /** The Hedera account that paid, and whose key signs this. */
  accountId: string;
  poolId: string;
  /** The settled payment this seat descends from. */
  transaction: string;
  /** Unix seconds. After this the receipt is refused (§8 rule 1). */
  validUntil: number;
  /** Base64-encoded raw signature bytes. */
  signature: string;
}

/** Everything the signed message binds, minus the signature over it. */
export interface RedemptionClaim {
  accountId: string;
  network: string;
  /** The pool contract's Hedera id, so a signature cannot cross deployments. */
  contract: string;
  poolId: string;
  transaction: string;
  /** The absolute URL of the resource being redeemed. */
  resource: string;
  validUntil: number;
}

/**
 * The canonical message, as the bytes that get signed.
 *
 * §8 makes this layout normative and spells out why: UTF-8, one `key value` pair per line, a
 * single space between key and value, `\n` after every line **including the last**, keys in the
 * order below, no padding or alignment. A verifier has to reproduce these bytes exactly, so
 * anything cosmetic here is a wire change.
 *
 * The leading line is a bare version tag rather than a pair. It is what stops a future v2
 * message being verified as a v1 one.
 *
 * Note `accountId` is absent by design: the account is identified by the key that signs, and the
 * server resolves it from the receipt envelope. Binding it here as well would let the two
 * disagree, and the signature is what settles that question anyway.
 */
export function canonicalRedemptionMessage(claim: RedemptionClaim): Buffer {
  const lines = [
    "quorum402:redeem:v1",
    `network ${claim.network}`,
    `contract ${claim.contract}`,
    `poolId ${claim.poolId}`,
    `transaction ${claim.transaction}`,
    `resource ${claim.resource}`,
    `validUntil ${claim.validUntil}`,
  ];
  // Trailing `\n` on the last line too - hence the join-then-append rather than a plain join.
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function encodeRedemptionReceipt(receipt: RedemptionReceipt): string {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
}

/**
 * Decode and shape-check a presented receipt.
 *
 * Returns `undefined` for anything malformed rather than throwing, for the same reason as
 * `decodeHeaderValue`: the caller is a request handler, and the distinction between "not
 * base64", "not JSON" and "missing a field" is not one a payer can act on differently.
 *
 * It becomes a **401**, not the 400 a malformed *payment* payload gets. §6 gives redemption its
 * own rows: a receipt that will not decode is a proof that does not stand up, which is a
 * different thing from a payload that does not match the terms advertised.
 */
export function decodeRedemptionReceipt(header: string | undefined): RedemptionReceipt | undefined {
  if (!header) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  const strings = ["accountId", "poolId", "transaction", "signature"] as const;
  for (const field of strings) {
    if (typeof candidate[field] !== "string" || candidate[field] === "") return undefined;
  }
  // Seconds, not milliseconds, and an integer - a float here would round differently on the two
  // sides of the signature and take the whole message with it.
  if (typeof candidate.validUntil !== "number" || !Number.isSafeInteger(candidate.validUntil)) {
    return undefined;
  }
  return {
    accountId: candidate.accountId as string,
    poolId: candidate.poolId as string,
    transaction: candidate.transaction as string,
    validUntil: candidate.validUntil,
    signature: candidate.signature as string,
  };
}
