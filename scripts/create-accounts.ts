/**
 * Create funded Hedera testnet accounts to act as buyers in a pool.
 *
 * A threshold pool needs several distinct payers, and "distinct" is the whole point - one
 * account paying three times is not a quorum. These are throwaway testnet accounts.
 *
 * Writes .accounts.json, which holds PRIVATE KEYS and is gitignored. This repository is
 * public; that file must never appear in a commit.
 *
 * Run: npm run accounts:create -- [count] [hbarEach]
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

const OUT = ".accounts.json";

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

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 3);
  const hbarEach = Number(process.argv[3] ?? 20);

  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error(`count must be an integer 1-10, got "${process.argv[2]}"`);
  }
  if (!Number.isFinite(hbarEach) || hbarEach <= 0) {
    throw new Error(`hbarEach must be positive, got "${process.argv[3]}"`);
  }

  if (existsSync(OUT) && !process.argv.includes("--force")) {
    throw new Error(
      `${OUT} already exists. Creating accounts again would orphan the funds in the old ones.\n` +
        `Pass --force if that is what you want.`,
    );
  }

  const cfg = loadConfig();
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );

  console.log(`\nCreating ${count} account(s) with ${hbarEach} HBAR each on ${cfg.network}\n`);

  const accounts: GeneratedAccount[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const label = `buyer${i + 1}`;
      const key = PrivateKey.generateECDSA();

      const receipt = await (
        await new AccountCreateTransaction()
          // No EVM alias, so the account's address is the long-zero form of its number. That
          // is what `evmAddress` records and what these accounts sign contract calls as.
          .setKeyWithoutAlias(key.publicKey)
          .setInitialBalance(new Hbar(hbarEach))
          // Unlimited auto-association: lets these accounts receive HTS tokens without an
          // explicit association step, which is what makes a USDC path viable later.
          .setMaxAutomaticTokenAssociations(-1)
          .execute(client)
      ).getReceipt(client);

      const accountId = receipt.accountId;
      if (!accountId) throw new Error(`account creation for ${label} returned no accountId`);

      accounts.push({
        label,
        accountId: accountId.toString(),
        privateKey: key.toStringRaw(),
        evmAddress: `0x${accountId.toEvmAddress()}`,
      });
      console.log(`  ${label.padEnd(8)} ${accountId.toString()}`);
    }
  } finally {
    // Persist whatever was created even if a later one failed - these accounts hold real
    // testnet funds, and losing their keys strands that balance.
    if (accounts.length) {
      writeFileSync(OUT, JSON.stringify({ network: cfg.network, accounts }, null, 2) + "\n");
      console.log(`\nWrote ${accounts.length} account(s) to ${OUT} (gitignored - contains keys)`);
    }
    client.close();
  }

  console.log(
    `\nSet PAY_TO_ID in .env to the account that should receive payment.\n` +
      `For the first single payment, any account other than the payer will do.\n`,
  );
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
