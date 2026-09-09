/**
 * The coordinator's URL-to-pool resolution and its selling window.
 *
 * These are pure rules over contract reads, so the reads are stubbed. What is worth testing
 * here is the part that would be embarrassing to get wrong: the deadline boundaries, and the
 * guard interval ADR 0006 puts in front of them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PoolRegistry } from "../src/server/pools.js";
import type { PoolReader } from "../src/server/pools.js";
import type { PoolState, PoolTerms } from "../src/pool/client.js";

const RESOURCE = "https://quorum402.example/resource/1";
const OTHER = "https://quorum402.example/resource/2";
const NOW = 1_800_000_000;

function terms(poolId: bigint, overrides: Partial<PoolTerms> = {}): PoolTerms {
  return {
    poolId,
    recipient: "0x0000000000000000000000000000000000000001",
    coordinator: "0x0000000000000000000000000000000000000002",
    unitTinybars: 100_000_000n,
    threshold: 3,
    seats: 0,
    deadline: NOW + 3600,
    state: "Open",
    resourceUrl: RESOURCE,
    ...overrides,
  };
}

/** A stubbed contract, plus a count of what was read, so the incremental scan can be checked. */
function reader(pools: PoolTerms[], states?: PoolState[]) {
  const reads: bigint[] = [];
  const stub: PoolReader = {
    poolCount: async () => BigInt(pools.length),
    poolOf: async (poolId) => {
      reads.push(poolId);
      const found = pools[Number(poolId)];
      if (!found) throw new Error(`NoSuchPool(${poolId})`);
      return found;
    },
    statusOf: async (poolId) => states?.[Number(poolId)] ?? pools[Number(poolId)]!.state,
  };
  return { stub, reads, pools };
}

function registryOver(pools: PoolTerms[], states?: PoolState[], guardSeconds = 30) {
  const r = reader(pools, states);
  return {
    ...r,
    registry: new PoolRegistry(r.stub, { now: () => NOW, guardSeconds }),
  };
}

describe("pool registry", () => {
  it("reads forward once when two requests arrive together", async () => {
    // The normal case, not a corner: a page showing every benchmark asks about each of them at
    // once, so two lookups routinely enter the scan before either has finished. `scanned` only
    // moves at the end, so without a guard both read forward from the same point and file every
    // pool id twice - and each duplicate is a contract read, on every later lookup, forever.
    const { registry, reads } = registryOver([terms(0n), terms(1n)]);

    const [first, second] = await Promise.all([
      registry.poolsFor(RESOURCE),
      registry.poolsFor(RESOURCE),
    ]);

    assert.deepEqual(reads, [0n, 1n]);
    assert.deepEqual(first, [0n, 1n]);
    assert.deepEqual(second, [0n, 1n]);
  });

  it("resolves a resource URL to the pool that named it", async () => {
    const { registry } = registryOver([terms(0n, { resourceUrl: OTHER }), terms(1n)]);

    assert.deepEqual(await registry.poolsFor(RESOURCE), [1n]);
    assert.deepEqual(await registry.poolsFor(OTHER), [0n]);
  });

  it("reports no pools for a URL nothing named", async () => {
    const { registry } = registryOver([terms(0n)]);

    assert.deepEqual(await registry.poolsFor("https://quorum402.example/nothing"), []);
    assert.equal(await registry.sellingPoolFor("https://quorum402.example/nothing"), undefined);
  });

  it("reads only the pools it has not seen before", async () => {
    const { registry, reads, pools } = registryOver([terms(0n), terms(1n)]);

    await registry.poolsFor(RESOURCE);
    assert.deepEqual(reads, [0n, 1n], "first scan reads both pools");

    await registry.poolsFor(RESOURCE);
    assert.deepEqual(reads, [0n, 1n], "second scan reads nothing - the mapping cannot go stale");

    pools.push(terms(2n));
    assert.deepEqual(await registry.poolsFor(RESOURCE), [0n, 1n, 2n]);
    assert.deepEqual(reads, [0n, 1n, 2n], "a new pool is read once, and only once");
  });

  describe("the selling window", () => {
    it("sells a pool that is open, in time, and outside the guard interval", async () => {
      const { registry } = registryOver([terms(0n, { deadline: NOW + 31 })]);

      const selling = await registry.sellingPoolFor(RESOURCE);
      assert.equal(selling?.available, true);
      assert.equal(selling?.terms.poolId, 0n);
    });

    it("stops selling exactly one guard interval before the deadline", async () => {
      // The boundary itself, and the second before it. Off-by-one here sells a seat the
      // coordinator cannot deliver, which ADR 0004 pays for as a refund rather than a seat.
      const closing = registryOver([terms(0n, { deadline: NOW + 30 })]);
      const open = registryOver([terms(0n, { deadline: NOW + 31 })]);

      const atBoundary = await closing.registry.sellingPoolFor(RESOURCE);
      assert.equal(atBoundary?.available, false);
      assert.equal(atBoundary?.available === false && atBoundary.reason, "closing");

      assert.equal((await open.registry.sellingPoolFor(RESOURCE))?.available, true);
    });

    it("refuses a pool whose deadline has passed but which nobody has stamped", async () => {
      // Lazy expiry (ADR 0004): the stored state is still `Open` and `statusOf` resolves it.
      // Both are stubbed as `Open` here, so this asserts the clock is consulted independently.
      const { registry } = registryOver([terms(0n, { deadline: NOW })], ["Open"]);

      const selling = await registry.sellingPoolFor(RESOURCE);
      assert.equal(selling?.available, false);
      assert.equal(selling?.available === false && selling.reason, "deadline-passed");
    });

    it("refuses a pool the chain says is no longer open, whatever its stored state says", async () => {
      const { registry } = registryOver([terms(0n, { state: "Open" })], ["Met"]);

      const selling = await registry.sellingPoolFor(RESOURCE);
      assert.equal(selling?.available, false);
      assert.equal(selling?.available === false && selling.reason, "closed");
    });
  });

  describe("more than one pool over the same resource", () => {
    it("sells the earliest pool that is still selling", async () => {
      const { registry } = registryOver([terms(0n), terms(1n)], ["Met", "Open"]);

      const selling = await registry.sellingPoolFor(RESOURCE);
      assert.equal(selling?.available, true);
      assert.equal(selling?.terms.poolId, 1n, "pool 0 is closed, so pool 1 sells");
    });

    it("reports the earliest match when none of them can sell", async () => {
      // The caller needs this to tell 404 from a closed pool, which `undefined` cannot say.
      const { registry } = registryOver([terms(0n), terms(1n)], ["Met", "Expired"]);

      const selling = await registry.sellingPoolFor(RESOURCE);
      assert.equal(selling?.available, false);
      assert.equal(selling?.terms.poolId, 0n);
    });
  });
});
