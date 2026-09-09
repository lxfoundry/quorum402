/**
 * Everything that must be true before a run spends anything.
 *
 * An end-to-end run costs real HBAR and several minutes, and the two ways it wastes both are
 * an account that runs dry partway through and a dependency that was never reachable. Neither
 * is interesting as a failure and both are cheap to rule out first, so this runs before the
 * scenario and the scenario refuses to start without it.
 *
 * The output is written to be acted on rather than read. A short account is reported with the
 * faucet URL and the exact id to paste into it, and *every* short account is reported before
 * this gives up - one trip to the faucet, not one per invocation.
 *
 * Run alone: npm run e2e -- --check
 */
import type { Config } from "../../src/config.js";
import { caip2 } from "../../src/config.js";
import { GraphClient } from "../../src/graph/client.js";
import { balanceTinybars } from "../../src/hedera/mirror.js";
import { readDeployment } from "../../src/pool/deployment.js";
import { Facilitator } from "../../src/x402/facilitator.js";
import { hbarToTinybars } from "../../src/x402/hedera-exact.js";
import type { GeneratedAccount } from "../create-accounts.js";
import { hbar } from "./harness.js";
import type { Reporter } from "./harness.js";

/** Anonymous, no signup, 100 testnet HBAR per account per 24 hours. */
const FAUCET = "https://portal.hedera.com/faucet";

/**
 * A transaction id no settlement can have.
 *
 * Deliberately not a well-formed one: the reachability check wants an answer of "no such
 * deposit, and here is how far I have read", and a plausible id risks matching something.
 */
const PROBE = "preflight-probe";

/**
 * What the coordinator needs to see the run through.
 *
 * Per scenario: `createPool`, one `recordDeposit` per buyer, and `release` or `refundAll` -
 * plus the view queries the server makes per request, which the SDK caps at 1 HBAR each and
 * which dominate this number. Observed cost is a small fraction of it, and it is not an
 * estimate of the bill: it is the point at which failing up front beats discovering the
 * shortfall after two buyers have already paid.
 */
const OPERATOR_FLOOR = hbarToTinybars("15");

/**
 * Headroom above the seat price, per buyer.
 *
 * A buyer pays only the transfer amount: the facilitator is the fee payer for the settlement
 * (that is what `extra.feePayer` is for), so nothing here covers gas. This is slack against a
 * balance read a moment stale, not a second cost.
 */
const BUYER_HEADROOM = hbarToTinybars("0.1");

/**
 * What a buyer needs on top of that if it is going to claim its own refund.
 *
 * The missed run has one payer call `claimRefund` with its own key, which is the only place in
 * either scenario a buyer pays for a transaction - everywhere else the facilitator is the fee
 * payer and a bystander pushes. Required of every buyer rather than of the one that claims,
 * because which of them claims is the scenario's business and not this file's, and testnet HBAR
 * costs a faucet visit.
 */
const CLAIM_ALLOWANCE = hbarToTinybars("1");

export interface PreflightParams {
  cfg: Config;
  /** Every account that will pay for a seat. */
  buyers: GeneratedAccount[];
  /** Where the pool pays out. Needs to exist; needs no balance. */
  recipient: GeneratedAccount;
  seatPriceTinybars: bigint;
  /** Whether a payer will pull its own refund, and so needs gas of its own. */
  claimsRefund?: boolean;
}

interface Shortfall {
  label: string;
  accountId: string;
  short: bigint;
}

/** Whether the run may proceed. Reports everything it checked either way. */
export async function preflight(report: Reporter, params: PreflightParams): Promise<boolean> {
  const { cfg, buyers, recipient, seatPriceTinybars, claimsRefund } = params;
  const network = caip2(cfg.network);
  const before = report.failures;

  report.step("config");
  report.ok(`network ${network}, operator ${cfg.operatorId}`);
  const deployment = readDeployment(network);
  if (deployment) {
    report.ok(`contract ${deployment.contractId} (deployments/${network.replace(":", "-")}.json)`);
  } else {
    report.bad(`no deployment recorded for ${network}. Run: npm run deploy`);
  }
  if (cfg.subgraphUrl) {
    report.ok(`index ${cfg.subgraphUrl}`);
  } else {
    // Not a warning. Redemption is half of what this run exists to prove, and without an index
    // the coordinator answers it 501 - so the run would fail later for a reason decided here.
    report.bad("SUBGRAPH_URL is unset, so redemption answers 501 and this run cannot complete");
  }

  report.step("reachability");
  await check(report, "mirror node", async () => {
    const balance = await balanceTinybars(cfg.mirrorUrl, cfg.operatorId);
    return `${cfg.mirrorUrl} - operator holds ${hbar(balance)}`;
  });
  await check(report, "facilitator", async () => {
    const feePayer = await new Facilitator(cfg.facilitatorUrl).feePayerFor(network);
    return `${cfg.facilitatorUrl} - serves ${network}, fee payer ${feePayer}`;
  });
  if (cfg.subgraphUrl) {
    const graph = new GraphClient({ url: cfg.subgraphUrl });
    await check(report, "index", async () => {
      // A lookup for a settlement that cannot exist. The index reports how far it has read
      // alongside every answer, so asking a question with no answer is how its head is read -
      // and it exercises the same query the coordinator makes on the commonest refusal on the
      // redemption path, "settled, not indexed yet", rather than a probe of its own.
      const { indexedBlock } = await graph.depositFor("0", PROBE);
      if (indexedBlock === undefined) throw new Error("the subgraph reported no indexed block");
      return `indexed to block ${indexedBlock.toLocaleString()}`;
    });
  }

  report.step("funding");
  const shortfalls: Shortfall[] = [];
  await require_(report, shortfalls, cfg, "operator", cfg.operatorId, OPERATOR_FLOOR);
  const buyerFloor =
    seatPriceTinybars + BUYER_HEADROOM + (claimsRefund ? CLAIM_ALLOWANCE : 0n);
  for (const buyer of buyers) {
    await require_(report, shortfalls, cfg, buyer.label, buyer.accountId, buyerFloor);
  }
  // The recipient is measured either side of the release, so it only has to exist. Reading its
  // balance is the check: the mirror node 404s on an account that does not.
  await check(report, `recipient ${recipient.label}`, async () => {
    const balance = await balanceTinybars(cfg.mirrorUrl, recipient.accountId);
    return `${recipient.accountId} exists, holds ${hbar(balance)}`;
  });

  if (shortfalls.length > 0) faucet(shortfalls);
  return report.failures === before;
}

/** Read a balance and judge it, remembering the gap so the faucet hint can name every one. */
async function require_(
  report: Reporter,
  shortfalls: Shortfall[],
  cfg: Config,
  label: string,
  accountId: string,
  needs: bigint,
): Promise<void> {
  let balance: bigint;
  try {
    balance = await balanceTinybars(cfg.mirrorUrl, accountId);
  } catch (error) {
    report.bad(`${label} ${accountId} - could not be read: ${(error as Error).message}`);
    return;
  }
  if (balance >= needs) {
    report.ok(`${label.padEnd(9)} ${accountId.padEnd(14)} holds ${hbar(balance)}`);
    return;
  }
  report.bad(
    `${label.padEnd(9)} ${accountId.padEnd(14)} holds ${hbar(balance)}, needs ${hbar(needs)}`,
  );
  shortfalls.push({ label, accountId, short: needs - balance });
}

/** Run one reachability probe, reporting its own description of success. */
async function check(
  report: Reporter,
  what: string,
  probe: () => Promise<string>,
): Promise<void> {
  try {
    report.ok(`${what.padEnd(12)} ${await probe()}`);
  } catch (error) {
    report.bad(`${what.padEnd(12)} ${(error as Error).message}`);
  }
}

/** The whole point of the funding check: what to do about it, in copy-paste form. */
function faucet(shortfalls: Shortfall[]): void {
  const plural = shortfalls.length === 1 ? "account needs" : "accounts need";
  console.log(`\n  ${shortfalls.length} ${plural} topping up. No signup, 100 HBAR per 24h:\n`);
  console.log(`      ${FAUCET}\n`);
  console.log(`  paste each id in turn:\n`);
  for (const { label, accountId, short } of shortfalls) {
    console.log(`      ${accountId.padEnd(16)} ${label.padEnd(9)} short ${hbar(short)}`);
  }
  console.log();
}
