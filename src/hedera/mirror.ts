/**
 * The mirror node's REST API - what the network says about an account.
 *
 * Consensus nodes answer what is true now; the mirror node answers what is recorded, a second
 * or two behind. Nothing in the recording path waits on it (ADR 0006), but two facts are only
 * available here: an account's network EVM address, and its balance without a query fee.
 */

/**
 * The EVM address the *network* holds for an account, not the one derivable from its key.
 *
 * These differ, and the difference strands money. `accounts:create` makes accounts with
 * `setKeyWithoutAlias`, so their on-chain address is the long-zero form of the account
 * number; paying the key-derived address instead would create a fresh hollow account and
 * credit that one.
 *
 * `quorum-scheme.md` §8 turns this into a rule: the address recorded against a deposit must be
 * the one the network holds, at recording time and at redemption time alike, or a seat cannot
 * be redeemed by the account that bought it.
 *
 * **Deliberately asks nothing about the account's key.** Every account has an address, including
 * the threshold-key and contract accounts `accountOf` refuses; whether one can *sign* is a
 * separate question with a separate answer, and conflating them here would make an address the
 * coordinator only needs in order to refund conditional on a capability only redemption needs.
 */
export async function evmAddressOf(mirrorUrl: string, accountId: string): Promise<string> {
  const body = await accountRecord(mirrorUrl, accountId);
  if (!body.evm_address) throw new Error(`mirror node has no evm address for ${accountId}`);
  return body.evm_address;
}

/** How an account's key is held. The two Hedera supports sign and verify identically here. */
export type AccountKeyType = "ECDSA_SECP256K1" | "ED25519";

export interface MirrorAccount {
  /** The address the network holds - see `evmAddressOf` for why that qualifier matters. */
  evmAddress: string;
  /** Raw public key hex: 33 bytes compressed for ECDSA, 32 for ED25519. */
  key: { type: AccountKeyType; hex: string };
}

/**
 * The public key and network address of an account, in one request.
 *
 * §8 asks a redeeming server for both - the key to verify the signature, the address to match
 * against the deposit's recorded payer - and the mirror node returns them from the same record.
 * Two calls would also be two moments, and an account whose key rotated between them would
 * verify against one and be matched against the other.
 *
 * A threshold key or key list is refused rather than guessed at. `quorum` has nothing to say
 * about m-of-n redemption, and picking one key out of a list would invent a rule §8 does not
 * have; a smart contract account has no key at all and cannot sign this message.
 */
export async function accountOf(mirrorUrl: string, accountId: string): Promise<MirrorAccount> {
  const body = await accountRecord(mirrorUrl, accountId);
  if (!body.evm_address) throw new Error(`mirror node has no evm address for ${accountId}`);
  const type = body.key?._type;
  if (type !== "ECDSA_SECP256K1" && type !== "ED25519") {
    throw new Error(`account ${accountId} has key type ${type ?? "none"}, which cannot sign`);
  }
  if (!body.key?.key) throw new Error(`mirror node has no public key for ${accountId}`);
  return { evmAddress: body.evm_address, key: { type, hex: body.key.key } };
}

/** One account record, read once. `evmAddressOf` and `accountOf` want different fields of it. */
async function accountRecord(
  mirrorUrl: string,
  accountId: string,
): Promise<{ evm_address?: string; key?: { _type?: string; key?: string } | null }> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${accountId}?limit=1`);
  if (!res.ok) throw new Error(`mirror node returned ${res.status} for account ${accountId}`);
  return (await res.json()) as { evm_address?: string; key?: { _type?: string; key?: string } | null };
}

export async function balanceTinybars(mirrorUrl: string, id: string): Promise<bigint> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${id}?limit=1`);
  if (!res.ok) throw new Error(`mirror node returned ${res.status} for ${id}`);
  const body = (await res.json()) as { balance?: { balance?: number } };
  return BigInt(body.balance?.balance ?? 0);
}

/**
 * Poll until the mirror node reports the balance expected, or give up and return what it says.
 *
 * Mirror ingestion lags consensus by a second or two. Nothing in the *recording* path waits on
 * it (ADR 0006), but anything that reads a balance back to show that money moved has to, or it
 * reports the pre-transfer figure and reads as though nothing happened.
 */
export async function awaitBalance(
  mirrorUrl: string,
  id: string,
  expected: bigint,
  attempts = 12,
): Promise<bigint> {
  let last = 0n;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await balanceTinybars(mirrorUrl, id);
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}
