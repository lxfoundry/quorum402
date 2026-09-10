/**
 * The coordinator: an x402 resource server for quorum-gated resources.
 *
 * Implements `quorum-scheme.md` §6's lifecycle. The status codes are the specification's, and
 * the one that does not exist anywhere else in x402 is **202** - settled, and the resource is
 * still pending, because the crowd has not arrived yet. Every other flow either delivers or
 * fails; `conditional` needs a third answer.
 *
 * It holds no database. Which pool a URL is selling, what it costs, who has paid and whether
 * the threshold is met are all read from the chain, so a restart loses nothing but a cache.
 */
import { pathToFileURL } from "node:url";
import express from "express";
import type { Express, Request, Response } from "express";
import {
  AccountId,
  Client,
  ContractId,
  PrivateKey,
} from "@hiero-ledger/sdk";
import {
  BENCHMARKS,
  benchmarkFor,
  describe as describeBenchmark,
  licence,
  resourceUrlFor,
} from "../benchmark/catalogue.js";
import type { Benchmark } from "../benchmark/catalogue.js";
import { caip2, loadConfig } from "../config.js";
import type { Config } from "../config.js";
import { GraphClient } from "../graph/client.js";
import { accountOf, balanceTinybars, evmAddressOf } from "../hedera/mirror.js";
import type { MirrorAccount } from "../hedera/mirror.js";
import { PoolsClient } from "../pool/client.js";
import type { PoolState, PoolTerms } from "../pool/client.js";
import { readDeployment } from "../pool/deployment.js";
import { Facilitator } from "../x402/facilitator.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  QUORUM_RECEIPT_HEADER,
  encodeHeaderValue,
} from "../x402/http.js";
import { decodeRedemptionReceipt } from "../x402/redemption.js";
import type { Network, QuorumRequirements } from "../x402/types.js";
import { FailureReporter } from "./failures.js";
import { inspectBindingTransfer } from "./payer.js";
import { bindingRequestFor, validateQuorumPayload } from "./payment.js";
import { PoolRegistry } from "./pools.js";
import type { PoolAvailability } from "./pools.js";
import { MIN_COORDINATOR_TINYBARS, preflight } from "./preflight.js";
import type { SolvencyReader } from "./preflight.js";
import { buildReceipt } from "./receipt.js";
import { expiredProof, redeem, statusFor, unreadable } from "./redeem.js";
import type { RedemptionRefusal } from "./redeem.js";
import { settleAndRecord } from "./record.js";
import { bindingRequirements, paymentRequired, quorumRequirements } from "./requirements.js";

export interface ServerDeps {
  registry: PoolRegistry;
  pools: SolvencyReader &
    Pick<PoolsClient, "recordDeposit" | "revertReasonOf" | "poolOf" | "statusOf" | "depositAt">;
  facilitator: Pick<Facilitator, "verify" | "settle" | "feePayerFor">;
  failures: FailureReporter;
  network: Network;
  /** The pool contract's Hedera account id - what a payment is addressed to. */
  payTo: string;
  contractId: string;
  publicBaseUrl: string;
  coordinatorAccountId: string;
  coordinatorAddress: string;
  /**
   * §8 step 2: the key a receipt is verified against, and the address it must match.
   *
   * Also the payment path's address lookup, because it refuses an account that cannot sign -
   * see the call site for why that refusal belongs before the money moves.
   */
  accountOf: (accountId: string) => Promise<MirrorAccount>;
  coordinatorBalanceTinybars: () => Promise<bigint>;
  /**
   * The index that resolves a transaction id to a deposit - §8 step 4, and the only fact
   * consensus state cannot answer. Optional: without it the coordinator still sells seats and
   * settles payments, and only redemption is unavailable.
   */
  index?: Pick<GraphClient, "depositFor" | "isRecorded">;
  /** Retry knobs, so a test does not wait out the backoff. */
  record?: { sleep?: (ms: number) => Promise<void>; attempts?: number; retryMs?: number };
}

export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, network: deps.network, contract: deps.contractId });
  });

  /**
   * Whether this coordinator can currently do the thing it exists to do.
   *
   * Separate from `/healthz`, and the split is the whole reason this exists. `/healthz` answers
   * from configuration and touches no network, deliberately: it is what Fly's check reads, and a
   * machine should not be replaced because the mirror node is having a bad afternoon (`fly.toml`
   * says so at the check). That also makes it structurally unable to report the one failure that
   * stops this server working - `preflight` refuses *every* settlement once the coordinator's own
   * account falls below `MIN_COORDINATOR_TINYBARS`, and nothing anywhere said so.
   *
   * It went unnoticed for a day on 2026-09-10 because both halves look right. A 402 is built from
   * chain reads that never ask whether this server can act on the offer, so an underfunded
   * coordinator advertises real pools on real terms and refuses at the moment a buyer pays - who
   * reads the refusal as the pool being closed rather than as the seller being broke.
   *
   * **Nothing routes on this endpoint.** No health check reads it, so a 503 here replaces no
   * machine and drops no request; it is a question a person or a monitor can ask, and the answer
   * is about this account rather than about this process.
   */
  app.get("/readyz", async (_req, res) => {
    const floor = MIN_COORDINATOR_TINYBARS;
    let balance: bigint;
    try {
      balance = await deps.coordinatorBalanceTinybars();
    } catch {
      // Unreadable is not underfunded, and the difference is the reader's next move: one is
      // answered by a faucet and the other by waiting. Both are reported not-ready, because a
      // coordinator that cannot see its own balance cannot promise to settle either.
      res.status(503).json({
        ok: false,
        canSettle: false,
        reason: "balance-unreadable",
        coordinator: deps.coordinatorAccountId,
        floorTinybars: floor.toString(),
      });
      return;
    }
    const canSettle = balance >= floor;
    // `coordinator-underfunded` is the same string `preflight` refuses a payment with, so the
    // reason a buyer was turned away and the reason this endpoint gives are one grep apart.
    res.status(canSettle ? 200 : 503).json({
      ok: canSettle,
      canSettle,
      ...(canSettle ? {} : { reason: "coordinator-underfunded" }),
      coordinator: deps.coordinatorAccountId,
      balanceTinybars: balance.toString(),
      floorTinybars: floor.toString(),
    });
  });

  /** What is on offer, so a reader can find a resource without reading the source. */
  app.get("/", (_req, res) => {
    res.json({
      service: "quorum402",
      network: deps.network,
      contract: deps.contractId,
      benchmarks: BENCHMARKS.map((benchmark) => ({
        slug: benchmark.slug,
        url: resourceUrlFor(deps.publicBaseUrl, benchmark.slug),
        description: describeBenchmark(benchmark),
      })),
    });
  });

  app.get("/benchmark/:slug", (req, res) => {
    // Express 4 does not catch a rejection from an async handler. Unhandled, it leaves the
    // payer waiting on a response that never comes and takes the process down with it - so
    // every request in flight pays for one request's bad luck. A 500 is a worse answer than
    // the one `handle` meant to send, and a better one than none.
    handle(deps, req, res).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`GET ${req.originalUrl} failed: ${detail}`);
      // Past settlement `handle` has already set PAYMENT-RESPONSE, and sending it with the
      // 500 is deliberate: it carries the transaction id, which is the payer's evidence that
      // their money moved even though the receipt did not survive being built.
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(500).json({ error: "the coordinator could not serve this request", detail });
    });
  });

  return app;
}

async function handle(deps: ServerDeps, req: Request, res: Response): Promise<void> {
  const slug = req.params.slug ?? "";
  const benchmark = benchmarkFor(slug);
  if (!benchmark) {
    res.status(404).json({ error: `no such benchmark "${slug}"` });
    return;
  }
  const resourceUrl = resourceUrlFor(deps.publicBaseUrl, slug);

  // §8. Checked before anything else about the request, because a payer redeeming a seat is
  // not making a payment: answering as though the header had not been sent would hand back a
  // 402 and read as "pay again", and the pool they hold a seat in is by then closed.
  const presented = req.get(QUORUM_RECEIPT_HEADER);
  if (presented) {
    await redeemSeat(deps, { presented, benchmark, resourceUrl }, res);
    return;
  }

  const selling = await deps.registry.sellingPoolFor(resourceUrl);
  const signature = req.get(PAYMENT_SIGNATURE_HEADER);

  // §6 row 1. A pool that exists but is closed is not an open pool naming this URL, so without
  // a payment in hand the answer is the same as if none had ever existed.
  if (!selling || (!selling.available && !signature)) {
    res.status(404).json({ error: `no open pool is selling ${resourceUrl}` });
    return;
  }

  const { terms } = selling;
  // Never hardcoded, and read per request rather than cached: it is the facilitator's to
  // rotate, and a stale one produces a payment that cannot settle.
  const feePayer = await deps.facilitator.feePayerFor(deps.network);
  const offer = {
    terms,
    network: deps.network,
    payTo: deps.payTo,
    feePayer,
    description: describeBenchmark(benchmark),
  };

  if (!signature) {
    res
      .status(402)
      .set(PAYMENT_REQUIRED_HEADER, encodeHeaderValue(paymentRequired(offer)))
      .json({
        error: "payment required",
        detail: describeBenchmark(benchmark),
        pool: poolSummary(terms, selling.state),
      });
    return;
  }

  const advertised: QuorumRequirements = quorumRequirements(offer);
  const validation = validateQuorumPayload({ header: signature, advertised });
  if (!validation.ok) {
    res.status(400).json({ error: "payment does not match the advertised terms", ...detail(validation) });
    return;
  }

  // §6 row 4, and §7 rule 2: the pool closed between the 402 and this payment. Caught here,
  // before anything irreversible, so the payer keeps their money.
  if (!selling.available) {
    res.status(402).json({
      error: "this pool is no longer selling",
      reason: selling.reason,
      pool: poolSummary(terms, selling.state),
    });
    return;
  }

  const transfer = inspectBindingTransfer({
    transactionBase64: validation.payload.payload.binding.transaction,
    payTo: deps.payTo,
    amount: terms.unitTinybars,
  });
  if (!transfer.ok) {
    res.status(400).json({ error: "the payment's transfer is not the one advertised", ...detail(transfer) });
    return;
  }

  // §7 rule 5, run early because `recordDeposit` needs the address and a payer it cannot
  // resolve is a deposit it could not attribute (ADR 0006).
  //
  // `accountOf` rather than `evmAddressOf`, because it also requires a key that can sign, and
  // refusing on that here is the point: a threshold-key, key-list or contract account can pay
  // perfectly well and could never produce the §8 signature that redeems what it paid for.
  // Letting the payment through would sell a seat nothing can open, and the payer would find
  // out at redemption, having already parted with the money. §11 records the limitation.
  let account: MirrorAccount;
  try {
    account = await deps.accountOf(transfer.transfer.payerAccountId);
  } catch (error) {
    // The ledger could not be read - a fact about this server, not about the payer. Still 402,
    // because §6 puts every pre-settlement refusal there and the payer's money has not moved,
    // but the upstream text stays in the log: it describes how this coordinator is wired.
    const because = error instanceof Error ? error.message : String(error);
    console.error(`payment for ${resourceUrl} could not resolve the payer: ${because}`);
    res.status(402).json({
      error: "this payment cannot be settled right now",
      detail: "the paying account could not be read from the ledger",
    });
    return;
  }
  if (!account.key) {
    res.status(402).json({
      error: "the paying account could not hold a redeemable seat",
      detail: `account ${transfer.transfer.payerAccountId} has no single key that could sign a redemption proof, so a seat bought here could never be opened`,
    });
    return;
  }
  const payer = account.evmAddress;

  const index = deps.index;
  const gate = await preflight(
    {
      contract: deps.pools,
      coordinatorAccountId: deps.coordinatorAccountId,
      coordinatorAddress: deps.coordinatorAddress,
      coordinatorBalanceTinybars: deps.coordinatorBalanceTinybars,
      // ADR 0006's replay check, and the one precondition only an index can answer: the
      // contract hashes settled transaction ids into a private set and exposes no getter.
      // What a failure to answer means is `preflight`'s rule, not this wiring's.
      isAlreadyRecorded: index ? (hederaTxId: string) => index.isRecorded(hederaTxId) : undefined,
    },
    { availability: selling, hederaTxId: transfer.transfer.transactionId },
  );
  if (!gate.ok) {
    res.status(402).json({ error: "this payment cannot be settled right now", ...detail(gate) });
    return;
  }

  const binding = bindingRequirements(offer);
  const outcome = await settleAndRecord(
    {
      facilitator: deps.facilitator,
      pools: deps.pools,
      failures: deps.failures,
      ...deps.record,
    },
    {
      request: bindingRequestFor({
        payload: validation.payload,
        resource: validation.payload.resource,
        binding,
      }),
      requirements: binding,
      poolId: terms.poolId,
      payer,
      payerAccountId: transfer.transfer.payerAccountId,
      tinybars: transfer.transfer.tinybars,
      expectedTxId: transfer.transfer.transactionId,
    },
  );

  if (!outcome.settled) {
    // §6 row 5. Nothing moved, so this is still a payment challenge rather than a failure.
    res
      .status(402)
      .set(PAYMENT_RESPONSE_HEADER, encodeHeaderValue({ success: false, errorReason: outcome.reason }))
      .json({ error: "the payment was not settled", detail: outcome.reason });
    return;
  }

  // Past here the money has moved and the request does not fail - §7 rule 6.
  const [after, state] = await Promise.all([
    deps.pools.poolOf(terms.poolId),
    deps.pools.statusOf(terms.poolId),
  ]);
  const counted = outcome.attributed ? (outcome.deposit?.counted ?? null) : null;
  const receipt = buildReceipt({
    terms: after,
    state,
    seats: after.seats,
    payer,
    transaction: outcome.hederaTxId,
    attributed: outcome.attributed,
    counted,
    contractId: deps.contractId,
  });

  // The buyer's account is deliberately absent from PAYMENT-RESPONSE. In this binding `payer`
  // means the fee payer, and putting the buyer there would be a lie told in the protocol's own
  // vocabulary. Attribution lives in the receipt, where it is unambiguous.
  res.set(
    PAYMENT_RESPONSE_HEADER,
    encodeHeaderValue({ success: true, transaction: outcome.hederaTxId, network: deps.network }),
  );

  // §6 row 7: settled, and *this* payment met the threshold. The pool reaches `Met` exactly
  // when the last seat is taken, so a counted deposit into a now-met pool is the one that did
  // it. Delivery is on the threshold, never on the seller having been paid - §6.
  if (counted === true && after.seats >= after.threshold) {
    res.status(200).json({
      ...licence({
        benchmark,
        contributors: after.seats,
        minimumContributors: after.threshold,
        licensee: transfer.transfer.payerAccountId,
        poolId: after.poolId.toString(),
        settledUnder: outcome.hederaTxId,
      }),
      receipt,
    });
    return;
  }

  // §6 row 6, and the row that only exists because of `conditional`: the payment is real, the
  // resource is not owed yet, and may never be.
  res.status(202).json(receipt);
}

/**
 * Redeem a seat - `quorum-scheme.md` §8, and the last five rows of §6's table.
 *
 * No funds move, no facilitator is involved and nothing is written down. What the payer presents
 * is a signature over facts already on chain, and every refusal below is a fact about the chain
 * rather than about this server's memory - which is what lets a restart, or a second coordinator,
 * answer the same question the same way.
 */
async function redeemSeat(
  deps: ServerDeps,
  request: { presented: string; benchmark: Benchmark; resourceUrl: string },
  res: Response,
): Promise<void> {
  const { presented, benchmark, resourceUrl } = request;

  // Redemption cannot be done without the log: the transaction id a payment settled under is
  // emitted, never stored (§8 step 4). A build with no index wired says so rather than
  // answering 401 to receipts that are perfectly good.
  if (!deps.index) {
    res.status(501).json({
      error: "redemption is not available on this build",
      detail: `${QUORUM_RECEIPT_HEADER} needs an index to resolve a transaction id to a deposit. Set SUBGRAPH_URL.`,
    });
    return;
  }

  const receipt = decodeRedemptionReceipt(presented);
  if (!receipt) {
    res.status(401).json({
      error: "receipt is not a valid proof",
      detail: `${QUORUM_RECEIPT_HEADER} must be base64 JSON with accountId, poolId, transaction, validUntil and signature`,
    });
    return;
  }

  // §8 rule 1, before any read. `redeem` checks it again and cannot rely on this one, but every
  // check below costs paid contract queries, and a receipt that is out of date should cost none
  // of them - it is the cheapest request to send and would otherwise be the dearest to answer.
  const stale = expiredProof(receipt);
  if (stale) {
    refuse(res, resourceUrl, stale);
    return;
  }

  // The pool must be one that sold this URL. `sellingPoolFor` is no help here and would be
  // wrong: by the time a seat is worth redeeming the pool has stopped selling, which is the
  // normal case rather than an error.
  let pools: bigint[];
  try {
    pools = await deps.registry.poolsFor(resourceUrl);
  } catch (error) {
    refuse(res, resourceUrl, unreadable("the pools for this resource could not be read", error));
    return;
  }
  const claimed = pools.find((poolId) => poolId.toString() === receipt.poolId);
  if (claimed === undefined) {
    // Same answer as a bad signature, and deliberately: a receipt naming a pool that never sold
    // this URL is a claim about the wrong thing, and distinguishing it here would say which
    // pools exist to anyone who asks.
    res.status(401).json({ error: "receipt is not a valid proof for this resource" });
    return;
  }

  let availability: PoolAvailability;
  try {
    availability = await deps.registry.availability(claimed);
  } catch (error) {
    refuse(res, resourceUrl, unreadable("the pool's state could not be read", error));
    return;
  }
  const { terms, state } = availability;
  const index = deps.index;
  const outcome = await redeem(
    {
      network: deps.network,
      contractId: deps.contractId,
      accountOf: deps.accountOf,
      depositFor: (poolId, hederaTxId) => index.depositFor(poolId, hederaTxId),
      depositAt: (poolId, depositId) => deps.pools.depositAt(poolId, depositId),
    },
    { receipt, resourceUrl, terms, state },
  );

  if (outcome.ok) {
    // The same licence the 200 on the payment path serves. A seat is a seat however it is
    // presented, and a redemption that returned something different would make the receipt a
    // second-class way to hold one.
    res.status(200).json(
      licence({
        benchmark,
        contributors: terms.seats,
        minimumContributors: terms.threshold,
        licensee: receipt.accountId,
        poolId: terms.poolId.toString(),
        settledUnder: receipt.transaction,
      }),
    );
    return;
  }

  refuse(res, resourceUrl, outcome, { terms, state });
}

/**
 * One refusal, one response - §6's rows for redemption, in one place.
 *
 * Every refusal on this path comes through here, including the ones raised before the pool is
 * known: `statusFor` owns the status, so a read that fails in the handler and one that fails
 * inside `redeem` cannot answer differently, and a row that gains a header or a body field
 * gains it once.
 *
 * A **503** carries `Retry-After`, because unlike every other refusal here, trying again really
 * is the right thing for this payer to do - and its `cause` is logged and never sent. That text
 * describes how this coordinator is wired; the payer can act on none of it, and a refusal is a
 * poor place to publish it.
 */
function refuse(
  res: Response,
  resourceUrl: string,
  refusal: RedemptionRefusal,
  pool?: { terms: PoolTerms; state: PoolState },
): void {
  const body: Record<string, unknown> = { error: refusal.reason, detail: refusal.detail };
  // §9 keeps reversal off this server, so a refusal that means "your money is owed back" says
  // where to get it without this server being involved in the getting.
  if (refusal.reason === "no-seat" || refusal.reason === "pool-expired") body.reclaim = refusal.reclaim;
  if (refusal.reason === "still-filling" && pool) body.pool = poolSummary(pool.terms, pool.state);
  if (refusal.reason === "no-such-deposit" && refusal.indexedBlock !== undefined) {
    body.indexedBlock = refusal.indexedBlock.toString();
  }
  if (refusal.reason === "index-unavailable") {
    console.error(`redemption for ${resourceUrl} could not be decided: ${refusal.detail} - ${refusal.cause}`);
    res.set("Retry-After", "5");
  }
  res.status(statusFor(refusal)).json(body);
}

/**
 * The pool as a payer is told about it - `quorum-scheme.md` §3's `extra`, in JSON.
 *
 * Exported because the demo UI renders the same six facts and inventing a second shape for them
 * would let the two drift: what the page shows a buyer and what a 402 tells them would then be
 * different objects describing the same pool.
 */
export function poolSummary(terms: PoolTerms, state: PoolState) {
  return {
    poolId: terms.poolId.toString(),
    state,
    filled: terms.seats,
    threshold: terms.threshold,
    deadline: terms.deadline,
    unitTinybars: terms.unitTinybars.toString(),
  };
}

function detail(rejection: { reason: string; detail: string }) {
  return { reason: rejection.reason, detail: rejection.detail };
}

/**
 * Everything a coordinator needs, built from configuration.
 *
 * Separate from `main` so that a second entry point - the demo UI, which mounts this app beside
 * its own routes - stands the coordinator up **the same way** rather than assembling a lookalike
 * from the same parts. A dependency wired twice is a dependency that can be wired differently,
 * and the failures that produces (a different `publicBaseUrl`, a missing index) are the ones that
 * look like protocol bugs.
 *
 * Hands back the pieces it built rather than only the app: a caller doing more than serving
 * requests needs the contract client and the config, and reaching them through `deps` would mean
 * widening `ServerDeps` to suit a caller the coordinator does not have.
 */
export interface Coordinator {
  deps: ServerDeps;
  pools: PoolsClient;
  /**
   * The index, whole.
   *
   * `ServerDeps.index` is deliberately narrowed to the two methods serving a request needs, so
   * that a test can inject a pair of stubs. A second entry point listing a payer's own seats
   * needs `depositsFor` as well, and reaching it by widening that `Pick` would make every stub
   * implement a method the coordinator itself never calls. Handing back the client this function
   * built costs nothing and keeps the narrow type honest.
   */
  index?: GraphClient;
  cfg: Config;
  contractId: string;
}

export async function wireCoordinator(): Promise<Coordinator> {
  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const deployment = readDeployment(network);
  if (!deployment) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(deployment.contractId));
  const coordinatorAddress = await evmAddressOf(cfg.mirrorUrl, cfg.operatorId);
  const index = cfg.subgraphUrl ? new GraphClient({ url: cfg.subgraphUrl }) : undefined;

  return {
    cfg,
    pools,
    index,
    contractId: deployment.contractId,
    deps: {
      registry: new PoolRegistry(pools),
      pools,
      facilitator: new Facilitator(cfg.facilitatorUrl),
      failures: new FailureReporter({ webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() }),
      network,
      payTo: deployment.contractId,
      contractId: deployment.contractId,
      publicBaseUrl: cfg.publicBaseUrl,
      coordinatorAccountId: cfg.operatorId,
      coordinatorAddress,
      accountOf: (accountId) => accountOf(cfg.mirrorUrl, accountId),
      coordinatorBalanceTinybars: () => balanceTinybars(cfg.mirrorUrl, cfg.operatorId),
      index,
    },
  };
}

/**
 * What the process says about itself on startup.
 *
 * Exported for the same reason the wiring is: a second entry point that printed a different
 * banner would be a second account of how this coordinator is configured, and the line about the
 * index being absent is the one worth never losing.
 */
export function describeCoordinator(coordinator: Coordinator): string[] {
  const { cfg, deps, contractId } = coordinator;
  return [
    `  listening    http://localhost:${cfg.port}`,
    `  public url   ${cfg.publicBaseUrl}`,
    `  contract     ${contractId}`,
    `  coordinator  ${cfg.operatorId}  ${deps.coordinatorAddress}`,
    `  facilitator  ${cfg.facilitatorUrl}`,
    // Said out loud either way: a coordinator that silently cannot redeem looks identical to
    // one that can, right up until a payer with a met pool presents a receipt.
    cfg.subgraphUrl
      ? `  index        ${cfg.subgraphUrl}`
      : `  index        (none - SUBGRAPH_URL unset, so redemption answers 501)`,
    ...BENCHMARKS.map(
      (benchmark) => `  selling      ${resourceUrlFor(cfg.publicBaseUrl, benchmark.slug)}`,
    ),
  ];
}

/** Build the real thing from configuration, and listen. */
async function main(): Promise<void> {
  const coordinator = await wireCoordinator();
  const { cfg, deps } = coordinator;
  const app = createApp(deps);

  app.listen(cfg.port, () => {
    console.log(`\nquorum402 coordinator on ${deps.network}\n`);
    for (const line of describeCoordinator(coordinator)) console.log(line);
    console.log();
  });
}

// Only when run directly. Importing this module for `createApp` - which the tests do - must
// not start a listener.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
