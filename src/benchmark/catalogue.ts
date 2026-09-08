/**
 * What is for sale, and why one buyer cannot buy it.
 *
 * A contributory price benchmark: autonomous buyers report the unit prices they actually paid
 * for a class of service, and receive the distribution back. It is the model behind
 * compensation benchmarking - contribution is the licence - with a panel of agents instead of
 * a panel of employers.
 *
 * The threshold is not a discount. It is a suppression floor, and it is the reason this
 * resource needs a scheme rather than a coupon:
 *
 *   - at one contributor the benchmark is a mirror. A "market rate" computed from your own
 *     payments is your own payments, which the buyer already had
 *   - at two it is a disclosure. Knowing the mean and knowing your own leaves the other's
 *     exactly, and for a machine buyer the unit price *is* the margin
 *
 * So the count of **distinct** paying agents is the privacy parameter, and the contract's
 * one-seat-per-address rule is counting it. A second payment from an address that already
 * holds a seat correctly buys nothing: one operator cannot improve a panel's anonymity by
 * paying twice.
 *
 * 🔴 **The figures below are fixtures, and the demo has no submission channel.** The Hedera
 * `exact` binding permits only transfer operations, so no price data can ride along with a
 * payment - see ADR 0002. A real deployment would take submissions on a separate channel and
 * gate release on the count of contributors, which is exactly what the pool already enforces.
 * Every licensed document says so in its own `note`, rather than leaving a reader to find out.
 *
 * Cuts are deliberately vendor-neutral. Attaching invented prices to a named provider would
 * be fabricated market data about an identifiable business.
 */

export interface PriceQuantiles {
  p25: number;
  p50: number;
  p75: number;
  currency: string;
  /** What one unit is - "call", "1M output tokens". */
  per: string;
}

export interface BenchmarkCut {
  capability: string;
  tier: string;
  region: string;
}

export interface Benchmark {
  /** URL path segment. Also how `open-pool` and the coordinator name the same offer. */
  slug: string;
  /** The published identity of this cut. */
  id: string;
  cut: BenchmarkCut;
  /**
   * The suppression floor: the fewest distinct contributors this cut may be published to.
   *
   * The seller's intent. `open-pool` turns it into the pool's `threshold`, after which the
   * contract enforces it and nothing here is trusted with it any more.
   */
  minimumContributors: number;
  /** One seat, in HBAR, as plain decimal text - never a number. See `hbarToTinybars`. */
  seatPriceHbar: string;
  unitPrice: PriceQuantiles;
}

export const BENCHMARKS: readonly Benchmark[] = [
  {
    slug: "agent-spend-eu",
    id: "agent-spend-eu-2026w37",
    cut: { capability: "geocoding", tier: "batch", region: "eu-west" },
    minimumContributors: 3,
    seatPriceHbar: "1",
    unitPrice: { p25: 0.0009, p50: 0.0014, p75: 0.0022, currency: "USD", per: "call" },
  },
  {
    slug: "agent-inference-eu",
    id: "agent-inference-eu-2026w37",
    cut: { capability: "text-generation", tier: "frontier", region: "eu-west" },
    minimumContributors: 3,
    seatPriceHbar: "1",
    unitPrice: { p25: 6.0, p50: 9.5, p75: 15.0, currency: "USD", per: "1M output tokens" },
  },
];

export function benchmarkFor(slug: string): Benchmark | undefined {
  return BENCHMARKS.find((benchmark) => benchmark.slug === slug);
}

/** The URL a pool is opened against, and the one the coordinator answers on. One spelling. */
export function resourceUrlFor(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/benchmark/${slug}`;
}

/** What a 402 says this resource is, before any payment. */
export function describe(benchmark: Benchmark): string {
  const { capability, tier, region } = benchmark.cut;
  return (
    `Contributory price benchmark: ${capability} (${tier}, ${region}). ` +
    `Released to its panel only once ${benchmark.minimumContributors} distinct buyers have ` +
    `paid - below that, publishing the aggregate would disclose an individual contributor.`
  );
}

export interface LicensedBenchmark {
  benchmark: string;
  cut: BenchmarkCut;
  /** Distinct paying agents. Read from the chain, not from this file. */
  contributors: number;
  /** The pool's threshold, as the contract enforces it. */
  minimumContributors: number;
  unitPrice: PriceQuantiles;
  /** The Hedera account whose payment bought this seat. */
  licensee: string;
  poolId: string;
  /** The settlement this licence descends from. Paste it into HashScan. */
  settledUnder: string;
  note: string;
}

/**
 * The document a licensed buyer receives.
 *
 * `contributors` and `minimumContributors` come from the caller - which reads them off the
 * pool - rather than from the catalogue, so what is served is what the contract enforced and
 * not what this file hoped for.
 */
export function licence(params: {
  benchmark: Benchmark;
  contributors: number;
  minimumContributors: number;
  licensee: string;
  poolId: string;
  settledUnder: string;
}): LicensedBenchmark {
  return {
    benchmark: params.benchmark.id,
    cut: params.benchmark.cut,
    contributors: params.contributors,
    minimumContributors: params.minimumContributors,
    unitPrice: params.benchmark.unitPrice,
    licensee: params.licensee,
    poolId: params.poolId,
    settledUnder: params.settledUnder,
    note:
      "Demonstration data. This build has no contribution channel - the Hedera `exact` " +
      "binding carries transfer operations only, so no price data accompanies a payment. " +
      "The threshold, the seat count and the settlement below are real and on-chain.",
  };
}
