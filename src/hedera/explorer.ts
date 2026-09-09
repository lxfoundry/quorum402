/**
 * Links into HashScan - where a reader goes to check that any of this happened.
 *
 * Every claim this project makes about money is settled on a public ledger, so the link to the
 * transaction is not decoration: it is the difference between saying a refund was paid and
 * showing it. That makes a link that goes nowhere worse than no link at all - it looks like
 * evidence and is not - which is why the transaction form below is exact and why an id this
 * module cannot parse yields `undefined` rather than a plausible URL.
 *
 * **The transaction form is not the one the SDK prints.** Hedera renders a transaction id as
 * `0.0.10404217@1788803605.204518884`, and the mirror node - which is where HashScan reads from -
 * answers **400** for that spelling and 200 for `0.0.10404217-1788803605-204518884`. Both
 * separators change: the `@` before the timestamp, and the `.` between its seconds and nanos.
 * The account's own dots stay.
 *
 * Verified against `https://testnet.mirrornode.hedera.com/api/v1/transactions/...` on 2026-09-09.
 */

/**
 * A Hedera transaction id as the SDK renders it: `<shard>.<realm>.<num>@<seconds>.<nanos>`.
 *
 * Anchored, and the timestamp halves are captured rather than replaced in place, because the
 * account prefix contains dots too - a blanket `.` to `-` rewrite would produce `0-0-10404217`
 * and a link that resolves to nothing.
 */
const TRANSACTION_ID = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/;

/**
 * The network segment HashScan expects.
 *
 * Takes either spelling in use here - `testnet` as `Config.network` holds it, or `hedera:testnet`
 * as CAIP-2 and the x402 wire hold it - because both are a caller away from any given call site
 * and requiring the right one is a bug waiting for the one site that has the other.
 */
function segment(network: string): string {
  return network.startsWith("hedera:") ? network.slice("hedera:".length) : network;
}

/**
 * A transaction id in the spelling every URL wants, or `undefined` if this is not one.
 *
 * Shared rather than inlined at each call site because the mirror node's REST path and HashScan's
 * route take the same form, and the two were written separately once already - the transaction
 * lookup in `pay-once` rewrote the id correctly and the HashScan link beside it did not.
 */
export function dashedTransactionId(transactionId: string): string | undefined {
  const match = TRANSACTION_ID.exec(transactionId.trim());
  if (!match) return undefined;
  const [, account, seconds, nanos] = match;
  return `${account}-${seconds}-${nanos}`;
}

/**
 * The explorer page for one settled transaction, or `undefined` if this is not a transaction id.
 *
 * `undefined` rather than a throw, and rather than a best-effort URL: a caller rendering a page
 * should degrade to plain text, not fail, and `settlementTxId` in `x402/types.ts` already refuses
 * to hand back anything that is not shaped like an id for the same reason.
 */
export function hashscanTransaction(network: string, transactionId: string): string | undefined {
  const dashed = dashedTransactionId(transactionId);
  if (!dashed) return undefined;
  return `https://hashscan.io/${segment(network)}/transaction/${dashed}`;
}

/** The explorer page for the pool contract. */
export function hashscanContract(network: string, contractId: string): string {
  return `https://hashscan.io/${segment(network)}/contract/${contractId}`;
}

/** The explorer page for an account - a buyer, or the seller being paid. */
export function hashscanAccount(network: string, accountId: string): string {
  return `https://hashscan.io/${segment(network)}/account/${accountId}`;
}
