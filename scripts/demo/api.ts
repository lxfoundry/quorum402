/**
 * The demo's control plane: the clicks a seller and three buyers make, as HTTP.
 *
 * 🔴 **This router signs with the buyers' private keys and must never be exposed.** `npm run
 * server` does not mount it; only `npm run demo` does, and that is meant to run on the machine
 * doing the demonstrating. Publishing it would publish the ability to spend four funded accounts,
 * and - because a pool takes one seat per address - would let a passer-by consume the demo.
 *
 * Nothing here reimplements the protocol. Buying calls the same `buySeat` the CLI calls, against
 * the same coordinator, and gets the same 402 → 202 → 200 back; redeeming calls the same
 * `redeemSeat`. What this adds is a way to press the buttons in a browser, and a record of what
 * each press said on the wire.
 *
 * The division of reads is the coordinator's own: the **index** says which pools a payer is in
 * and under what transaction id - facts the contract does not keep - and the **chain** says what
 * a pool is doing now, because the index lags and lazy expiry means it lags in a way that
 * matters.
 */
import express from "express";
import type { Request, Response, Router } from "express";
import { AccountId, Client, ContractId } from "@hiero-ledger/sdk";
import {
  BENCHMARKS,
  benchmarkFor,
  describe as describeBenchmark,
  resourceUrlFor,
} from "../../src/benchmark/catalogue.js";
import { buySeat, redeemSeat } from "../../src/buyer/agent.js";
import type { IndexedDeposit, IndexedPool } from "../../src/graph/client.js";
import {
  hashscanAccount,
  hashscanContract,
  hashscanTransaction,
} from "../../src/hedera/explorer.js";
import { balanceTinybars } from "../../src/hedera/mirror.js";
import { PoolsClient } from "../../src/pool/client.js";
import { poolSummary } from "../../src/server/index.js";
import type { Coordinator } from "../../src/server/index.js";
import type { PoolAvailability } from "../../src/server/pools.js";
import type { Receipt } from "../../src/server/receipt.js";
import { hbarToTinybars, tinybarsToHbar } from "../../src/x402/hedera-exact.js";
import { ProtocolLog } from "./log.js";
import { mergeSeats } from "./seats.js";
import type { LivePool, SeatRow } from "./seats.js";
import { SeatMemory, Wallets } from "./wallets.js";

/**
 * What the seller may choose, offered as fixed options rather than typed in.
 *
 * Not only to save time on camera. Every one of these is a value the contract or the catalogue
 * constrains - a deadline in the past is refused, a threshold below the suppression floor is
 * refused - and a list the server also validates against cannot express a pool that would be.
 */
const TTL_CHOICES = [
  { seconds: 900, label: "15 minutes" },
  { seconds: 300, label: "5 minutes" },
  // Short enough to sit out on camera. The coordinator stops selling 30s before a deadline
  // (`SELLING_STOPS_SECONDS_BEFORE_DEADLINE`), so this pool sells for its first minute only.
  { seconds: 90, label: "90 seconds - for the refund demo" },
] as const;

const SEAT_HBAR_CHOICES = [
  { hbar: "1", label: "1 ℏ - list price" },
  { hbar: "0.1", label: "0.1 ℏ - cheap run" },
] as const;

/** How long a chain read is reused. One poll's worth, so a 4s page poll costs one read. */
const POOL_CACHE_MS = 3_000;
/** Balances move only when someone pays, and the mirror node is shared infrastructure. */
const BALANCE_CACHE_MS = 4_000;

export interface DemoContext {
  coordinator: Coordinator;
  wallets: Wallets;
  memory: SeatMemory;
  log: ProtocolLog;
}

export function demoApi(ctx: DemoContext): Router {
  const router = express.Router();
  router.use(express.json());

  const pools = new PoolStatusCache(ctx);
  const balances = new BalanceCache(ctx);

  router.get("/api/state", handle(async (req, res) => {
    const label = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    res.json(await stateFor(ctx, pools, balances, label));
  }));

  router.post("/api/pool", handle(async (req, res) => {
    res.json(await openPool(ctx, req.body as OpenPoolBody));
  }));

  router.post("/api/buy", handle(async (req, res) => {
    res.json(await buy(ctx, req.body as { wallet: string; slug: string }));
  }));

  router.post("/api/redeem", handle(async (req, res) => {
    res.json(await redeem(ctx, pools, req.body as { wallet: string; poolId: string }));
  }));

  router.post("/api/refund", handle(async (req, res) => {
    res.json(await refund(ctx, req.body as { wallet: string; poolId: string }));
  }));

  router.post("/api/release", handle(async (req, res) => {
    res.json(await release(ctx, req.body as { poolId: string }));
  }));

  return router;
}

/**
 * One error path for every route.
 *
 * Express 4 does not catch a rejection from an async handler, and an uncaught one here takes the
 * demo down mid-recording. The coordinator makes the same provision for the same reason.
 */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${req.method} ${req.originalUrl} failed: ${detail}`);
      if (!res.headersSent) res.status(500).json({ error: detail });
    });
  };
}

// ---------------------------------------------------------------------------- reading the world

async function stateFor(
  ctx: DemoContext,
  pools: PoolStatusCache,
  balances: BalanceCache,
  label: string | undefined,
): Promise<unknown> {
  const { cfg, deps, contractId } = ctx.coordinator;
  const wallet = label ? ctx.wallets.find(label) : undefined;
  const now = Math.floor(Date.now() / 1000);

  const [services, held, seats] = await Promise.all([
    servicesFor(ctx, pools, now),
    balances.all(),
    wallet ? seatsFor(ctx, pools, wallet.evmAddress, wallet.label, now) : Promise.resolve([]),
  ]);

  return {
    network: deps.network,
    contract: contractId,
    contractUrl: hashscanContract(deps.network, contractId),
    facilitator: cfg.facilitatorUrl,
    subgraph: cfg.subgraphUrl,
    publicBaseUrl: cfg.publicBaseUrl,
    wallets: ctx.wallets.all().map((w) => ({
      ...w,
      accountUrl: hashscanAccount(deps.network, w.accountId),
      hbar: tinybarsToHbar(held.get(w.accountId) ?? 0n),
    })),
    choices: { ttl: TTL_CHOICES, seatHbar: SEAT_HBAR_CHOICES },
    services,
    seats: seats.map((seat) => withLinks(deps.network, seat)),
    log: ctx.log.tail(),
  };
}

/**
 * One card per benchmark, showing **the pool a payment would actually land in**.
 *
 * `sellingPoolFor`, not the newest pool, because that is the resolution the coordinator itself
 * makes: where several pools name a resource the earliest one still selling wins. Showing any
 * other pool would put a price and a seat count next to a Pay button that funds a different one.
 */
async function servicesFor(ctx: DemoContext, cache: PoolStatusCache, now: number) {
  const { cfg } = ctx.coordinator;
  return Promise.all(
    BENCHMARKS.map(async (benchmark) => {
      const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, benchmark.slug);
      const selling = await cache.advertised(resourceUrl);
      return {
        slug: benchmark.slug,
        id: benchmark.id,
        cut: benchmark.cut,
        description: describeBenchmark(benchmark),
        minimumContributors: benchmark.minimumContributors,
        unitPrice: benchmark.unitPrice,
        resourceUrl,
        thresholds: [benchmark.minimumContributors, benchmark.minimumContributors + 1],
        pool: selling ? poolCard(selling, now) : undefined,
      };
    }),
  );
}

/**
 * A pool as a buyer is shown it - the six facts a 402 carries, plus the clock.
 *
 * Literally the six a 402 carries: `poolSummary` is the coordinator's own `extra`, reused rather
 * than rewritten, so what the page shows and what the challenge says cannot drift into two
 * accounts of one pool. Everything added here is presentation the wire has no use for.
 */
function poolCard(availability: PoolAvailability, now: number) {
  const { terms } = availability;
  return {
    ...poolSummary(terms, availability.state),
    storedState: terms.state,
    secondsLeft: Math.max(0, terms.deadline - now),
    seatHbar: tinybarsToHbar(terms.unitTinybars),
    available: availability.available,
    reason: availability.available ? undefined : availability.reason,
  };
}

/**
 * A payer's own seats: which pools they are in, and what each one now permits.
 *
 * The index is asked once for the whole list. Then the chain is asked about only the pools that
 * survive the filter and could still change - a `Released` pool cannot, and neither can one
 * already stamped `Expired`.
 */
async function seatsFor(
  ctx: DemoContext,
  cache: PoolStatusCache,
  evmAddress: string,
  label: string,
  now: number,
): Promise<SeatRow[]> {
  const { cfg } = ctx.coordinator;
  const sells = new Map(
    BENCHMARKS.map((b) => [resourceUrlFor(cfg.publicBaseUrl, b.slug), b.slug] as const),
  );
  const remembered = ctx.memory.forWallet(label);

  let indexed: IndexedDeposit[] = [];
  const index = ctx.coordinator.index;
  if (index) {
    try {
      indexed = (await index.depositsFor(evmAddress)).deposits;
    } catch (error) {
      // The index being down must not blank the screen: what this process watched happen is
      // still true, and a payer mid-demo would rather see their seat un-redeemable than gone.
      console.error(`the index could not list deposits for ${evmAddress}: ${String(error)}`);
    }
  }

  const relevant = [...remembered.map((s) => s.pool), ...indexed.map((d) => d.pool)].filter((p) =>
    sells.has(p.resourceUrl),
  );
  const live = await cache.livePools(relevant);
  return mergeSeats({ indexed, remembered, sells, live, now });
}

/** Explorer links, added last so nothing above has to carry a network around. */
function withLinks(network: string, seat: SeatRow) {
  return {
    ...seat,
    seatHbar: tinybarsToHbar(BigInt(seat.unitTinybars)),
    transactionUrl: hashscanTransaction(network, seat.transaction),
  };
}

// -------------------------------------------------------------------------------------- actions

interface OpenPoolBody {
  slug: string;
  threshold: number;
  seatHbar: string;
  ttlSeconds: number;
}

/**
 * The seller's one action. ADR 0003: opening a pool goes nowhere near the resource server, which
 * finds out a pool exists by reading the chain like anybody else.
 */
async function openPool(ctx: DemoContext, body: OpenPoolBody) {
  const { cfg, deps, pools, contractId } = ctx.coordinator;
  const benchmark = benchmarkFor(body.slug);
  if (!benchmark) throw new Error(`no benchmark "${body.slug}"`);

  const threshold = Number(body.threshold);
  if (!Number.isInteger(threshold) || threshold < benchmark.minimumContributors) {
    // The same refusal `open-pool` makes, and for the catalogue's reason rather than the UI's:
    // below the floor, publishing the aggregate discloses an individual contributor.
    throw new Error(
      `${benchmark.slug} may not be published to fewer than ${benchmark.minimumContributors} distinct buyers`,
    );
  }
  if (!SEAT_HBAR_CHOICES.some((c) => c.hbar === body.seatHbar)) {
    throw new Error(`seat price "${body.seatHbar}" is not one of the offered prices`);
  }
  const ttl = TTL_CHOICES.find((c) => c.seconds === Number(body.ttlSeconds));
  if (!ttl) throw new Error(`deadline "${body.ttlSeconds}" is not one of the offered deadlines`);

  const seller = ctx.wallets.all().find((w) => w.role === "seller");
  if (!seller) throw new Error("no wallet labelled seller in .accounts.json");

  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, benchmark.slug);
  const deadline = Math.floor(Date.now() / 1000) + ttl.seconds;
  const created = await pools.createPool({
    recipient: seller.evmAddress,
    coordinator: deps.coordinatorAddress,
    unitTinybars: hbarToTinybars(body.seatHbar),
    threshold,
    deadline,
    resourceUrl,
  });

  ctx.log.chain(
    `createPool(${benchmark.slug}, ${threshold} seats, ${body.seatHbar} ℏ) -> pool ${created.poolId}`,
    seller.label,
  );

  return {
    poolId: created.poolId.toString(),
    transaction: created.transactionId,
    transactionUrl: hashscanTransaction(deps.network, created.transactionId),
    deadline,
    resourceUrl,
    contract: contractId,
  };
}

/**
 * One buyer answering the 402.
 *
 * The whole exchange happens inside `buySeat`: a bare GET that comes back 402, then the same GET
 * carrying a payment. Which pool the money lands in is the coordinator's to decide and is never
 * sent from here - `quorum` puts the pool id in the *challenge*, not in the request.
 */
async function buy(ctx: DemoContext, body: { wallet: string; slug: string }) {
  const { cfg, deps } = ctx.coordinator;
  const benchmark = benchmarkFor(body.slug);
  if (!benchmark) throw new Error(`no benchmark "${body.slug}"`);
  const wallet = ctx.wallets.signing(body.wallet);
  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, benchmark.slug);

  ctx.log.request(wallet.label, `GET /benchmark/${benchmark.slug}`);

  // No operator: the transfer's transaction id belongs to the facilitator and the buyer only
  // partially signs it, which is what `exact` on Hedera means. `buy-seat` does the same.
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  try {
    const result = await buySeat({
      client,
      resourceUrl,
      payerId: wallet.accountId,
      payerKey: wallet.key,
    });

    const offered = result.offered?.accepts.find((entry) => entry.scheme === "quorum");
    if (offered) {
      const extra = offered.extra as { poolId?: string; threshold?: number; filled?: number };
      ctx.log.response(
        402,
        `PAYMENT-REQUIRED  scheme=quorum  pool ${extra.poolId}  ${extra.filled ?? "?"}/${extra.threshold} seats  ${tinybarsToHbar(BigInt(offered.amount))} ℏ`,
      );
      ctx.log.request(wallet.label, `GET /benchmark/${benchmark.slug}  + PAYMENT-SIGNATURE`);
    }

    if (result.status === 202 || result.status === 200) {
      const receipt = receiptOf(result.body);
      if (receipt) {
        ctx.memory.remember({
          wallet: wallet.label,
          transaction: receipt.transaction,
          seat: receipt.seat,
          counted: receipt.counted,
          pool: poolFromReceipt(receipt, resourceUrl),
          at: Date.now(),
        });
        ctx.log.response(
          result.status,
          result.status === 200
            ? `OK  seat ${receipt.seat} of ${receipt.threshold} - the crowd is complete, licence served`
            : `settled ${receipt.transaction}  seat ${receipt.seat} of ${receipt.threshold} - resource still owed`,
        );
      }
    } else {
      ctx.log.response(result.status, detailOf(result.body));
    }

    return {
      status: result.status,
      body: result.body,
      transactionUrl: transactionUrlOf(deps.network, result.body),
    };
  } finally {
    client.close();
  }
}

/**
 * Present the receipt from the payment step, and get the resource.
 *
 * The pool and the settlement come from what this payer already holds - §8 asks them to present
 * both - rather than from a lookup. Nothing is bought here and nothing moves.
 */
async function redeem(
  ctx: DemoContext,
  cache: PoolStatusCache,
  body: { wallet: string; poolId: string },
) {
  const { cfg, deps, contractId } = ctx.coordinator;
  const wallet = ctx.wallets.signing(body.wallet);
  const now = Math.floor(Date.now() / 1000);
  const seats = await seatsFor(ctx, cache, wallet.evmAddress, wallet.label, now);
  const seat = seats.find((s) => s.poolId === String(body.poolId));
  if (!seat) throw new Error(`${wallet.label} holds no seat in pool ${body.poolId}`);

  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, seat.slug);
  ctx.log.request(wallet.label, `GET /benchmark/${seat.slug}  + QUORUM-RECEIPT (pool ${seat.poolId})`);

  const result = await redeemSeat({
    resourceUrl,
    accountId: wallet.accountId,
    key: wallet.key,
    network: deps.network,
    contractId,
    poolId: seat.poolId,
    transaction: seat.transaction,
  });

  ctx.log.response(
    result.status,
    result.status === 200
      ? `OK  licence released against the receipt from the payment step`
      : detailOf(result.body),
  );

  return { status: result.status, body: result.body, transaction: seat.transaction };
}

/**
 * Take the money back, as the payer, through a client of the payer's own.
 *
 * `claimRefund` matches on `msg.sender`, so this needs a second Hedera client whose operator is
 * the buyer. That is not a workaround - `quorum-scheme.md` §9 puts reversal outside the
 * coordinator precisely so that being repaid never depends on the liveness of the party whose
 * failure you most need protection from, and using the coordinator's client would quietly
 * demonstrate the opposite.
 *
 * It stamps the pool expired on the way if the deadline has passed, so nobody has to have called
 * `expire` first.
 */
async function refund(ctx: DemoContext, body: { wallet: string; poolId: string }) {
  const { cfg, deps, contractId } = ctx.coordinator;
  const wallet = ctx.wallets.signing(body.wallet);
  const poolId = BigInt(body.poolId);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(AccountId.fromString(wallet.accountId), wallet.key);
  try {
    ctx.log.chain(`claimRefund(${poolId})  contract ${contractId} - the coordinator is not involved`, wallet.label);
    const claimed = await new PoolsClient(client, ContractId.fromString(contractId)).claimRefund(poolId);
    ctx.log.chain(`refunded ${tinybarsToHbar(claimed.tinybars)} ℏ to ${wallet.accountId}`, wallet.label);
    return {
      poolId: body.poolId,
      tinybars: claimed.tinybars.toString(),
      hbar: tinybarsToHbar(claimed.tinybars),
      transaction: claimed.transactionId,
      transactionUrl: hashscanTransaction(deps.network, claimed.transactionId),
    };
  } finally {
    client.close();
  }
}

/** Pay a met pool out to its recipient. Permissionless: this client calls it, but anyone could. */
async function release(ctx: DemoContext, body: { poolId: string }) {
  const { deps, pools } = ctx.coordinator;
  const poolId = BigInt(body.poolId);
  const done = await pools.release(poolId);
  ctx.log.chain(`release(${poolId}) - the seller is paid; anyone could have called this`);
  return {
    poolId: body.poolId,
    transaction: done.transactionId,
    transactionUrl: hashscanTransaction(deps.network, done.transactionId),
  };
}

// -------------------------------------------------------------------------------------- caching

/**
 * Chain reads, reused for a poll's worth.
 *
 * A contract query costs a fee, so a page polling every few seconds must not turn into a query
 * per second per pool. Two bounds: a short TTL, and terminal states cached for good - a
 * `Released` pool cannot change again, and neither can an `Expired` one.
 */
class PoolStatusCache {
  private readonly advertisedByUrl = new Map<
    string,
    { at: number; value: PoolAvailability | undefined }
  >();
  private readonly liveById = new Map<string, { at: number; terminal: boolean; value: LivePool }>();

  constructor(private readonly ctx: DemoContext) {}

  async advertised(resourceUrl: string): Promise<PoolAvailability | undefined> {
    const hit = this.advertisedByUrl.get(resourceUrl);
    if (hit && Date.now() - hit.at < POOL_CACHE_MS) return hit.value;

    // Kept as the registry returned it. Flattening `available` into "the reason is undefined"
    // would mean decoding it again at the render site, and a boolean round-tripped through a
    // string is one more thing that can be got backwards.
    const value = await this.ctx.coordinator.deps.registry.sellingPoolFor(resourceUrl);
    this.advertisedByUrl.set(resourceUrl, { at: Date.now(), value });
    return value;
  }

  /** What the chain says about each pool given, keyed by pool id. */
  async livePools(candidates: IndexedPool[]): Promise<Map<string, LivePool>> {
    const wanted = [...new Set(candidates.map((p) => p.poolId))];
    const live = new Map<string, LivePool>();
    await Promise.all(
      wanted.map(async (poolId) => {
        const value = await this.live(poolId);
        if (value) live.set(poolId, value);
      }),
    );
    return live;
  }

  private async live(poolId: string): Promise<LivePool | undefined> {
    const hit = this.liveById.get(poolId);
    if (hit && (hit.terminal || Date.now() - hit.at < POOL_CACHE_MS)) return hit.value;

    try {
      const availability = await this.ctx.coordinator.deps.registry.availability(BigInt(poolId));
      // The **stored** state, so lazy expiry stays visible: `seats.ts` resolves it against the
      // deadline, and handing it the already-resolved one would hide the disagreement.
      const value: LivePool = {
        state: availability.terms.state,
        seats: availability.terms.seats,
      };
      // Terminal is judged on the **stored** state, not the lazily-resolved one. A pool past its
      // deadline that nobody has stamped answers `Expired` from `statusOf` while its storage
      // still says `Open`, and freezing it there would keep reporting it unstamped after a
      // refund had stamped it. Once storage agrees, nothing can move it again.
      const terminal =
        availability.terms.state === "Released" || availability.terms.state === "Expired";
      this.liveById.set(poolId, { at: Date.now(), terminal, value });
      return value;
    } catch (error) {
      // A read that failed is not a fact about the pool. Fall back to whatever the index said.
      console.error(`pool ${poolId} could not be read: ${String(error)}`);
      return hit?.value;
    }
  }
}

/** Mirror-node balances. Free, but shared infrastructure, so not once per second. */
class BalanceCache {
  private at = 0;
  private value = new Map<string, bigint>();

  constructor(private readonly ctx: DemoContext) {}

  async all(): Promise<Map<string, bigint>> {
    if (Date.now() - this.at < BALANCE_CACHE_MS && this.value.size > 0) return this.value;
    const { cfg } = this.ctx.coordinator;
    const wallets = this.ctx.wallets.all();
    const balances = await Promise.all(
      wallets.map(async (w) => {
        try {
          return [w.accountId, await balanceTinybars(cfg.mirrorUrl, w.accountId)] as const;
        } catch {
          // A balance is decoration. Losing one must not cost the page its wallet list.
          return [w.accountId, this.value.get(w.accountId) ?? 0n] as const;
        }
      }),
    );
    this.value = new Map(balances);
    this.at = Date.now();
    return this.value;
  }
}

// --------------------------------------------------------------------------------------- shapes

function receiptOf(body: unknown): Receipt | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  // A 200 carries the licence with the receipt nested inside it; a 202 is the receipt itself.
  const candidate = "receipt" in body ? (body as { receipt: unknown }).receipt : body;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return "poolId" in candidate && "transaction" in candidate ? (candidate as Receipt) : undefined;
}

/** The pool as the receipt describes it, in the shape the index would have returned. */
function poolFromReceipt(receipt: Receipt, resourceUrl: string): IndexedPool {
  return {
    poolId: receipt.poolId,
    state: receipt.pool.state,
    seats: receipt.pool.filled,
    threshold: receipt.threshold,
    deadline: receipt.deadline,
    // The receipt does not carry the unit price, and it does not need to: the page reads the
    // seat price off the service card, and a refund reports the amount the contract returned.
    unitTinybars: 0n,
    resourceUrl,
  };
}

function transactionUrlOf(network: string, body: unknown): string | undefined {
  const receipt = receiptOf(body);
  return receipt ? hashscanTransaction(network, receipt.transaction) : undefined;
}

function detailOf(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const { error, detail } = body as { error?: unknown; detail?: unknown };
  return [error, detail].filter((part) => typeof part === "string").join("  ");
}

