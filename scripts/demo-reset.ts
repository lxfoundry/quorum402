/**
 * Recycle the demo's throwaway accounts and hand back a set that has never done anything.
 *
 * Run: npm run demo:reset                 # says what it would do, changes nothing
 *      npm run demo:reset -- --yes        # does it
 *
 * The demo UI shows four things, and only some of them are about accounts:
 *
 *   balances          the mirror node, per account
 *   "my seats"        `depositsFor(address)` against the index - keyed by *payer address*
 *   the service card  `advertisedFor(resourceUrl)` - keyed by *resource URL*
 *   log and caches    this process, lost on restart
 *
 * Fresh accounts answer the first two completely: a new address has no deposits, so its seat
 * list is empty because it is true, not because anything was hidden. They do nothing at all
 * about the third, and that is the part worth being explicit about. Pools are found by the URL
 * they named at creation, so a pool left `Open` by an earlier session goes on being *the* pool
 * that URL advertises no matter who opens a newer one - `PoolRegistry.advertisedFor` returns
 * the earliest still-selling match, and `QuorumPools` has no cancel. `--retire` is the answer:
 * fill such a pool to its threshold and release it, which is the only way to stop a pool
 * selling ahead of its deadline, and costs a seat price per remaining seat to do.
 *
 * Nothing here deletes an account. Sweeping moves the balance out and leaves the account
 * alive, and superseding an accounts file renames it rather than removing it, because these
 * are the only copies of keys that may still be owed a refund - and `claimRefund` pays
 * `msg.sender` and nobody else, so an account without its key is a refund nobody can claim.
 *
 * 🔴 Reads private keys out of `.accounts.json`. Same rule as the rest of this directory: no
 * key is printed, and none reaches anything that is not about to sign with it.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AccountId,
  Client,
  ContractId,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { BENCHMARKS, resourceUrlFor } from "../src/benchmark/catalogue.js";
import { buySeat } from "../src/buyer/agent.js";
import { caip2, loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { GraphClient } from "../src/graph/client.js";
import { awaitBalance, balanceTinybars, evmAddressOf } from "../src/hedera/mirror.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";
import { PoolRegistry } from "../src/server/pools.js";
import type { PoolAvailability } from "../src/server/pools.js";
import { MIN_COORDINATOR_TINYBARS } from "../src/server/preflight.js";
import { tinybarsToHbar } from "../src/x402/hedera-exact.js";
import {
  ACCOUNTS_FILE,
  archiveAccounts,
  readAccountsFile,
  writeAccounts,
} from "./accounts.js";
import { createAccounts } from "./create-accounts.js";
import type { GeneratedAccount } from "./create-accounts.js";
import { Reporter, hbar } from "./e2e/harness.js";

/** Buyers to create. The demo offers thresholds of 3 and 4, so 4 is the larger of them. */
const DEFAULT_BUYERS = 4;

/**
 * What each new account is funded with.
 *
 * Comfortably above anything the demo asks of one - a 1 HBAR seat, and the gas for a payer to
 * pull its own refund - and deliberately the *same* for every account, including the seller
 * who spends almost nothing. The wallet switcher puts these balances side by side on screen,
 * and identical starting figures make the one that moved obvious.
 */
const DEFAULT_HBAR_EACH = 10;

/** The labels the demo expects. `wallets.ts` derives the seller role from the prefix. */
export function labelsFor(buyers: number): string[] {
  return [...Array.from({ length: buyers }, (_, i) => `buyer${i + 1}`), "seller"];
}

export interface Args {
  yes: boolean;
  retire: boolean;
  /** Other accounts files to recycle - a second working copy's, typically. */
  alsoSweep: string[];
  buyers: number;
  hbarEach: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    yes: argv.includes("--yes"),
    retire: argv.includes("--retire"),
    alsoSweep: [],
    buyers: DEFAULT_BUYERS,
    hbarEach: DEFAULT_HBAR_EACH,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--also-sweep") {
      if (!value || value.startsWith("--")) throw new Error("--also-sweep needs a path");
      args.alsoSweep.push(value);
      i++;
    } else if (flag === "--buyers" || flag === "--hbar-each") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${flag} needs a positive number, got "${value}"`);
      }
      if (flag === "--buyers") {
        if (!Number.isInteger(parsed) || parsed > 10) {
          throw new Error(`--buyers must be a whole number up to 10, got "${value}"`);
        }
        args.buyers = parsed;
      } else {
        args.hbarEach = parsed;
      }
      i++;
    } else if (flag?.startsWith("--") && !["--yes", "--retire"].includes(flag)) {
      throw new Error(
        `unknown flag "${flag}". Accepts: --yes --retire --also-sweep <path> ` +
          `--buyers <n> --hbar-each <n>`,
      );
    }
  }
  return args;
}

/** One account being recycled, with what the network - not the file - says about it. */
interface Surveyed {
  /** Which accounts file it came from. Two files can hold the same label; the path separates them. */
  source: string;
  account: GeneratedAccount;
  balanceTinybars: bigint;
  /**
   * The address the network holds, which is not always the one the file recorded.
   *
   * `undefined` when the mirror node could not answer - a deleted account, or an id that never
   * existed. Everything address-shaped downstream uses this rather than `account.evmAddress`,
   * because the recorded field has been wrong before: files written before 2026-09-09 hold the
   * key-derived address instead of the long-zero one the network uses, which makes every
   * index lookup for that account return nothing at all.
   */
  addressOnChain?: string;
  problem?: string;
}

/** A pool that would take a buyer's money ahead of anything opened today. */
interface Shadow {
  slug: string;
  resourceUrl: string;
  availability: PoolAvailability;
}

// ------------------------------------------------------------------------------ phase 0: survey

/** Every accounts file being recycled, in the order they will be swept. */
function sourcesOf(args: Args): Array<{ path: string; accounts: GeneratedAccount[] }> {
  const paths = [ACCOUNTS_FILE, ...args.alsoSweep];
  const sources: Array<{ path: string; accounts: GeneratedAccount[] }> = [];
  for (const path of paths) {
    // The primary file being *absent* is the ordinary first-run case, not a failure: there is
    // simply nothing to recycle, and phase 4 still has accounts to make. Tested for here rather
    // than caught below, because absent is the only reason to carry on. A file that is present
    // and unreadable - truncated, hand-edited, half-written by an interrupted run - is a
    // different thing entirely, and swallowing it would survey as "nothing to recycle", sweep
    // funded accounts not at all, and supersede the file anyway. Silently.
    if (path === ACCOUNTS_FILE && !existsSync(path)) continue;
    try {
      // Read by path rather than through `loadAccounts`, which would refuse a file written
      // against another network. A file like that still names accounts holding a balance, and
      // whether they can be *used* is a different question from whether they can be emptied.
      sources.push({ path, accounts: readAccountsFile(path).accounts });
    } catch (error) {
      const where = path === ACCOUNTS_FILE ? path : `--also-sweep ${path}`;
      throw new Error(`${where}: ${(error as Error).message}`);
    }
  }
  return sources;
}

async function survey(
  report: Reporter,
  cfg: Config,
  sources: Array<{ path: string; accounts: GeneratedAccount[] }>,
): Promise<Surveyed[]> {
  const surveyed: Surveyed[] = [];
  for (const { path, accounts } of sources) {
    report.info(path);
    for (const account of accounts) {
      const entry: Surveyed = { source: path, account, balanceTinybars: 0n };
      try {
        const [balance, addressOnChain] = await Promise.all([
          balanceTinybars(cfg.mirrorUrl, account.accountId),
          evmAddressOf(cfg.mirrorUrl, account.accountId),
        ]);
        entry.balanceTinybars = balance;
        entry.addressOnChain = addressOnChain;
      } catch (error) {
        entry.problem = (error as Error).message;
      }
      surveyed.push(entry);

      if (entry.problem) {
        report.bad(
          `${account.label.padEnd(8)} ${account.accountId.padEnd(14)} ${entry.problem}`,
        );
        continue;
      }
      const stale =
        entry.addressOnChain &&
        entry.addressOnChain.toLowerCase() !== account.evmAddress.toLowerCase();
      report.ok(
        `${account.label.padEnd(8)} ${account.accountId.padEnd(14)} holds ` +
          `${hbar(entry.balanceTinybars)}${stale ? "  (recorded address is stale)" : ""}`,
      );
      if (stale) {
        // Worth a line of its own rather than a parenthesis, because it is silent in every
        // other tool: the account works, its payments settle and are recorded correctly, and
        // only the *lookups* keyed on the recorded address come back empty.
        report.info(
          `         file says ${account.evmAddress}, network says ${entry.addressOnChain}` +
            ` - the index is asked about the first, so this account's seats never list`,
        );
      }
    }
  }
  return surveyed;
}

/** Which of our resource URLs already have a pool that would take a payment. */
async function findShadows(
  report: Reporter,
  cfg: Config,
  registry: PoolRegistry,
): Promise<Shadow[]> {
  const shadows: Shadow[] = [];
  for (const benchmark of BENCHMARKS) {
    const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, benchmark.slug);
    // The coordinator's own resolution, not a reimplementation of it: `PoolRegistry` takes the
    // three-method reader `PoolsClient` already satisfies, so what this reports is exactly what
    // a 402 would advertise.
    const { pool, poolCount } = await registry.advertisedFor(resourceUrl);
    const ever = `${poolCount} pool${poolCount === 1 ? "" : "s"} ever`;
    if (pool?.available) {
      shadows.push({ slug: benchmark.slug, resourceUrl, availability: pool });
      report.bad(
        `${benchmark.slug.padEnd(20)} pool ${pool.terms.poolId} is selling ` +
          `(${pool.terms.seats}/${pool.terms.threshold} seats at ` +
          `${tinybarsToHbar(pool.terms.unitTinybars)} HBAR) - ${ever}`,
      );
    } else if (pool) {
      report.ok(
        `${benchmark.slug.padEnd(20)} nothing selling; newest is pool ${pool.terms.poolId}, ` +
          `${pool.state.toLowerCase()} - ${ever}`,
      );
    } else {
      report.ok(`${benchmark.slug.padEnd(20)} nothing selling - ${ever}`);
    }
  }
  return shadows;
}

// ----------------------------------------------------------------------------- phase 1: retire

/**
 * The payers already holding a seat in this pool, lowercased.
 *
 * Read off the deposits rather than asked for directly, because `_seatTaken` is private and
 * has no view - but `counted` on a deposit is the same fact, and it is the fact `claimRefund`
 * and `redeem` both turn on. One paid query per deposit, on a path that is about to spend a
 * seat price per seat, so the proportion is right.
 */
async function seatedPayers(pools: PoolsClient, poolId: bigint): Promise<Set<string>> {
  const seated = new Set<string>();
  const count = await pools.depositCount(poolId);
  for (let id = 0n; id < count; id++) {
    const deposit = await pools.depositAt(poolId, id);
    if (deposit.counted) seated.add(deposit.payer.toLowerCase());
  }
  return seated;
}

/**
 * Whether a payment took a seat, according to the receipt rather than the status code.
 *
 * `null` is the receipt's own third answer and means *unknown*, not false - the attribution
 * was recovered from the replay guard, which proves the payment landed without saying which
 * deposit it is. A 200 needs no reading: the coordinator answers it only when this payment
 * was counted *and* met the threshold.
 */
export function tookSeat(result: { status: number; body: unknown }): boolean | null {
  if (result.status === 200) return true;
  const counted = (result.body as { counted?: unknown } | null)?.counted;
  return typeof counted === "boolean" ? counted : null;
}

/**
 * Stop a pool selling, the only way the contract allows: fill it and pay it out.
 *
 * There is no cancel in `QuorumPools`, deliberately - a seller who could withdraw a pool after
 * payers had committed to it would be exactly the counterparty risk the threshold exists to
 * remove. So a pool opened by mistake, or left over from a run that was interrupted, goes on
 * advertising until its deadline or until its threshold is met. Buying the remaining seats is
 * the fast path, and it costs the seat price per seat - paid to that pool's own recipient,
 * which for a demo's leftovers is usually an account this same run is about to sweep.
 *
 * Runs before the sweep for that reason: the accounts paying for this are the ones whose funds
 * are being recycled anyway.
 *
 * 🔴 A payer who already holds a seat here is not refused, and that is the trap this function
 * is built around. `recordDeposit` never reverts for a buyer-side reason (ADR 0003), so a
 * second payment from the same address settles as a *late* deposit - `counted: false`,
 * refundable, entitling nothing - and the coordinator answers 202 with the receipt saying so.
 * A leftover pool is usually one an interrupted run filled part-way with exactly these
 * accounts, so that is the ordinary case here rather than the exotic one.
 */
async function retire(
  report: Reporter,
  cfg: Config,
  pools: PoolsClient,
  shadow: Shadow,
  candidates: Surveyed[],
): Promise<void> {
  const { terms } = shadow.availability;
  const needed = terms.threshold - terms.seats;

  // Excluded before a payment is built, not discovered from one: paying an account that is
  // already seated moves the seat count not at all, and leaves a seat price sitting in the
  // contract as a refund this run will never claim.
  const seated = await seatedPayers(pools, terms.poolId);
  const unseated = candidates.filter(
    (c) => c.addressOnChain && !seated.has(c.addressOnChain.toLowerCase()),
  );
  const affordable = unseated.filter((c) => c.balanceTinybars >= terms.unitTinybars);

  if (affordable.length < needed) {
    const held = candidates.length - unseated.length;
    report.bad(
      `pool ${terms.poolId} needs ${needed} more seat(s) at ${tinybarsToHbar(terms.unitTinybars)}` +
        ` HBAR; ${affordable.length} account(s) can pay that` +
        `${held ? ` (${held} already hold a seat here)` : ""}. Left selling.`,
    );
    return;
  }

  // No operator. A buyer's payment is signed by the buyer and submitted by the facilitator -
  // the client here only carries the network the transaction is frozen against, and giving it
  // the operator's key would suggest the coordinator was somehow party to the payment.
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  let taken = 0;
  try {
    for (const buyer of affordable) {
      if (taken === needed) break;
      const result = await buySeat({
        client,
        resourceUrl: shadow.resourceUrl,
        payerId: buyer.account.accountId,
        payerKey: PrivateKey.fromStringECDSA(buyer.account.privateKey),
      });
      // Anything but 200 or 202 did not pay, and pressing on would spend the rest of the
      // accounts against a pool that is not filling.
      if (result.status !== 200 && result.status !== 202) {
        report.bad(
          `pool ${terms.poolId}: ${buyer.account.label} was answered ${result.status}`,
        );
        break;
      }
      // The balance this run believes in has to move with the payment, or the sweep will build
      // a transfer for money that is no longer there. Waited for rather than read once: mirror
      // ingestion lags consensus, and a read taken immediately reports the pre-payment figure.
      // The expected amount is exact - a payer sends the seat price and nothing else, because
      // `extra.feePayer` makes the facilitator responsible for the fee. True of a late deposit
      // as much as a counted one: both settle, and only one buys anything.
      buyer.balanceTinybars = await awaitBalance(
        cfg.mirrorUrl,
        buyer.account.accountId,
        buyer.balanceTinybars - terms.unitTinybars,
      );

      const counted = tookSeat(result);
      if (counted === true) {
        taken++;
        report.ok(
          `pool ${terms.poolId}: ${buyer.account.label} took seat ` +
            `${terms.seats + taken}/${terms.threshold} (${result.status})`,
        );
        continue;
      }
      // Paid, took nothing. The pre-filter should have prevented it, so reaching here means
      // the pool stopped taking seats between the read and the payment - a deadline that
      // passed, or someone else's payment. Stopping is the point: the next account would pay
      // into the same closed pool, and the one after that.
      report.bad(
        `pool ${terms.poolId}: ${buyer.account.label} paid ${tinybarsToHbar(terms.unitTinybars)}` +
          ` HBAR and took no seat (counted ${String(counted)}) - refundable with claimRefund.` +
          ` Stopping here rather than spending the rest the same way`,
      );
      break;
    }
  } finally {
    client.close();
  }

  // Asked of the contract rather than inferred from the tally above, and asked however the
  // loop ended: a pool someone else's payment met is still a pool worth releasing, and a run
  // that stopped early must not leave a met pool holding its money.
  const state = await pools.statusOf(terms.poolId);
  if (state !== "Met") {
    // Not a failure on its own: the pool has stopped selling either way, which is what this
    // phase is for. Releasing is what returns the money, and someone else may already have
    // done it. Still selling is a failure, and the loop above will have said why.
    report.info(`pool ${terms.poolId} is ${state}; nothing to release`);
    return;
  }
  const released = await pools.release(terms.poolId);
  report.ok(
    `pool ${terms.poolId} released to ${terms.recipient} - ${released.transactionId}`,
  );
}

// ------------------------------------------------------------------------------ phase 3: sweep

/**
 * Move an account's entire balance to the operator, leaving the account alive.
 *
 * The whole balance, with nothing held back for fees, because the *operator* pays for this
 * transaction - it is the client's operator, so the transaction id belongs to it. That is the
 * difference between recovering a balance and recovering a balance minus whatever guess was
 * made about the fee, and it is why this is a transfer rather than an account deletion.
 */
async function sweepOne(
  report: Reporter,
  cfg: Config,
  client: Client,
  operator: AccountId,
  entry: Surveyed,
): Promise<bigint> {
  const { account } = entry;
  if (account.accountId === cfg.operatorId) {
    report.info(`${account.label.padEnd(8)} ${account.accountId} is the operator - skipped`);
    return 0n;
  }
  if (entry.problem) {
    report.bad(`${account.label.padEnd(8)} ${account.accountId} skipped: ${entry.problem}`);
    return 0n;
  }

  // Twice at most. The amount has to be exactly what the account holds - there is no "send
  // everything" transfer - so this is one read and one attempt, and the read can be stale: the
  // mirror node lags consensus, and `--retire` has just spent from some of these accounts. A
  // stale figure fails as INSUFFICIENT_ACCOUNT_BALANCE, which a second read resolves.
  let failure = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const balance = await balanceTinybars(cfg.mirrorUrl, account.accountId);
    if (balance === 0n) {
      report.info(`${account.label.padEnd(8)} ${account.accountId} is empty - nothing to sweep`);
      return 0n;
    }
    try {
      const signed = await new TransferTransaction()
        // Never a JS number: `fromTinybars` rejects bigint, and a number loses precision above
        // 2^53 tinybars. The decimal string is exact either side.
        .addHbarTransfer(
          AccountId.fromString(account.accountId),
          Hbar.fromTinybars((-balance).toString()),
        )
        .addHbarTransfer(operator, Hbar.fromTinybars(balance.toString()))
        .freezeWith(client)
        .sign(PrivateKey.fromStringECDSA(account.privateKey));
      const receipt = await (await signed.execute(client)).getReceipt(client);
      report.ok(
        `${account.label.padEnd(8)} ${account.accountId.padEnd(14)} swept ${hbar(balance)}` +
          ` (${receipt.status.toString()})`,
      );
      return balance;
    } catch (error) {
      failure = (error as Error).message;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  // One account that cannot be swept must not strand the rest - and the archive still holds its
  // key, so this is recoverable by hand later.
  report.bad(
    `${account.label.padEnd(8)} ${account.accountId.padEnd(14)} could not be swept: ${failure}`,
  );
  return 0n;
}

// ----------------------------------------------------------------------------- phase 5: verify

async function verify(
  report: Reporter,
  cfg: Config,
  registry: PoolRegistry,
  created: GeneratedAccount[],
): Promise<void> {
  const index = cfg.subgraphUrl ? new GraphClient({ url: cfg.subgraphUrl }) : undefined;

  for (const account of created) {
    const [balance, addressOnChain] = await Promise.all([
      balanceTinybars(cfg.mirrorUrl, account.accountId),
      evmAddressOf(cfg.mirrorUrl, account.accountId),
    ]);
    report.expect(
      addressOnChain.toLowerCase() === account.evmAddress.toLowerCase(),
      `${account.label.padEnd(8)} ${account.accountId.padEnd(14)} holds ${hbar(balance)}, ` +
        `address matches the network`,
      `${account.label.padEnd(8)} ${account.accountId.padEnd(14)} recorded ` +
        `${account.evmAddress}, network says ${addressOnChain}`,
    );

    if (!index || account.label.startsWith("seller")) continue;
    // The question the demo's seat list asks, asked the same way. A fresh address answering
    // "none" is the check: anything else means this account is not as new as it looks.
    const { deposits } = await index.depositsFor(addressOnChain, 5);
    report.expect(
      deposits.length === 0,
      `${account.label.padEnd(8)} has no deposits in the index`,
      `${account.label.padEnd(8)} already has ${deposits.length} deposit(s) in the index`,
    );
  }

  const operator = await balanceTinybars(cfg.mirrorUrl, cfg.operatorId);
  report.expect(
    operator >= MIN_COORDINATOR_TINYBARS,
    `operator  ${cfg.operatorId.padEnd(14)} holds ${hbar(operator)}`,
    `operator  ${cfg.operatorId.padEnd(14)} holds ${hbar(operator)}, below the ` +
      `${hbar(MIN_COORDINATOR_TINYBARS)} floor - /readyz will answer 503 coordinator-underfunded`,
  );

  const shadows = await findShadows(report, cfg, registry);
  report.expect(
    shadows.length === 0,
    "no pool is selling either resource - the next pool opened will be the one advertised",
    `${shadows.length} pool(s) still selling; a pool opened now would not be advertised`,
  );
}

// ------------------------------------------------------------------------------------- driving

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (cfg.network !== "testnet") {
    // These accounts are throwaway by construction and this script empties them without asking
    // twice. Neither is a thing to do on mainnet, and a guard is cheaper than the alternative.
    throw new Error(`demo:reset only runs against testnet; HEDERA_NETWORK is ${cfg.network}`);
  }
  const network = caip2(cfg.network);
  const deployment = readDeployment(network);
  if (!deployment) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const report = new Reporter();
  const operator = AccountId.fromString(cfg.operatorId);
  const client = Client.forTestnet();
  client.setOperator(operator, PrivateKey.fromStringECDSA(cfg.operatorKey));

  try {
    const pools = new PoolsClient(client, ContractId.fromString(deployment.contractId));
    const registry = new PoolRegistry(pools);

    report.step("config");
    report.ok(`network ${network}, operator ${cfg.operatorId}`);
    report.ok(`contract ${deployment.contractId}`);
    // Worth stating before anything is spent: this decides which resource URLs the new pools
    // will name, and so which old pools can shadow them.
    report.ok(`selling as ${cfg.publicBaseUrl}`);
    if (cfg.subgraphUrl) report.ok(`index ${cfg.subgraphUrl}`);
    else report.info("SUBGRAPH_URL unset - seat lists cannot be checked, and nothing can redeem");

    report.step("accounts to recycle");
    const surveyed = await survey(report, cfg, sourcesOf(args));
    const recoverable = surveyed.reduce((sum, s) => sum + s.balanceTinybars, 0n);
    const operatorBefore = await balanceTinybars(cfg.mirrorUrl, cfg.operatorId);
    report.info(
      `${surveyed.length} account(s) holding ${hbar(recoverable)}; ` +
        `operator holds ${hbar(operatorBefore)}`,
    );

    report.step("pools still selling");
    const shadows = await findShadows(report, cfg, registry);

    report.step("plan");
    const labels = labelsFor(args.buyers);
    const funding = BigInt(Math.round(args.hbarEach * 1e8)) * BigInt(labels.length);
    if (shadows.length && args.retire) {
      const cost = shadows.reduce(
        (sum, s) =>
          sum +
          s.availability.terms.unitTinybars *
            BigInt(s.availability.terms.threshold - s.availability.terms.seats),
        0n,
      );
      report.info(`retire ${shadows.length} selling pool(s) by filling them - ${hbar(cost)}`);
    } else if (shadows.length) {
      report.info(
        `leave ${shadows.length} selling pool(s) alone - pass --retire to fill and release them`,
      );
    }
    report.info(`sweep ${hbar(recoverable)} into ${cfg.operatorId}`);
    report.info(`create ${labels.join(", ")} with ${args.hbarEach} HBAR each - ${hbar(funding)}`);
    report.info(
      `operator ends near ${hbar(operatorBefore + recoverable - funding)}, before fees`,
    );

    if (!args.yes) {
      // Not "nothing was signed", which is false and false in the direction that costs money:
      // finding which pools name these resource URLs reads every pool off the contract, and a
      // `ContractCallQuery` is paid for by the operator. What this run has not done is change
      // anything - no account swept, created or emptied, no pool filled.
      console.log(
        "\n  dry run - nothing was changed. The pool reads above are paid contract queries," +
          "\n  so this run still cost the operator a few HBAR in query fees." +
          "\n  Re-run with --yes to execute.\n",
      );
      // Zero regardless of what was found. Everything above describes the world as it is, and
      // a shadowing pool or a stale address is this script's *subject*, not a failure of it -
      // exiting non-zero for finding the thing it was asked to look for would make the dry run
      // unusable as a check.
      return 0;
    }

    // Anything counted from here is something this run did wrong, as against something it
    // found already wrong. The two must not share an exit code, or a reset that fixed pool 25
    // exactly as asked would report failure for having noticed it.
    const found = report.failures;

    if (args.retire) {
      report.step("retiring pools that are still selling");
      for (const shadow of shadows) {
        // Only accounts with a key here can pay, and each may take one seat per pool - the
        // contract's `_seatTaken` sees to that, which is also why the demo needs distinct
        // buyers in the first place.
        await retire(report, cfg, pools, shadow, surveyed.filter((s) => !s.problem));
      }
    }

    report.step("sweeping");
    let swept = 0n;
    for (const entry of surveyed) swept += await sweepOne(report, cfg, client, operator, entry);
    report.info(`recovered ${hbar(swept)}`);

    // Every accounts file is superseded *after* its accounts are drained, and not before.
    //
    // The order is the whole of this phase's correctness. An archive taken first would move
    // `.accounts.json` out from under `sourcesOf`, which looks for that name and no other - so
    // a sweep that failed partway through would leave the rest of the balances reachable only
    // by a caller who knew to point `--also-sweep` at an archive. Re-running is meant to be the
    // recovery, and it is: the file is still where it was, and an account already swept reads
    // as empty and is skipped.
    //
    // In place, for the `--also-sweep` files, so the working copy one came from cannot load it
    // again and demo with accounts this run has just emptied.
    report.step("superseding the accounts files");
    for (const path of [ACCOUNTS_FILE, ...args.alsoSweep]) {
      const moved = archiveAccounts(path);
      if (moved) report.ok(`${path} -> ${moved}`);
    }

    report.step("creating");
    const created: GeneratedAccount[] = [];
    try {
      await createAccounts({
        client,
        labels,
        hbarEach: args.hbarEach,
        onCreated: (account) => {
          created.push(account);
          // Written after every single creation, not at the end. These accounts hold funds the
          // moment they exist, and a failure on the last one must not lose the keys to the rest.
          writeAccounts(created, cfg.network, ACCOUNTS_FILE);
          report.ok(`${account.label.padEnd(8)} ${account.accountId}`);
        },
      });
    } finally {
      if (created.length) {
        report.info(`wrote ${created.length} account(s) to ${ACCOUNTS_FILE} (gitignored - keys)`);
      }
    }

    report.step("verifying");
    await verify(report, cfg, registry, created);

    const failed = report.failures - found;
    console.log(
      failed === 0
        ? "\n  ready. Restart `npm run demo` - wallets are read once, at startup.\n"
        : `\n  ${failed} step(s) failed. See above.\n`,
    );
    return failed > 0 ? 1 : 0;
  } finally {
    client.close();
  }
}

// Only when run directly. Importing this module - which the tests do, for `parseArgs` - must
// not empty anybody's accounts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`\n${(err as Error).message}\n`);
      process.exit(1);
    });
}
