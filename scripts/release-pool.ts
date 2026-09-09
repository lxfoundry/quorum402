/**
 * Pay a met pool out to its recipient.
 *
 * Run: npm run pool:release -- <poolId>
 *
 * **Permissionless, and deliberately not part of the resource server.** `quorum-scheme.md` §6:
 * delivery depends on the threshold being met and never on the seller having been paid, so
 * paying the seller is a separate action anyone may take. Coupling a buyer's access to it would
 * let a failed payout withhold a resource the crowd has already earned.
 *
 * This script is therefore a convenience for a demo, not a privileged operation. Any account
 * can call `release`, including the seller's own.
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { caip2, loadConfig } from "../src/config.js";
import { awaitBalance, balanceTinybars } from "../src/hedera/mirror.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw || !/^\d+$/.test(raw)) throw new Error("usage: npm run pool:release -- <poolId>");
  const poolId = BigInt(raw);

  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const contractId = readDeployment(network)?.contractId;
  if (!contractId) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(contractId));

  try {
    const terms = await pools.poolOf(poolId);
    const state = await pools.statusOf(poolId);
    console.log(`\npool ${poolId} is ${state}, ${terms.seats} of ${terms.threshold} seats\n`);

    const before = await balanceTinybars(cfg.mirrorUrl, contractId);
    const released = await pools.release(poolId);
    console.log(`  released     ${released.transactionId}  (${released.gasUsed} gas)`);

    // Read the outcome off the ledger rather than off the receipt: a receipt says the call
    // succeeded, and only the balance says the money arrived. Polled, because mirror ingestion
    // lags consensus - read once and immediately, it reports the pre-transfer figure and looks
    // exactly like a payout that did not happen.
    const paid = BigInt(terms.unitTinybars) * BigInt(terms.seats);
    const after = await awaitBalance(cfg.mirrorUrl, contractId, before - paid);
    console.log(`  contract     ${before} -> ${after} tinybars`);
    console.log(`  recipient    ${terms.recipient}`);
    console.log(`  state        ${await pools.statusOf(poolId)}\n`);
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
