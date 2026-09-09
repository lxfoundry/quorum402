/**
 * Which pool a request is about, and whether that pool can still take a payment.
 *
 * The coordinator keeps no database (`quorum-scheme.md` §8), so this is the whole of its
 * "state": a lookup from resource URL to pool id, derived from the contract and cached.
 * A restart loses nothing but the cache.
 */
import type { PoolState, PoolTerms } from "../pool/client.js";

/**
 * What this module needs from the contract. Narrower than `PoolsClient` on purpose - it is
 * three read-only calls, and a test should not have to stand up a Hedera client to exercise
 * the resolution rules.
 */
export interface PoolReader {
  poolCount(): Promise<bigint>;
  poolOf(poolId: bigint): Promise<PoolTerms>;
  statusOf(poolId: bigint): Promise<PoolState>;
}

/**
 * How long before a pool's deadline the coordinator stops selling seats.
 *
 * [ADR 0004](../../specs/adr/0004-deposits-that-cannot-be-refused.md) names this as the
 * mitigation for its own limitation - the contract judges lateness by when the deposit is
 * *recorded*, not when the payment reached consensus, so a buyer who pays in time and is
 * attributed late gets a refund instead of a seat - and leaves it to the resource server.
 * [ADR 0006](../../specs/adr/0006-nothing-settles-until-recording-can-succeed.md) §2 puts it
 * here.
 *
 * It has to cover a facilitator round trip plus a contract call, both against a network with
 * ~3-second finality. Thirty seconds is generous for that and cheap: it costs the last half
 * minute of a pool's selling window, and buys back the seats that window would have sold and
 * not delivered.
 */
export const SELLING_STOPS_SECONDS_BEFORE_DEADLINE = 30;

/** Why a pool cannot take a payment right now. */
export type UnavailableReason =
  /** Threshold met, expired, or already released - `statusOf` says it is not `Open`. */
  | "closed"
  /** Still `Open` in storage, but the deadline is behind us. Nobody has stamped it yet. */
  | "deadline-passed"
  /** Open and in time, but inside the guard interval above. */
  | "closing";

export type PoolAvailability =
  | { available: true; terms: PoolTerms; state: PoolState }
  | { available: false; terms: PoolTerms; state: PoolState; reason: UnavailableReason };

export interface PoolRegistryOptions {
  /** Unix seconds. Injectable so deadline behaviour can be tested without waiting for one. */
  now?: () => number;
  guardSeconds?: number;
}

export class PoolRegistry {
  private readonly now: () => number;
  private readonly guardSeconds: number;

  /**
   * Resource URL to the pools that named it, earliest first.
   *
   * Safe to keep forever. `_pools` is append-only and a pool's `resourceUrl` is written once
   * at creation and never again, so an entry here cannot go stale - only incomplete, which
   * the scan below fixes by reading forward from where it stopped.
   */
  private readonly byUrl = new Map<string, bigint[]>();
  private scanned = 0n;
  /** The scan currently reading forward, so concurrent callers join it rather than repeat it. */
  private scanning: Promise<void> | undefined;

  constructor(
    private readonly reader: PoolReader,
    options: PoolRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.guardSeconds = options.guardSeconds ?? SELLING_STOPS_SECONDS_BEFORE_DEADLINE;
  }

  /**
   * Every pool that names this URL, earliest first.
   *
   * The contract does not stop two pools naming the same resource, so this returns all of
   * them rather than pretending the mapping is one-to-one.
   */
  async poolsFor(resourceUrl: string): Promise<bigint[]> {
    await this.scan();
    return this.byUrl.get(resourceUrl) ?? [];
  }

  /**
   * The pool a 402 should advertise for this URL, or `undefined` if none can take a payment.
   *
   * Where several pools name the URL, the earliest one that is still selling wins - so a
   * second pool created over the same resource takes over only once the first stops, and the
   * choice does not depend on when the question is asked.
   */
  async sellingPoolFor(resourceUrl: string): Promise<PoolAvailability | undefined> {
    let firstSeen: PoolAvailability | undefined;
    for (const poolId of await this.poolsFor(resourceUrl)) {
      const availability = await this.availability(poolId);
      if (availability.available) return availability;
      firstSeen ??= availability;
    }
    // Nothing is selling. Hand back the earliest match anyway when there was one: the caller
    // answers 404 for "no pool names this URL" and something else for "this pool is closed",
    // and it cannot tell those apart from `undefined`.
    return firstSeen;
  }

  /** Whether this pool can take a payment now, and if not, why not. */
  async availability(poolId: bigint): Promise<PoolAvailability> {
    const [terms, state] = await Promise.all([
      this.reader.poolOf(poolId),
      this.reader.statusOf(poolId),
    ]);
    const reason = this.unavailableReason(terms, state);
    return reason ? { available: false, terms, state, reason } : { available: true, terms, state };
  }

  private unavailableReason(terms: PoolTerms, state: PoolState): UnavailableReason | undefined {
    // `statusOf` resolves lazy expiry on-chain, so it is the authority on whether the pool is
    // open - not `terms.state`, which is what was last written down.
    if (state !== "Open") return "closed";
    const now = this.now();
    if (now >= terms.deadline) return "deadline-passed";
    if (now >= terms.deadline - this.guardSeconds) return "closing";
    return undefined;
  }

  /**
   * Read forward from the last pool this registry has seen, once at a time.
   *
   * Costs one `poolCount` call per request and one `poolOf` per pool that has appeared since
   * the last one - which is zero on almost every request.
   *
   * One at a time because `scanned` cannot move until a `poolOf` has resolved: two requests
   * arriving together - which is the normal case, since a page showing every benchmark asks
   * about each of them at once - would otherwise both read forward from the same point and
   * push every new pool id into `byUrl` twice. Nothing would resolve to the wrong pool, but
   * every later lookup would walk the duplicates and pay for a contract read per copy, for
   * the life of the process.
   */
  private async scan(): Promise<void> {
    this.scanning ??= this.readForward().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async readForward(): Promise<void> {
    const count = await this.reader.poolCount();
    for (let poolId = this.scanned; poolId < count; poolId++) {
      const terms = await this.reader.poolOf(poolId);
      const existing = this.byUrl.get(terms.resourceUrl);
      if (existing) existing.push(poolId);
      else this.byUrl.set(terms.resourceUrl, [poolId]);
      // Per pool, not once at the end. `poolOf` is a network read and can throw halfway, and
      // moving the cursor only afterwards would leave the ids already filed to be filed again
      // by the next scan - the same permanent duplicate cost, reached through a failed read
      // rather than a concurrent one.
      this.scanned = poolId + 1n;
    }
  }
}
