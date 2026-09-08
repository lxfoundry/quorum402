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
 */
export async function evmAddressOf(mirrorUrl: string, accountId: string): Promise<string> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${accountId}?limit=1`);
  if (!res.ok) throw new Error(`mirror node returned ${res.status} for account ${accountId}`);
  const body = (await res.json()) as { evm_address?: string };
  if (!body.evm_address) throw new Error(`mirror node has no evm address for ${accountId}`);
  return body.evm_address;
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
