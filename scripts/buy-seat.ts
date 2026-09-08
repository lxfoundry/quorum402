/**
 * Buy one seat in a pool, as an autonomous buyer would.
 *
 * Run: npm run buy -- <slug> [buyerLabel]
 *
 * The buyer never sees the pool contract, the coordinator's key or the facilitator. It asks
 * for a resource, is told what a seat costs, pays, and is told what its payment bought - a
 * receipt if the crowd is short, the resource itself if it was the one that completed it.
 */
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { benchmarkFor, resourceUrlFor, BENCHMARKS } from "../src/benchmark/catalogue.js";
import { buySeat } from "../src/buyer/agent.js";
import { loadConfig } from "../src/config.js";
import { loadBuyer } from "./accounts.js";

async function main(): Promise<number> {
  const slug = process.argv[2];
  const label = process.argv[3];
  if (!slug || !benchmarkFor(slug)) {
    throw new Error(
      `usage: npm run buy -- <slug> [buyerLabel]\n  slugs: ${BENCHMARKS.map((b) => b.slug).join(", ")}`,
    );
  }

  const cfg = loadConfig();
  const buyer = loadBuyer(label, cfg.network);
  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, slug);
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();

  console.log(`\n${buyer.label} buying a seat in ${resourceUrl}\n`);
  try {
    const result = await buySeat({
      client,
      resourceUrl,
      payerId: buyer.accountId,
      payerKey: PrivateKey.fromStringECDSA(buyer.privateKey),
    });

    const entry = result.offered?.accepts[0];
    if (entry && entry.scheme === "quorum") {
      console.log(`  offered      ${entry.amount} tinybars for 1 of ${entry.extra.threshold} seats`);
      console.log(`  pool         ${entry.extra.poolId}, ${entry.extra.filled ?? "?"} taken when asked`);
    }
    if (result.transactionId) console.log(`  signed       ${result.transactionId}`);
    console.log(`  answered     ${result.status}\n`);
    console.log(JSON.stringify(result.body, null, 2));

    // 200 filled the pool, 202 took a seat and is waiting. Anything else did not pay.
    return result.status === 200 || result.status === 202 ? 0 : 1;
  } finally {
    client.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  });
