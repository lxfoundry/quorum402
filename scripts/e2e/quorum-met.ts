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
import type { Benchmark } from "../../src/benchmark/catalogue.js";
import { caip2 } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { GraphClient } from "../../src/graph/client.js";
import { accountOf, awaitBalance, balanceTinybars, evmAddressOf } from "../../src/hedera/mirror.js";
import { PoolsClient } from "../../src/pool/client.js";
import { FailureReporter } from "../../src/server/failures.js";
import { PoolRegistry } from "../../src/server/pools.js";
import type { ServerDeps } from "../../src/server/index.js";
import { Facilitator } from "../../src/x402/facilitator.js";
import { buySeat } from "../../src/buyer/agent.js";
import type { GeneratedAccount } from "../create-accounts.js";
import { hbar, startCoordinator } from "./harness.js";
import type { Reporter } from "./harness.js";

export interface ScenarioParams {
  cfg: Config;
  benchmark: Benchmark;
  contractId: string;
  buyers: GeneratedAccount[];
  recipient: GeneratedAccount;
  seatPriceTinybars: bigint;
  ttlSeconds: number;
}

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
      index: cfg.subgraphUrl ? new GraphClient({ url: cfg.subgraphUrl }) : undefined,
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

      report.info(`https://hashscan.io/${cfg.network}/contract/${contractId}`);
    } finally {
      await coordinator.close();
    }
  } finally {
    client.close();
  }
}
