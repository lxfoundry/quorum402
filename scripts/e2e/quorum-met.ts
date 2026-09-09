/**
 * The scenario the project exists for: a crowd answers one 402 together.
 *
 * Three distinct buyers pay for seats in one pool, through the coordinator, against Hedera
 * testnet and the real facilitator. The first two are told **202** - settled, resource still
 * pending, the crowd has not arrived - which is the row of `quorum-scheme.md` §6's status table
 * that exists nowhere else in x402. The third fills the pool and is told **200**.
 *
 * Everything asserted here is read back from a network rather than from this repository. The
 * unit suite already checks that this code agrees with itself; what it cannot check is that the
 * agreement is with Hedera.
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { resourceUrlFor } from "../../src/benchmark/catalogue.js";
import { caip2 } from "../../src/config.js";
import { GraphClient } from "../../src/graph/client.js";
import { hashscanContract } from "../../src/hedera/explorer.js";
import { accountOf, awaitBalance, balanceTinybars, evmAddressOf } from "../../src/hedera/mirror.js";
import { PoolsClient } from "../../src/pool/client.js";
import { FailureReporter } from "../../src/server/failures.js";
import { PoolRegistry } from "../../src/server/pools.js";
import type { ServerDeps } from "../../src/server/index.js";
import { Facilitator } from "../../src/x402/facilitator.js";
import { buySeat, redeemSeat } from "../../src/buyer/agent.js";
import { awaitIndexed, hbar, startCoordinator } from "./harness.js";
import type { Reporter, ScenarioParams } from "./harness.js";

export async function quorumMet(report: Reporter, params: ScenarioParams): Promise<void> {
  const { cfg, benchmark, contractId, buyers, recipient, seatPriceTinybars } = params;
  const network = caip2(cfg.network);
  const threshold = buyers.length;
  const total = seatPriceTinybars * BigInt(threshold);

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

    // Preflight refuses to pass without it, because redemption is half of what this run
    // proves and a coordinator with no index answers it 501.
    if (!cfg.subgraphUrl) throw new Error("SUBGRAPH_URL is unset");
    const graph = new GraphClient({ url: cfg.subgraphUrl });

    // Built exactly as `main()` builds it - the same registry, the same facilitator client, the
    // same mirror reads. A scenario that assembled a different server would be testing a
    // different server.
    const deps: ServerDeps = {
      registry: new PoolRegistry(pools),
      pools,
      facilitator: new Facilitator(cfg.facilitatorUrl),
      failures: new FailureReporter({}),
      network,
      payTo: contractId,
      contractId,
      // Replaced by `startCoordinator` once the port is known. Never served.
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

      report.step("open a pool");
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
      report.info(`recipient ${recipient.label} ${recipient.accountId} ${recipientAddress}`);

      const contractBefore = await balanceTinybars(cfg.mirrorUrl, contractId);
      const recipientBefore = await balanceTinybars(cfg.mirrorUrl, recipient.accountId);

      report.step("the crowd arrives");
      const settlements = new Map<string, string>();
      for (const [seat, buyer] of buyers.entries()) {
        const last = seat === buyers.length - 1;
        const expected = last ? 200 : 202;
        const result = await buySeat({
          client,
          resourceUrl,
          payerId: buyer.accountId,
          payerKey: PrivateKey.fromStringECDSA(buyer.privateKey),
        });
        report.expect(
          result.status === expected,
          `${buyer.label} paid, ${result.status} ` +
            (last ? "- the pool is full and the resource is served" : "- settled, still filling"),
          `${buyer.label} got ${result.status}, expected ${expected}: ${JSON.stringify(result.body)}`,
        );
        if (result.transactionId) settlements.set(buyer.label, result.transactionId);
        if (last && result.status === 200) {
          // A 200 is only worth having if it carries the thing that was bought. The licence
          // names the pool it descends from, so this also checks the resource is this run's.
          const licensed = result.body as { benchmark?: string; poolId?: string };
          report.expect(
            licensed.benchmark === benchmark.id && licensed.poolId === poolId.toString(),
            `served ${licensed.benchmark} licensed under pool ${licensed.poolId}`,
            `200 carried ${JSON.stringify(result.body)}, expected a licence for ${benchmark.id}`,
          );
        }
      }

      report.step("what the chain says");
      const funded = await awaitBalance(cfg.mirrorUrl, contractId, contractBefore + total);
      report.expect(
        funded - contractBefore === total,
        `the contract took in ${hbar(funded - contractBefore)}, the price of ${threshold} seats`,
        `the contract took in ${hbar(funded - contractBefore)}, expected ${hbar(total)}`,
      );
      const state = await pools.statusOf(poolId);
      report.expect(state === "Met", `pool ${poolId} is Met`, `pool ${poolId} is ${state}, expected Met`);

      // §8. What a payer holds after a 202 is a settlement id and a private key - no session,
      // no cookie, nothing the coordinator wrote down. This is the half of the primitive that
      // exists only because payment and delivery are separated in time.
      report.step("the index catches up");
      const claimant = buyers[0];
      if (!claimant) throw new Error("no buyers");
      const claimantTx = settlements.get(claimant.label);
      if (!claimantTx) {
        report.bad(`${claimant.label} kept no settlement id, so its seat cannot be redeemed`);
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
        } else {
          // `counted` comes from the contract, never from the index. The index resolves a
          // settlement to a *position*; whether that position took a seat is what entitlement
          // turns on, and consensus is the only thing that may answer it.
          const deposit = await pools.depositAt(poolId, depositId);
          report.expect(
            deposit.counted,
            `deposit ${depositId} took a seat - read back from the contract, not the index`,
            `deposit ${depositId} is recorded but took no seat`,
          );

          report.step("redeem a seat");
          const redeemed = await redeemSeat({
            resourceUrl,
            accountId: claimant.accountId,
            key: PrivateKey.fromStringECDSA(claimant.privateKey),
            network,
            contractId,
            poolId: poolId.toString(),
            transaction: claimantTx,
          });
          const licensed = redeemed.body as { benchmark?: string; licensee?: string };
          report.expect(
            redeemed.status === 200 && licensed.benchmark === benchmark.id,
            `${claimant.label} redeemed its seat with a signature, ${redeemed.status}`,
            `${claimant.label} got ${redeemed.status}: ${JSON.stringify(redeemed.body)}`,
          );

          // The check that gives the one above its meaning. A receipt naming someone else's
          // settlement is signed perfectly well - the signature is the claimant's own - so the
          // only thing that can refuse it is the payer check against consensus state. Without
          // this, a redemption that verified nothing but the signature would pass just as
          // happily, and the 200 above would prove only that the server answers.
          const impostor = buyers[1];
          if (impostor) {
            const stolen = await redeemSeat({
              resourceUrl,
              accountId: impostor.accountId,
              key: PrivateKey.fromStringECDSA(impostor.privateKey),
              network,
              contractId,
              poolId: poolId.toString(),
              transaction: claimantTx,
            });
            report.expect(
              stolen.status === 403,
              `${impostor.label} was refused ${claimant.label}'s settlement, 403 - a seat is the payer's, not the bearer's`,
              `${impostor.label} presenting ${claimant.label}'s settlement got ${stolen.status}, expected 403`,
            );
          }
        }
      }

      report.step("release");
      // Read immediately before, and bracketing the release alone. `_totalCommitted` is
      // contract-wide and moves twice in this scenario - up as each deposit is recorded, down
      // when `_payout` sees the HBAR actually leave - so a snapshot taken before the buyers
      // arrived would net to zero across the run and assert nothing about the payout.
      const committedBefore = await pools.committedTinybars();
      const released = await pools.release(poolId);
      report.ok(`released, ${released.gasUsed} gas`);
      const paid = await awaitBalance(
        cfg.mirrorUrl,
        recipient.accountId,
        recipientBefore + total,
      );
      report.expect(
        paid - recipientBefore === total,
        `${recipient.label} received exactly ${hbar(paid - recipientBefore)}`,
        `${recipient.label} received ${hbar(paid - recipientBefore)}, expected ${hbar(total)}`,
      );
      const committed = await pools.committedTinybars();
      report.expect(
        committedBefore - committed === total,
        `the contract's commitments fell by ${hbar(committedBefore - committed)} - pool ${poolId} owes nobody`,
        `commitments fell by ${hbar(committedBefore - committed)}, expected ${hbar(total)}`,
      );

      report.info(hashscanContract(cfg.network, contractId));
    } finally {
      await coordinator.close();
    }
  } finally {
    client.close();
  }
}
