/**
 * Create funded Hedera testnet accounts to act as buyers in a pool.
 *
 * A threshold pool needs several distinct payers, and "distinct" is the whole point - one
 * account paying three times is not a quorum. These are throwaway testnet accounts.
 *
 * Writes .accounts.json, which holds PRIVATE KEYS and is gitignored. This repository is
 * public; that file must never appear in a commit.
 *
 * Run: npm run accounts:create -- [count] [hbarEach]     # first time, writes the file
 *      npm run accounts:create -- --add <label> [hbarEach]  # append one, keeping the rest
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { loadConfig } from "../src/config.js";
import { ACCOUNTS_FILE, loadAccounts, writeAccounts } from "./accounts.js";

const OUT = ACCOUNTS_FILE;

export interface GeneratedAccount {
  label: string;
  accountId: string;
  privateKey: string;
  /**
   * The EVM address the *network* holds for this account - not the one its key derives.
   *
   * These accounts are created with `setKeyWithoutAlias` (below), so they carry no EVM alias
   * and their address is the long-zero form of the account number, `0x00..0<num>`. The
   * key-derived address exists as arithmetic and belongs to nothing: paying it would create a
   * separate hollow account, and recording it as a deposit's payer would leave the refund
   * unclaimable, because `claimRefund` matches `msg.sender` - which for a call from this
   * account is the long-zero address.
   *
   * This field held the key-derived address until 2026-09-09. Nothing read it, so nothing
   * broke; it was wrong on paper for two days and cost an afternoon of doubting the subgraph,
   * which was reporting the correct address all along.
   */
  evmAddress: string;
}

interface Args {
  /** Append one account under this label, keeping everything already in the file. */
  add?: string;
  count: number;
  hbarEach: number;
}

function parseArgs(argv: string[]): Args {
  const add = argv.includes("--add") ? argv[argv.indexOf("--add") + 1] : undefined;
  if (argv.includes("--add") && (!add || add.startsWith("--"))) {
    throw new Error("--add needs a label, e.g. --add seller");
  }
  // Positionals keep their meaning either side of the flag: `--add seller 5` funds with 5.
  const positional = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    return argv[i - 1] !== "--add";
  });
  // An extra positional is a mis-invocation, not something to drop: `--add seller 5 extra`
  // and `3 20 extra` both parse as valid today, and the second funds real testnet accounts
  // from a command whose author clearly meant something else.
  const expected = add ? 1 : 2;
  if (positional.length > expected) {
    throw new Error(
      add
        ? `--add <label> takes at most one more argument, [hbarEach]. Got: ${positional.join(" ")}`
        : `expected at most [count] [hbarEach]. Got: ${positional.join(" ")}`,
    );
  }
  const [first, second] = add ? [undefined, positional[0]] : positional;

  const count = Number(first ?? 4);
  const hbarEach = Number(second ?? 20);
  if (!add && (!Number.isInteger(count) || count < 1 || count > 10)) {
    throw new Error(`count must be an integer 1-10, got "${first}"`);
  }
  if (!Number.isFinite(hbarEach) || hbarEach <= 0) {
    throw new Error(`hbarEach must be positive, got "${second}"`);
  }
  return { add, count, hbarEach };
}

/**
 * Create one throwaway account per label, funded with `hbarEach`.
 *
 * `onCreated` fires per account rather than the whole list being returned at the end, and that
 * is load-bearing rather than a convenience: these accounts hold real testnet funds the moment
 * they exist, so a failure on the fourth must not lose the keys to the first three. A caller
 * that persists from the callback keeps everything that was made; one that waits for the return
 * value keeps nothing when this throws.
 *
 * The client's operator pays for the creations and funds the initial balances.
 */
export async function createAccounts(params: {
  client: Client;
  labels: string[];
  hbarEach: number;
  onCreated?: (account: GeneratedAccount) => void;
}): Promise<GeneratedAccount[]> {
  const created: GeneratedAccount[] = [];
  for (const label of params.labels) {
    const key = PrivateKey.generateECDSA();

    const receipt = await (
      await new AccountCreateTransaction()
        // No EVM alias, so the account's address is the long-zero form of its number. That
        // is what `evmAddress` records and what these accounts sign contract calls as.
        .setKeyWithoutAlias(key.publicKey)
        .setInitialBalance(new Hbar(params.hbarEach))
        // Unlimited auto-association: lets these accounts receive HTS tokens without an
        // explicit association step, which is what makes a USDC path viable later.
        .setMaxAutomaticTokenAssociations(-1)
        .execute(params.client)
    ).getReceipt(params.client);

    const accountId = receipt.accountId;
    if (!accountId) throw new Error(`account creation for ${label} returned no accountId`);

    const account: GeneratedAccount = {
      label,
      accountId: accountId.toString(),
      privateKey: key.toStringRaw(),
      evmAddress: `0x${accountId.toEvmAddress()}`,
    };
    created.push(account);
    params.onCreated?.(account);
  }
  return created;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  // Appending reads the file first, so the accounts already in it survive. Overwriting is
  // what the guard below exists to prevent: those accounts hold testnet funds, and losing
  // their keys strands the balance with no way back.
  const existing = args.add ? loadAccounts(cfg.network) : [];
  if (args.add && existing.some((a) => a.label === args.add)) {
    throw new Error(
      `${OUT} already has an account labelled "${args.add}": ${
        existing.find((a) => a.label === args.add)?.accountId
      }`,
    );
  }
  if (!args.add && existsSync(OUT) && !process.argv.includes("--force")) {
    throw new Error(
      `${OUT} already exists. Creating accounts again would orphan the funds in the old ones.\n` +
        `To add one without touching the others: npm run accounts:create -- --add <label>\n` +
        `Pass --force to replace the file anyway.`,
    );
  }

  const labels = args.add
    ? [args.add]
    : Array.from({ length: args.count }, (_, i) => `buyer${i + 1}`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );

  console.log(
    `\nCreating ${labels.length} account(s) with ${args.hbarEach} HBAR each on ${cfg.network}\n`,
  );

  const created: GeneratedAccount[] = [];
  try {
    await createAccounts({
      client,
      labels,
      hbarEach: args.hbarEach,
      // Persist-as-you-go: `created` is appended here rather than taken from the return value,
      // so the `finally` below still has every account that was made when one of them throws.
      onCreated: (account) => {
        created.push(account);
        console.log(`  ${account.label.padEnd(8)} ${account.accountId}`);
      },
    });
  } finally {
    // Persist whatever was created even if a later one failed - these accounts hold real
    // testnet funds, and losing their keys strands that balance.
    if (created.length) {
      const accounts = [...existing, ...created];
      writeAccounts(accounts, cfg.network, OUT);
      console.log(
        `\nWrote ${created.length} new account(s), ${accounts.length} in total, to ${OUT}` +
          ` (gitignored - contains keys)`,
      );
    }
    client.close();
  }
}

// Only when run directly. `createAccounts` above is imported by `demo-reset.ts`, and an
// unguarded call here ran this file's *argument parsing* against that script's flags - which
// failed on the first one it did not recognise, from a file the caller never invoked.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  });
}
