/**
 * Redeem a seat bought earlier - `quorum-scheme.md` §8.
 *
 * Run: npm run redeem -- <slug> [buyerLabel] [transactionId] [--pool <id>]
 *
 * This is the half of the primitive that only exists because payment and delivery are separated
 * in time. A buyer who paid into a pool that was still short got a 202 and no resource; what
 * they hold is a settlement id and a private key, and this turns those into the resource without
 * the coordinator having remembered anything about them.
 *
 * The transaction id and the pool may both be given, and are otherwise looked up in the index
 * from the buyer's own deposits. That lookup is a convenience for running the demo, **not** part
 * of the protocol: a buyer normally keeps the id and the pool their own payment returned, and §8
 * asks them to present both.
 *
 * Nothing here may assume one pool per resource. The contract does not enforce it and `open-pool`
 * does not either, so a slug demoed twice has two pools naming it - and taking the earliest, as
 * this script first did, redeems a stale seat from the previous run while the seat just bought
 * sits unreachable.
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { BENCHMARKS, benchmarkFor, resourceUrlFor } from "../src/benchmark/catalogue.js";
import { redeemSeat } from "../src/buyer/agent.js";
import { caip2, loadConfig } from "../src/config.js";
import { GraphClient } from "../src/graph/client.js";
import { accountOf } from "../src/hedera/mirror.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";
import { PoolRegistry } from "../src/server/pools.js";
import { loadBuyer } from "./accounts.js";

const USAGE = `usage: npm run redeem -- <slug> [buyerLabel] [transactionId] [--pool <id>]\n  slugs: ${BENCHMARKS.map((b) => b.slug).join(", ")}`;

async function main(): Promise<number> {
  const { poolArg, rest } = takePoolFlag(process.argv.slice(2));
  const [slug, label, transactionArg, ...extra] = rest;
  // Extra positionals are refused rather than ignored: this script signs as whichever buyer it
  // is given, and a mistyped argument silently sliding into the wrong slot would sign as the
  // wrong account and report a puzzling 403.
  if (!slug || !benchmarkFor(slug) || extra.length > 0) throw new Error(USAGE);

  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const contractId = readDeployment(network)?.contractId;
  if (!contractId) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);
  // Which pool and which settlement both have to come from somewhere. Given both, the index is
  // not needed at all; given neither, it is the only thing that knows.
  if (!cfg.subgraphUrl && !(poolArg && transactionArg)) {
    throw new Error(
      "no SUBGRAPH_URL set, so the seat cannot be looked up. Pass --pool and the transaction id:\n  " +
        USAGE,
    );
  }

  const buyer = loadBuyer(label, cfg.network);
  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, slug);
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  // Reading `poolCount` and `poolOf` is a contract query, and a query has a fee, so the client
  // needs an operator to pay it - every other script that reads the contract sets one. This one
  // did not, which made `npm run redeem` fail before it reached any of its own logic.
  //
  // The operator pays for the read and nothing else. The redemption itself is signed by the
  // buyer's key further down, because §8 asks the *paying account* to prove the seat is theirs.
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );

  try {
    const pools = new PoolsClient(client, ContractId.fromString(contractId));
    const registry = new PoolRegistry(pools);
    const candidates = await registry.poolsFor(resourceUrl);
    if (candidates.length === 0) throw new Error(`no pool on ${network} names ${resourceUrl}`);

    // The address the *network* holds, not the one the key derives - the distinction that
    // strands a seat, and the one §8 makes a rule of.
    const { evmAddress } = await accountOf(cfg.mirrorUrl, buyer.accountId);
    const { poolId, transaction } = await locateSeat({
      candidates,
      poolArg,
      transactionArg,
      subgraphUrl: cfg.subgraphUrl,
      payerAddress: evmAddress,
      resourceUrl,
    });

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

/**
 * Pull `--pool <id>` (or `--pool=<id>`) out of the arguments, leaving the positionals.
 *
 * A flag rather than a fourth positional, because the pool is the argument this script needs
 * least often and the transaction id the one it needs most: as a positional it would have to be
 * typed as a placeholder just to reach the id behind it.
 */
function takePoolFlag(argv: string[]): { poolArg?: string; rest: string[] } {
  const rest: string[] = [];
  let poolArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--pool") {
      poolArg = argv[++i];
      if (poolArg === undefined) throw new Error(USAGE);
    } else if (arg.startsWith("--pool=")) {
      poolArg = arg.slice("--pool=".length);
    } else {
      rest.push(arg);
    }
  }
  if (poolArg !== undefined && !/^\d+$/.test(poolArg)) {
    throw new Error(`--pool takes a pool id, not "${poolArg}"`);
  }
  return { poolArg, rest };
}

/**
 * The pool this buyer holds a seat in, and the settlement that bought it.
 *
 * Searched **newest first**. A resource demoed twice has two pools naming it, and the seat worth
 * redeeming is the one just bought; taking `poolsFor(url)[0]` - the earliest pool ever created
 * for the URL - reaches for the opposite one, quietly redeeming a seat from the previous run
 * while reporting the seat actually bought as missing.
 *
 * The coordinator resolves the same URL differently, and should: it advertises the earliest pool
 * still *selling* (`sellingPoolFor`), because a 402 has no payer to ask about yet. Redemption
 * does have one, so the buyer's own deposits are the better question. The two disagree only
 * because they are answering different ones.
 */
async function locateSeat(params: {
  candidates: bigint[];
  poolArg?: string;
  transactionArg?: string;
  subgraphUrl?: string;
  payerAddress: string;
  resourceUrl: string;
}): Promise<{ poolId: bigint; transaction: string }> {
  const { candidates, poolArg, transactionArg, payerAddress, resourceUrl } = params;
  const named = candidates.join(", ");

  if (poolArg !== undefined) {
    const poolId = BigInt(poolArg);
    if (!candidates.includes(poolId)) {
      throw new Error(`pool ${poolArg} does not name ${resourceUrl}. Pools that do: ${named}`);
    }
    if (transactionArg) return { poolId, transaction: transactionArg };
    const found = await graphOf(params.subgraphUrl).settlementFor(poolArg, payerAddress);
    if (!found) throw new Error(nothingIndexed(payerAddress, `pool ${poolArg}`));
    return { poolId, transaction: found };
  }

  const graph = graphOf(params.subgraphUrl);
  const newestFirst = [...candidates].reverse();

  // A transaction id names exactly one deposit across the contract, so the first pool the index
  // can place it in is the only one it could have been in.
  if (transactionArg) {
    for (const poolId of newestFirst) {
      const deposit = await graph.depositFor(poolId.toString(), transactionArg);
      // `depositFor` always answers with an object - `indexedBlock` rides along even when there
      // is no row - so the position is the only field that says the index placed it here. A bare
      // truthiness check passes on the first pool tried and reaches for the wrong seat.
      if (deposit.depositId !== undefined) return { poolId, transaction: transactionArg };
    }
    throw new Error(
      `the index cannot place ${transactionArg} in any pool naming ${resourceUrl} (${named}). Either it has not caught up, or that settlement bought a seat somewhere else.`,
    );
  }

  for (const poolId of newestFirst) {
    const found = await graph.settlementFor(poolId.toString(), payerAddress);
    if (found) return { poolId, transaction: found };
  }
  throw new Error(nothingIndexed(payerAddress, `any pool naming ${resourceUrl} (${named})`));
}

function graphOf(subgraphUrl: string | undefined): GraphClient {
  if (!subgraphUrl) throw new Error("no SUBGRAPH_URL set");
  return new GraphClient({ url: subgraphUrl });
}

function nothingIndexed(payerAddress: string, where: string): string {
  return `the index has no counted deposit from ${payerAddress} in ${where}. Either this buyer did not pay, or the index has not caught up.`;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  });
