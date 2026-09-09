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
import { writeFileSync, existsSync } from "node:fs";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { loadConfig } from "../src/config.js";
import { loadAccounts } from "./accounts.js";

const OUT = ".accounts.json";

export interface GeneratedAccount {
  label: string;
  accountId: string;
  privateKey: string;
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

  const count = Number(first ?? 3);
  const hbarEach = Number(second ?? 20);
  if (!add && (!Number.isInteger(count) || count < 1 || count > 10)) {
    throw new Error(`count must be an integer 1-10, got "${first}"`);
  }
  if (!Number.isFinite(hbarEach) || hbarEach <= 0) {
    throw new Error(`hbarEach must be positive, got "${second}"`);
  }
  return { add, count, hbarEach };
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
    for (const label of labels) {
      const key = PrivateKey.generateECDSA();

      const receipt = await (
        await new AccountCreateTransaction()
          .setKeyWithoutAlias(key.publicKey)
          .setInitialBalance(new Hbar(args.hbarEach))
          // Unlimited auto-association: lets these accounts receive HTS tokens without an
          // explicit association step, which is what makes a USDC path viable later.
          .setMaxAutomaticTokenAssociations(-1)
          .execute(client)
      ).getReceipt(client);

      const accountId = receipt.accountId;
      if (!accountId) throw new Error(`account creation for ${label} returned no accountId`);

      created.push({
        label,
        accountId: accountId.toString(),
        privateKey: key.toStringRaw(),
        evmAddress: `0x${key.publicKey.toEvmAddress()}`,
      });
      console.log(`  ${label.padEnd(8)} ${accountId.toString()}`);
    }
  } finally {
    // Persist whatever was created even if a later one failed - these accounts hold real
    // testnet funds, and losing their keys strands that balance.
    if (created.length) {
      const accounts = [...existing, ...created];
      writeFileSync(OUT, JSON.stringify({ network: cfg.network, accounts }, null, 2) + "\n");
      console.log(
        `\nWrote ${created.length} new account(s), ${accounts.length} in total, to ${OUT}` +
          ` (gitignored - contains keys)`,
      );
    }
    client.close();
  }
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
