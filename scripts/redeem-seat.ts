/**
 * Redeem a seat bought earlier - `quorum-scheme.md` §8.
 *
 * Run: npm run redeem -- <slug> [buyerLabel] [transactionId]
 *
 * This is the half of the primitive that only exists because payment and delivery are separated
 * in time. A buyer who paid into a pool that was still short got a 202 and no resource; what
 * they hold is a settlement id and a private key, and this turns those into the resource without
 * the coordinator having remembered anything about them.
 *
 * The transaction id may be given, and is otherwise looked up in the index by payer and pool.
 * That lookup is a convenience for running the demo, **not** part of the protocol: a buyer
 * normally keeps the id its own payment returned, and §8 asks it to present that.
 */
import { Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { BENCHMARKS, benchmarkFor, resourceUrlFor } from "../src/benchmark/catalogue.js";
import { redeemSeat } from "../src/buyer/agent.js";
import { caip2, loadConfig } from "../src/config.js";
import { GraphClient } from "../src/graph/client.js";
import { accountOf } from "../src/hedera/mirror.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";
import { PoolRegistry } from "../src/server/pools.js";
import { loadBuyer } from "./accounts.js";

const USAGE = `usage: npm run redeem -- <slug> [buyerLabel] [transactionId]\n  slugs: ${BENCHMARKS.map((b) => b.slug).join(", ")}`;

async function main(): Promise<number> {
  const [slug, label, transactionArg, ...extra] = process.argv.slice(2);
  // Extra positionals are refused rather than ignored: this script signs as whichever buyer it
  // is given, and a mistyped argument silently sliding into the wrong slot would sign as the
  // wrong account and report a puzzling 403.
  if (!slug || !benchmarkFor(slug) || extra.length > 0) throw new Error(USAGE);

  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const contractId = readDeployment(network)?.contractId;
  if (!contractId) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);
  if (!cfg.subgraphUrl && !transactionArg) {
    throw new Error(
      "no SUBGRAPH_URL set, so the settlement id cannot be looked up. Pass it:\n  " + USAGE,
    );
  }

  const buyer = loadBuyer(label, cfg.network);
  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, slug);
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();

  try {
    const pools = new PoolsClient(client, ContractId.fromString(contractId));
    const registry = new PoolRegistry(pools);
    const [poolId] = await registry.poolsFor(resourceUrl);
    if (poolId === undefined) throw new Error(`no pool on ${network} names ${resourceUrl}`);

    // The address the *network* holds, not the one the key derives - the distinction that
    // strands a seat, and the one §8 makes a rule of.
    const { evmAddress } = await accountOf(cfg.mirrorUrl, buyer.accountId);
    const transaction = transactionArg ?? (await settlementOf(cfg.subgraphUrl, poolId, evmAddress));

    console.log(`\n${buyer.label} redeeming a seat in pool ${poolId}\n`);
    console.log(`  account      ${buyer.accountId}  ${evmAddress}`);
    console.log(`  settlement   ${transaction}`);

    const result = await redeemSeat({
      resourceUrl,
      accountId: buyer.accountId,
      key: PrivateKey.fromStringECDSA(buyer.privateKey),
      network,
      contractId,
      poolId: poolId.toString(),
      transaction,
    });

    console.log(`  answered     ${result.status}\n`);
    console.log(JSON.stringify(result.body, null, 2));
    console.log();
    // Only 200 is a redemption. 202 and 409 are real answers about a real seat, and neither
    // hands over the resource, so neither is a success for a script whose job was to fetch it.
    return result.status === 200 ? 0 : 1;
  } finally {
    client.close();
  }
}

/** The settlement this payer's deposit in this pool was recorded under, from the index. */
async function settlementOf(
  subgraphUrl: string | undefined,
  poolId: bigint,
  payerAddress: string,
): Promise<string> {
  if (!subgraphUrl) throw new Error("no SUBGRAPH_URL set");
  const graph = new GraphClient({ url: subgraphUrl });
  const found = await graph.settlementFor(poolId.toString(), payerAddress);
  if (!found) {
    throw new Error(
      `the index has no deposit from ${payerAddress} in pool ${poolId}. Either this buyer did not pay into it, or the index has not caught up.`,
    );
  }
  return found;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  });
