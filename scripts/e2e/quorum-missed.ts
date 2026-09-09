/**
 * The other half of the primitive: a crowd that did not arrive.
 *
 * `quorum-met.ts` proves the resource unlocks once enough buyers pay. This proves the claim
 * that makes paying into it safe in the first place - that when they do not, everybody gets
 * their money back. A `conditional` payment flow whose reversal has never run is a promise
 * rather than a remedy, and the unit suite can only check that this code agrees with itself
 * about it.
 *
 * The pool misses by exactly one seat. That is the version worth demonstrating: all-or-nothing
 * has to mean all-or-nothing, and one short is where "close enough" would be most tempting.
 *
 * `quorum-scheme.md` §9 puts reversal deliberately outside HTTP and names two ways to it, and
 * both run here because they protect different people. A payer who can afford the gas pulls
 * their own money back and needs nobody's cooperation. A payer who spent their HBAR on the seat
 * and cannot afford the gas has it pushed to them by a bystander who gains nothing by doing it.
 * Neither path asks the coordinator for anything, which is the point - the party whose failure
 * a payer most needs protection from is the one that failed to sell them the resource.
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { resourceUrlFor } from "../../src/benchmark/catalogue.js";
import { caip2 } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { GraphClient } from "../../src/graph/client.js";
import { accountOf, awaitBalance, balanceTinybars, evmAddressOf } from "../../src/hedera/mirror.js";
import { PoolsClient } from "../../src/pool/client.js";
import { FailureReporter } from "../../src/server/failures.js";
import { PoolRegistry } from "../../src/server/pools.js";
import { CLAIM_REFUND } from "../../src/server/receipt.js";
import type { ServerDeps } from "../../src/server/index.js";
import { Facilitator } from "../../src/x402/facilitator.js";
import { buySeat, redeemSeat } from "../../src/buyer/agent.js";
import type { GeneratedAccount } from "../create-accounts.js";
import { awaitIndexed, hbar, startCoordinator } from "./harness.js";
import type { Reporter, ScenarioParams } from "./harness.js";

/**
 * How long this pool stays open, in seconds.
 *
 * Unlike the met run, this one has to sit through its own deadline, so the number is the run's
 * length rather than a ceiling on it. It has to cover every settlement plus
 * `SELLING_STOPS_SECONDS_BEFORE_DEADLINE`, since the coordinator stops selling half a minute
 * out - two settlements against a real facilitator take well under a minute, and the slack on
 * top is insurance against a slow one rather than time anybody needs. Every second beyond that
 * is a second spent watching a clock.
 */
export const MISSED_TTL_SECONDS = 120;

/** What a payer held before it paid, so "made whole" can be checked rather than asserted. */
interface Before {
  buyer: GeneratedAccount;
  tinybars: bigint;
}

export async function quorumMissed(report: Reporter, params: ScenarioParams): Promise<void> {
  const { cfg, benchmark, contractId, buyers, recipient, seatPriceTinybars } = params;
  const network = caip2(cfg.network);

  // The pool is opened for the full cast and one of them never shows up. `buyers` sizes the
  // pool in both scenarios, so the two runs sell the same thing and differ only in who arrives.
  const threshold = buyers.length;
  const payers = buyers.slice(0, -1);
  const absent = buyers[buyers.length - 1];
  const claimant = payers[0];
  if (!claimant || !absent) throw new Error("a pool missed by one seat needs at least two buyers");
  const paid = seatPriceTinybars * BigInt(payers.length);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(contractId));

  try {
    const [coordinatorAddress, recipientAddress] = await Promise.all([
      evmAddressOf(cfg.mirrorUrl, cfg.operatorId),
      evmAddressOf(cfg.mirrorUrl, recipient.accountId),
    ]);

    // Preflight refuses to pass without it, and this run needs it for the same reason the met
    // one does: the 409 below has to resolve a settlement id, and only the log holds those.
    if (!cfg.subgraphUrl) throw new Error("SUBGRAPH_URL is unset");
    const graph = new GraphClient({ url: cfg.subgraphUrl });

    // The same server `main()` builds, assembled the same way as in `quorum-met.ts`. A scenario
    // that stood up a different coordinator would be describing a different failure.
    const deps: ServerDeps = {
      registry: new PoolRegistry(pools),
      pools,
      facilitator: new Facilitator(cfg.facilitatorUrl),
      failures: new FailureReporter({}),
      network,
      payTo: contractId,
      contractId,
      publicBaseUrl: "http://127.0.0.1",
      coordinatorAccountId: cfg.operatorId,
      coordinatorAddress,
      accountOf: (accountId) => accountOf(cfg.mirrorUrl, accountId),
      coordinatorBalanceTinybars: () => balanceTinybars(cfg.mirrorUrl, cfg.operatorId),
      index: graph,
    };

    report.step("coordinator");
    const coordinator = await startCoordinator(deps);
    report.ok(`listening on ${coordinator.baseUrl}`);

    try {
      const resourceUrl = resourceUrlFor(coordinator.baseUrl, benchmark.slug);

      report.step("open a pool nobody will fill");
      const deadline = Math.floor(Date.now() / 1000) + params.ttlSeconds;
      const created = await pools.createPool({
        recipient: recipientAddress,
        coordinator: coordinatorAddress,
        unitTinybars: seatPriceTinybars,
        threshold,
        deadline,
        resourceUrl,
      });
      const poolId = created.poolId;
      report.ok(`pool ${poolId}, ${threshold} seats at ${hbar(seatPriceTinybars)}`);
      report.info(`resource  ${resourceUrl}`);
      report.info(`open for ${params.ttlSeconds}s, and ${payers.length} of ${threshold} will pay`);

      const contractBefore = await balanceTinybars(cfg.mirrorUrl, contractId);
      // Read before anybody pays, because that is the number a refund has to restore. One at a
      // time rather than concurrently: the run's last assertion rests on these, and a mirror
      // node answering a burst of requests is a rate limit away from turning one of them into a
      // failure that has nothing to do with refunds.
      const before: Before[] = [];
      for (const buyer of payers) {
        before.push({ buyer, tinybars: await balanceTinybars(cfg.mirrorUrl, buyer.accountId) });
      }

      report.step("the crowd falls short");
      const settlements = new Map<string, string>();
      for (const buyer of payers) {
        const result = await buySeat({
          client,
          resourceUrl,
          payerId: buyer.accountId,
          payerKey: PrivateKey.fromStringECDSA(buyer.privateKey),
        });
        report.expect(
          result.status === 202,
          `${buyer.label} paid, 202 - settled, still filling`,
          `${buyer.label} got ${result.status}, expected 202: ${JSON.stringify(result.body)}`,
        );
        if (result.transactionId) settlements.set(buyer.label, result.transactionId);
      }

      report.step("what the chain says");
      const funded = await awaitBalance(cfg.mirrorUrl, contractId, contractBefore + paid);
      report.expect(
        funded - contractBefore === paid,
        `the contract is holding ${hbar(funded - contractBefore)} for ${payers.length} payers`,
        `the contract took in ${hbar(funded - contractBefore)}, expected ${hbar(paid)}`,
      );
      const filling = await pools.statusOf(poolId);
      report.expect(
        filling === "Open",
        `pool ${poolId} is Open`,
        `pool ${poolId} is ${filling}, expected Open`,
      );
      // Counted, not inferred from the 202s. `Open` on its own says nothing about seats: a
      // deposit that settled late is attributed, takes no seat, and leaves the pool exactly as
      // Open as this one is - so a run in which nobody was seated at all would pass every
      // assertion above it and still print "one short". `poolOf` is the only thing that knows.
      const { seats } = await pools.poolOf(poolId);
      report.expect(
        seats === payers.length,
        `${seats} of ${threshold} seats taken - one short, which is the case worth proving`,
        `pool ${poolId} holds ${seats} of ${threshold} seats, expected ${payers.length}`,
      );

      // Done now rather than after the deadline, because the index catches up inside time this
      // run is going to spend waiting anyway. The claimant's 409 is resolved through the log -
      // the transaction id survives nowhere else - so the index sits in the request path on the
      // failure route exactly as it does on the successful one.
      report.step("the index catches up");
      const claimantTx = settlements.get(claimant.label);
      if (!claimantTx) {
        report.bad(`${claimant.label} kept no settlement id, so it cannot be told where to go`);
      } else {
        const depositId = await awaitIndexed(
          report,
          `${claimant.label}'s deposit is indexed`,
          async () => {
            const { depositId: found, indexedBlock } = await graph.depositFor(
              poolId.toString(),
              claimantTx,
            );
            return {
              value: found,
              progress:
                indexedBlock === undefined
                  ? undefined
                  : `index at block ${indexedBlock.toLocaleString()}`,
            };
          },
        );
        if (depositId === undefined) {
          report.bad(`the index never placed ${claimantTx} in pool ${poolId}`);
        }
      }

      report.step("the deadline passes");
      await awaitDeadline(report, deadline);

      // Nothing has been called on this pool. `statusOf` resolves the deadline live, which is
      // the whole of ADR 0004's lazy expiry - the pool is expired because the clock says so,
      // not because anyone remembered to say so. The index cannot see this yet, and
      // `schema.graphql` says so rather than pretending otherwise.
      const state = await pools.statusOf(poolId);
      report.expect(
        state === "Expired",
        `pool ${poolId} reads Expired, and nothing has stamped it`,
        `pool ${poolId} reads ${state} after its deadline, expected Expired`,
      );

      // §6 row 1. A closed pool is not an open pool naming this URL, so a buyer arriving late is
      // turned away before it builds a payment at all - the coordinator stops taking money at
      // the moment it stops being able to honour it, which is half a minute before this.
      report.step("a latecomer is turned away");
      const late = await buySeat({
        client,
        resourceUrl,
        payerId: absent.accountId,
        payerKey: PrivateKey.fromStringECDSA(absent.privateKey),
      });
      report.expect(
        late.status === 404,
        `${absent.label} was refused before paying, 404 - no open pool is selling this`,
        `${absent.label} got ${late.status}, expected 404: ${JSON.stringify(late.body)}`,
      );

      // §6's expired row, which no run has ever produced against a chain: the coordinator does
      // not serve the resource, does not keep the money, and does not ask to be trusted for
      // either - it answers with the contract and the method to call.
      report.step("the payer is told where to go");
      if (claimantTx) {
        const refused = await redeemSeat({
          resourceUrl,
          accountId: claimant.accountId,
          key: PrivateKey.fromStringECDSA(claimant.privateKey),
          network,
          contractId,
          poolId: poolId.toString(),
          transaction: claimantTx,
        });
        const body = refused.body as { error?: string; reclaim?: Record<string, string> };
        const reclaim = body.reclaim;
        // The status alone does not identify the refusal: `statusFor` answers 409 for `no-seat`
        // as well, and that is a different story about a different payer - one who never took a
        // seat, in a pool that may still be filling. Only `pool-expired` is §6's expired row.
        report.expect(
          refused.status === 409 && body.error === "pool-expired",
          `${claimant.label} was refused the resource, 409 pool-expired - it expired short`,
          `${claimant.label} got ${refused.status} ${body.error}, expected 409 pool-expired: ` +
            JSON.stringify(refused.body),
        );
        report.expect(
          reclaim?.contract === contractId &&
            reclaim.poolId === poolId.toString() &&
            reclaim.method === CLAIM_REFUND,
          `and told to call ${reclaim?.method} on ${reclaim?.contract} for pool ${reclaim?.poolId}`,
          `the 409 carried no usable reclaim: ${JSON.stringify(reclaim)}`,
        );
      }

      // Read immediately before the refunds, and bracketing them alone, for the reason
      // `quorum-met.ts` gives about the release: `_totalCommitted` is contract-wide and rose
      // once per deposit earlier in this same run.
      const committedBefore = await pools.committedTinybars();

      report.step("the payer takes their money back");
      const claimed = await claimRefundAs(cfg, contractId, claimant, poolId);
      report.expect(
        claimed === seatPriceTinybars,
        `${claimant.label} pulled back ${hbar(claimed)} with its own key, without the coordinator`,
        `${claimant.label} pulled back ${hbar(claimed)}, expected ${hbar(seatPriceTinybars)}`,
      );

      // §9's second path, and the one that matters for a payer who cannot afford the gas: a
      // bystander pays for the transaction and the money still goes only where the deposits
      // say. The operator is that bystander here, and it receives nothing for it.
      report.step("a bystander pushes out the rest");
      const pushed = await pools.refundAll({
        poolId,
        startIndex: 0n,
        maxDeposits: BigInt(payers.length),
      });
      report.expect(
        pushed.refunded === BigInt(payers.length - 1),
        `pushed ${pushed.refunded} refund(s), skipping the deposit already claimed - ${pushed.gasUsed} gas`,
        `refundAll refunded ${pushed.refunded}, expected ${payers.length - 1}`,
      );

      // The sharpest assertion in the run. A payer that was never refunded by hand, never paid
      // gas and never spoke to anybody after its 202 holds exactly what it held before it paid.
      report.step("everybody is whole");
      for (const { buyer, tinybars } of before) {
        const settled = await awaitBalance(cfg.mirrorUrl, buyer.accountId, tinybars);
        if (buyer.accountId === claimant.accountId) {
          // Down by the gas it chose to spend claiming, which is what needing nobody costs.
          report.info(
            `${buyer.label.padEnd(9)} paid ${hbar(seatPriceTinybars)} and claimed it back, ` +
              `${hbar(settled - tinybars)} against where it started - its own gas`,
          );
          continue;
        }
        report.expect(
          settled === tinybars,
          `${buyer.label} holds exactly what it did before it paid, and it cost it nothing`,
          `${buyer.label} is ${hbar(settled - tinybars)} against where it started, expected level`,
        );
      }

      report.step("the contract owes nobody");
      const committed = await pools.committedTinybars();
      report.expect(
        committedBefore - committed === paid,
        `commitments fell by ${hbar(committedBefore - committed)} - pool ${poolId} is settled`,
        `commitments fell by ${hbar(committedBefore - committed)}, expected ${hbar(paid)}`,
      );
      const emptied = await awaitBalance(cfg.mirrorUrl, contractId, contractBefore);
      report.expect(
        emptied === contractBefore,
        `the contract is back to ${hbar(emptied)} - it kept none of it`,
        `the contract holds ${hbar(emptied - contractBefore)} more than it started with`,
      );

      report.info(`https://hashscan.io/${cfg.network}/contract/${contractId}`);
    } finally {
      await coordinator.close();
    }
  } finally {
    client.close();
  }
}

/**
 * Claim a refund as the payer, through a client of the payer's own.
 *
 * A second Hedera client for one call, because `claimRefund` matches on `msg.sender` and the
 * operator of the run's client is the coordinator. That is not a detail to work around - it is
 * §9's claim made executable, and reusing the coordinator's client would have quietly proved
 * the opposite of what this scenario exists to show.
 */
async function claimRefundAs(
  cfg: Config,
  contractId: string,
  payer: GeneratedAccount,
  poolId: bigint,
): Promise<bigint> {
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(payer.accountId),
    PrivateKey.fromStringECDSA(payer.privateKey),
  );
  try {
    const pools = new PoolsClient(client, ContractId.fromString(contractId));
    return (await pools.claimRefund(poolId)).tinybars;
  } finally {
    client.close();
  }
}

/**
 * Sit out the pool's deadline, saying how much of it is left.
 *
 * The only wait in this project that is not polling for something - a clock needs nothing asked
 * of it - but it reports like the others for the reason `harness.ts` gives: a run that goes
 * quiet for two minutes is indistinguishable from a run that has hung.
 */
async function awaitDeadline(report: Reporter, deadline: number): Promise<void> {
  const remaining = () => deadline - Math.floor(Date.now() / 1000);
  let announced = 0;
  while (remaining() > 0) {
    const left = remaining();
    // The first, then every fifteen seconds, so a two-minute wait is a few lines and not 120.
    if (announced === 0 || announced - left >= 15) {
      report.info(`${left}s until the pool's deadline`);
      announced = left;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  // A second past it, so the coordinator's clock and the network's agree it is behind them.
  await new Promise((r) => setTimeout(r, 1_000));
  report.ok("the deadline passed with the pool one seat short");
}
