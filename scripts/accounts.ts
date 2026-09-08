/**
 * Read the throwaway testnet accounts `npm run accounts:create` wrote.
 *
 * `.accounts.json` holds private keys and is gitignored. Nothing here prints one, and nothing
 * that consumes these accounts should either.
 */
import { existsSync, readFileSync } from "node:fs";
import type { GeneratedAccount } from "./create-accounts.js";

const ACCOUNTS = ".accounts.json";

export function loadAccounts(expectedNetwork: string): GeneratedAccount[] {
  if (!existsSync(ACCOUNTS)) {
    throw new Error(`${ACCOUNTS} not found. Run: npm run accounts:create`);
  }
  const { network, accounts } = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as {
    network?: string;
    accounts: GeneratedAccount[];
  };
  // create-accounts records which network it created against. Without this check, testnet
  // buyers get used against a mainnet config and fail as INVALID_ACCOUNT_ID - a confusing
  // error a long way from its cause.
  if (network && network !== expectedNetwork) {
    throw new Error(
      `${ACCOUNTS} holds ${network} accounts but HEDERA_NETWORK is ${expectedNetwork}.\n` +
        `Point HEDERA_NETWORK at ${network}, or recreate the accounts with: npm run accounts:create -- --force`,
    );
  }
  return accounts;
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
