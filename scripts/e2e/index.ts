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
 * Run: npm run e2e                     # the full scenario
 *      npm run e2e -- --check          # preflight only; spends nothing
 *      npm run e2e -- --seat 0.25      # a different seat price
 */
import { benchmarkFor } from "../../src/benchmark/catalogue.js";
import { loadConfig } from "../../src/config.js";
import { hbarToTinybars } from "../../src/x402/hedera-exact.js";
import { loadAccounts } from "../accounts.js";
import type { GeneratedAccount } from "../create-accounts.js";
import { Reporter, hbar } from "./harness.js";
import { preflight } from "./preflight.js";

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
 * How long the pool stays open.
 *
 * Long enough for three settlements and an index round trip, short enough that a run killed
 * halfway leaves a pool that expires into refundable rather than one that sits open for hours.
 */
const DEFAULT_TTL_SECONDS = 600;

interface Args {
  check: boolean;
  seatHbar: string;
  ttl: number;
  buyers?: string[];
  recipient?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, seatHbar: DEFAULT_SEAT_HBAR, ttl: DEFAULT_TTL_SECONDS };
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

  console.log(`\nquorum402 end-to-end - ${benchmark.id}\n`);
  report.info(`${threshold} seats at ${hbar(seatPriceTinybars)}, pool open for ${args.ttl}s`);
  report.info(`buyers    ${buyers.map((b) => b.label).join(", ")}`);
  report.info(`recipient ${recipient.label}`);

  const ready = await preflight(report, { cfg, buyers, recipient, seatPriceTinybars });
  if (!ready) {
    console.log("\npreflight failed - nothing was spent\n");
    return report.failures;
  }
  if (args.check) {
    console.log("\npreflight passed - the run would proceed from here\n");
    return 0;
  }

  // The scenario itself lands in the next commit; until then this is the environment check.
  console.log("\npreflight passed\n");
  return 0;
}

main().then(
  (failures) => process.exit(failures === 0 ? 0 : 1),
  (error: unknown) => {
    console.error(`\nFAILED: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
