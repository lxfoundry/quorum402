/**
 * Read the throwaway testnet accounts `npm run accounts:create` wrote.
 *
 * `.accounts.json` holds private keys and is gitignored. Nothing here prints one, and nothing
 * that consumes these accounts should either.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratedAccount } from "./create-accounts.js";

export const ACCOUNTS_FILE = ".accounts.json";

/** What the file holds: the accounts, and which network they were created against. */
export interface AccountsFile {
  network?: string;
  accounts: GeneratedAccount[];
}

/**
 * Read an accounts file by path, without judging which network it holds.
 *
 * The network check belongs to `loadAccounts`, which is answering "can I use these now". This
 * answers "what is in this file", which is a different question and the one anything recycling
 * an *old* file is asking - including one written against a network this process is not
 * configured for, whose accounts still hold a balance worth recovering.
 */
export function readAccountsFile(path: string): AccountsFile {
  if (!existsSync(path)) throw new Error(`${path} not found`);
  return JSON.parse(readFileSync(path, "utf8")) as AccountsFile;
}

export function loadAccounts(expectedNetwork: string): GeneratedAccount[] {
  if (!existsSync(ACCOUNTS_FILE)) {
    throw new Error(`${ACCOUNTS_FILE} not found. Run: npm run accounts:create`);
  }
  const { network, accounts } = readAccountsFile(ACCOUNTS_FILE);
  // create-accounts records which network it created against. Without this check, testnet
  // buyers get used against a mainnet config and fail as INVALID_ACCOUNT_ID - a confusing
  // error a long way from its cause.
  if (network && network !== expectedNetwork) {
    throw new Error(
      `${ACCOUNTS_FILE} holds ${network} accounts but HEDERA_NETWORK is ${expectedNetwork}.\n` +
        `Point HEDERA_NETWORK at ${network}, or recreate the accounts with: npm run accounts:create -- --force`,
    );
  }
  return accounts;
}

/** Write the accounts file in the shape `loadAccounts` expects. Holds keys; never commit it. */
export function writeAccounts(
  accounts: GeneratedAccount[],
  network: string,
  path: string = ACCOUNTS_FILE,
): void {
  writeFileSync(path, JSON.stringify({ network, accounts }, null, 2) + "\n");
}

/**
 * Move an accounts file aside, keeping it.
 *
 * Renamed rather than deleted, and that is the whole point: these files hold the only copy of
 * keys to accounts that may still be owed a refund the contract will only pay to `msg.sender`.
 * Superseding one must not be the same act as losing it.
 *
 * The archive lands beside the original as `<timestamp>.accounts.json`, which `.gitignore`
 * already covers via `*.accounts.json` - so an archive cannot become the first thing to commit
 * a private key to a public repository. Colons are stripped from the timestamp because Windows
 * will not have them in a filename.
 *
 * Returns the archive's path, or `undefined` when there was no file to move.
 */
export function archiveAccounts(
  path: string = ACCOUNTS_FILE,
  // Injectable for the same reason `PoolRegistry` takes one: the behaviour that matters here is
  // what happens when two archives land in the same second, and a test that waits for a real
  // clock to produce that is a test that passes whenever it happens not to.
  options: { now?: () => Date } = {},
): string | undefined {
  if (!existsSync(path)) return undefined;
  const now = options.now ?? (() => new Date());
  const stamp = now().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const directory = dirname(path);

  // Second-resolution timestamps collide, and `renameSync` overwrites without a word - so two
  // resets in the same second would destroy the first archive by the act meant to preserve it.
  // Counted up rather than given a finer timestamp, because milliseconds only make the window
  // smaller and this closes it. The suffix stays inside `*.accounts.json`, so an archive cannot
  // fall out of the gitignore patterns that keep keys out of a public repository.
  let archive = join(directory, `${stamp}.accounts.json`);
  for (let n = 2; existsSync(archive); n++) {
    archive = join(directory, `${stamp}-${n}.accounts.json`);
  }

  renameSync(path, archive);
  return archive;
}

/** A named buyer, or the first one. */
export function loadBuyer(label: string | undefined, expectedNetwork: string): GeneratedAccount {
  const accounts = loadAccounts(expectedNetwork);
  const buyer = label ? accounts.find((a) => a.label === label) : accounts[0];
  if (!buyer) {
    throw new Error(
      `No such account "${label}". Available: ${accounts.map((a) => a.label).join(", ")}`,
    );
  }
  return buyer;
}
