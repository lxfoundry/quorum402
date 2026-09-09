/**
 * The end-to-end run: one command that exercises the whole system against the real networks.
 *
 * `npm test` proves the parts - the contract's arithmetic on an in-process EVM, the status
 * table over a listener with everything below HTTP stubbed. Nothing there touches Hedera, the
 * Blocky402 facilitator or the subgraph, and nothing there makes several distinct buyers fill
 * one pool, which is the thing this project is actually about.
 *
 * So this is the automated demo. It settles real payments on Hedera testnet through the real
 * facilitator, waits for the real index, and checks what came back. Run it before merging, and
 * as the rehearsal for the video.
 *
 * There are two scenarios and both run by default, because the primitive is an all-or-nothing
 * one and a run that only ever proves the "all" half has demonstrated the easy direction. The
 * crowd arrives, or the crowd falls one seat short and everybody is refunded.
 *
 * Run: npm run e2e                     # both scenarios
 *      npm run e2e -- --check          # preflight only; spends nothing
 *      npm run e2e -- --scenario met   # just the crowd that arrived - the quick one
 *      npm run e2e -- --seat 0.25      # a different seat price
 */
import { benchmarkFor } from "../../src/benchmark/catalogue.js";
import { caip2, loadConfig } from "../../src/config.js";
import { readDeployment } from "../../src/pool/deployment.js";
import { hbarToTinybars } from "../../src/x402/hedera-exact.js";
import { loadAccounts } from "../accounts.js";
import type { GeneratedAccount } from "../create-accounts.js";
import { Reporter, hbar } from "./harness.js";
import { preflight } from "./preflight.js";
import { quorumMet } from "./quorum-met.js";
import { MISSED_TTL_SECONDS, quorumMissed } from "./quorum-missed.js";

/** The cut the run sells. Its `minimumContributors` is the pool's threshold. */
const SLUG = "agent-spend-eu";

/**
 * A seat, in HBAR.
 *
 * Deliberately below the catalogue's list price. The price is a property of the pool, written
 * on-chain at creation and read back by the coordinator, so lowering it changes what a run
 * costs and nothing about what it proves - and a run that is cheap enough to do before every
 * merge is one that will actually be done before every merge.
 */
const DEFAULT_SEAT_HBAR = "0.1";

/**
 * How long a met pool stays open.
 *
 * Long enough for three settlements and an index round trip, short enough that a run killed
 * halfway leaves a pool that expires into refundable rather than one that sits open for hours.
 * It is a ceiling: the met run never waits for it. The missed run is the opposite - there the
 * deadline is the thing being demonstrated, so it names a much shorter one of its own.
 */
const MET_TTL_SECONDS = 600;

/** Which run, or both. */
export type Scenario = "met" | "missed" | "both";

interface Args {
  check: boolean;
  seatHbar: string;
  /** Unset unless asked for, so each scenario can keep its own default. */
  ttl?: number;
  scenario: Scenario;
  buyers?: string[];
  recipient?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, seatHbar: DEFAULT_SEAT_HBAR, scenario: "both" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--check":
        args.check = true;
        break;
      case "--seat":
        args.seatHbar = argv[++i] ?? DEFAULT_SEAT_HBAR;
        break;
      case "--ttl":
        args.ttl = Number(argv[++i]);
        if (!Number.isInteger(args.ttl) || args.ttl < 60) {
          throw new Error("--ttl must be a whole number of seconds, at least 60");
        }
        break;
      case "--scenario": {
        const named = argv[++i];
        if (named !== "met" && named !== "missed" && named !== "both") {
          throw new Error(`--scenario must be met, missed or both, not "${named}"`);
        }
        args.scenario = named;
        break;
      }
      case "--buyers":
        args.buyers = (argv[++i] ?? "").split(",").filter(Boolean);
        break;
      case "--recipient":
        args.recipient = argv[++i];
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return args;
}

/**
 * Who pays and who gets paid.
 *
 * The recipient must not be the operator: the operator pays the fees for every call the run
 * makes, so its balance moves for reasons that have nothing to do with the payout and the
 * measurement either side of `release` stops meaning anything. `check-payout.ts` refuses the
 * same overlap for the same reason.
 */
export interface Cast {
  buyers: GeneratedAccount[];
  recipient: GeneratedAccount;
}

export function cast(args: Args, network: string, operatorId: string, seats: number): Cast {
  const accounts = loadAccounts(network);
  const named = (label: string): GeneratedAccount => {
    const account = accounts.find((a) => a.label === label);
    if (!account) {
      throw new Error(
        `no account "${label}" in .accounts.json. Have: ${accounts.map((a) => a.label).join(", ")}`,
      );
    }
    return account;
  };

  const buyers = args.buyers
    ? args.buyers.map(named)
    : accounts.filter((a) => a.accountId !== operatorId).slice(0, seats);
  if (buyers.length < seats) {
    throw new Error(
      `this pool needs ${seats} distinct buyers, .accounts.json offers ${buyers.length}. ` +
        `Run: npm run accounts:create -- ${seats + 1}`,
    );
  }
  // `quorumMet` takes the pool's threshold from this list, so a longer one would open a pool
  // that neither the benchmark nor the seat count this run reports actually describes.
  if (buyers.length > seats) {
    throw new Error(`this pool needs exactly ${seats} buyers, --buyers named ${buyers.length}`);
  }
  // One account paying twice is not a quorum - the contract enforces one seat per address, so
  // a duplicate here would silently buy nothing and the run would stall below its threshold.
  const ids = new Set(buyers.map((b) => b.accountId));
  if (ids.size !== buyers.length) throw new Error("the same account was named twice as a buyer");

  const recipient = args.recipient
    ? named(args.recipient)
    : accounts.find((a) => !ids.has(a.accountId) && a.accountId !== operatorId);
  if (!recipient) {
    throw new Error(
      `no account left to receive the payout. Run: npm run accounts:create -- ${seats + 1}`,
    );
  }
  if (ids.has(recipient.accountId)) {
    throw new Error(`${recipient.label} cannot be both a buyer and the recipient`);
  }
  if (recipient.accountId === operatorId) {
    throw new Error("the recipient must not be the operator - it pays the fees for every call");
  }
  return { buyers, recipient };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const report = new Reporter();

  const benchmark = benchmarkFor(SLUG);
  if (!benchmark) throw new Error(`no benchmark "${SLUG}"`);
  const seatPriceTinybars = hbarToTinybars(args.seatHbar);
  if (seatPriceTinybars <= 0n) throw new Error("--seat must be greater than zero");

  const threshold = benchmark.minimumContributors;
  const { buyers, recipient } = cast(args, cfg.network, cfg.operatorId, threshold);
  const runs: Exclude<Scenario, "both">[] =
    args.scenario === "both" ? ["met", "missed"] : [args.scenario];

  console.log(`\nquorum402 end-to-end - ${benchmark.id}\n`);
  report.info(`${threshold} seats at ${hbar(seatPriceTinybars)}`);
  report.info(`buyers    ${buyers.map((b) => b.label).join(", ")}`);
  report.info(`recipient ${recipient.label}`);
  report.info(`scenarios ${runs.join(" then ")}`);

  const ready = await preflight(report, {
    cfg,
    buyers,
    recipient,
    seatPriceTinybars,
    // The missed run has a payer pull its own refund, and a payer paying for its own
    // transaction is the only thing in either scenario that spends a buyer's gas.
    claimsRefund: runs.includes("missed"),
  });
  if (!ready) {
    console.log("\npreflight failed - nothing was spent\n");
    return report.failures;
  }
  if (args.check) {
    console.log("\npreflight passed - the run would proceed from here\n");
    return 0;
  }

  const contractId = readDeployment(caip2(cfg.network))?.contractId;
  if (!contractId) throw new Error("preflight passed without a deployment, which cannot happen");

  const players = { cfg, benchmark, contractId, buyers, recipient, seatPriceTinybars };
  for (const run of runs) {
    console.log(`\n\n=== ${HEADLINE[run]} ===`);
    // Each scenario opens its own pool on its own port and asserts against balances it read
    // itself, so a failure in the first does not invalidate the second - and on a path costing
    // minutes and real HBAR, both answers are worth having from one invocation.
    if (run === "met") {
      await quorumMet(report, { ...players, ttlSeconds: args.ttl ?? MET_TTL_SECONDS });
    } else {
      await quorumMissed(report, { ...players, ttlSeconds: args.ttl ?? MISSED_TTL_SECONDS });
    }
  }

  console.log(
    report.failures === 0
      ? `\n${VERDICT[args.scenario]}\n`
      : `\nFAILED with ${report.failures} problem(s)\n`,
  );
  return report.failures;
}

/** What a run is about to demonstrate, said before it starts spending. */
const HEADLINE: Record<Exclude<Scenario, "both">, string> = {
  met: "the crowd arrives",
  missed: "the crowd falls one seat short",
};

/** And what it demonstrated, said once at the end. */
const VERDICT: Record<Scenario, string> = {
  met: "a crowd answered one 402 together, and the seller was paid",
  missed: "the crowd fell short, and every payer got their money back",
  both:
    "a crowd answered one 402 together and the seller was paid - and when it fell one seat " +
    "short, every payer got their money back instead",
};

main().then(
  (failures) => process.exit(failures === 0 ? 0 : 1),
  (error: unknown) => {
    console.error(`\nFAILED: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
