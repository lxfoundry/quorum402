/**
 * What is for sale, and the join between the pool and the server that sells it.
 *
 * The resource URL is exact-matched against a string stored on-chain at pool creation, so the
 * two sides have to build it identically. That is the kind of coupling that fails silently:
 * the pool stays open and payable while every request 404s, and neither half says why.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BENCHMARKS,
  benchmarkFor,
  describe as describeBenchmark,
  licence,
  resourceUrlFor,
} from "../src/benchmark/catalogue.js";
import { normaliseBaseUrl } from "../src/config.js";
import { hbarToTinybars } from "../src/x402/hedera-exact.js";

const BASE = "https://quorum402.example";

describe("benchmark catalogue", () => {
  it("builds one spelling of a resource URL however the base is written", async () => {
    // `open-pool` writes this string to the chain and the coordinator matches on it. A stray
    // trailing slash makes two URLs that are the same to a reader and never equal to a string
    // comparison.
    const canonical = resourceUrlFor(BASE, "agent-spend-eu");

    assert.equal(canonical, "https://quorum402.example/benchmark/agent-spend-eu");
    assert.equal(resourceUrlFor(`${BASE}/`, "agent-spend-eu"), canonical);
    assert.equal(resourceUrlFor(`${BASE}///`, "agent-spend-eu"), canonical);
    assert.equal(resourceUrlFor(normaliseBaseUrl(`${BASE}/`), "agent-spend-eu"), canonical);
  });

  it("resolves every listed slug, and nothing else", async () => {
    for (const benchmark of BENCHMARKS) {
      assert.equal(benchmarkFor(benchmark.slug)?.id, benchmark.id);
    }
    assert.equal(benchmarkFor("no-such-benchmark"), undefined);
  });

  it("prices a seat in text that survives conversion to tinybars", async () => {
    // A JS number stringifies small amounts as `1e-8`, which then fails to parse as a BigInt.
    for (const benchmark of BENCHMARKS) {
      assert.equal(typeof benchmark.seatPriceHbar, "string");
      assert.ok(hbarToTinybars(benchmark.seatPriceHbar) > 0n);
    }
  });

  it("never offers a cut that could be published to fewer than two contributors", async () => {
    // At one the benchmark is a mirror; at two it is a disclosure. Anything the catalogue
    // could offer below three is a resource that did not need a crowd, and would make the
    // whole scheme look like a discount.
    for (const benchmark of BENCHMARKS) {
      assert.ok(
        benchmark.minimumContributors >= 3,
        `${benchmark.slug} has a suppression floor of ${benchmark.minimumContributors}`,
      );
    }
  });

  it("says why the resource needs a crowd, in the words a 402 carries", async () => {
    const stated = describeBenchmark(BENCHMARKS[0]!);

    assert.match(stated, /distinct buyers/);
    assert.match(stated, /disclose an individual contributor/);
  });

  describe("the licensed document", () => {
    const licensed = licence({
      benchmark: BENCHMARKS[0]!,
      contributors: 3,
      minimumContributors: 3,
      licensee: "0.0.10407152",
      poolId: "7",
      settledUnder: "0.0.7162784@1789171200.000000000",
    });

    it("reports the seat count the contract enforced, not the one the catalogue hoped for", async () => {
      // Both numbers come from the caller, which reads them off the pool. If the catalogue
      // were the source, a pool opened with a different threshold would serve a document that
      // disagreed with the chain about the only fact that matters.
      const disagreeing = licence({
        benchmark: BENCHMARKS[0]!,
        contributors: 5,
        minimumContributors: 5,
        licensee: "0.0.10407152",
        poolId: "7",
        settledUnder: "0.0.7162784@1789171200.000000000",
      });

      assert.equal(disagreeing.contributors, 5);
      assert.equal(disagreeing.minimumContributors, 5);
    });

    it("names the settlement it descends from, so it can be checked against the ledger", async () => {
      assert.equal(licensed.settledUnder, "0.0.7162784@1789171200.000000000");
      assert.equal(licensed.licensee, "0.0.10407152");
      assert.equal(licensed.poolId, "7");
    });

    it("admits in the document that the figures are fixtures", async () => {
      // The binding carries transfer operations only, so no contribution can accompany a
      // payment. Saying so in the artifact costs nothing; discovering it later costs the
      // reader's trust in everything else the artifact says.
      assert.match(licensed.note, /no contribution channel/);
      assert.match(licensed.note, /threshold, the seat count and the settlement below are real/);
    });
  });
});
