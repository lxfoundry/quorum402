/**
 * Attribute a settled payment by hand, from a failure log line.
 *
 * [ADR 0006](../specs/adr/0006-nothing-settles-until-recording-can-succeed.md) §4's manual
 * drain. When the coordinator settles a payment and cannot record it, it writes one structured
 * line to stderr carrying every field this needs - and the command to run, already assembled.
 * Fix the cause (usually: fund the coordinator), then replay:
 *
 *   npm run record -- <poolId> <payerEvmAddress> <tinybars> <hederaTxId>
 *
 * **Safe to run twice.** The contract hashes `hederaTxId` into a permanent guard, so a payment
 * can be attributed exactly once however many times this is called. A second run reverts
 * `DuplicateTransaction`, which this reports as "already recorded" rather than as a failure -
 * that is the answer, not an error.
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { caip2, loadConfig } from "../src/config.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";

const USAGE = "npm run record -- <poolId> <payerEvmAddress> <tinybars> <hederaTxId>";

/** `<shard>.<realm>.<num>@<seconds>.<nanos>`, as the SDK renders it. */
const HEDERA_TX_ID = /^\d+\.\d+\.\d+@\d+\.\d+$/;

function parseArgs(argv: string[]) {
  const [poolId, payer, tinybars, hederaTxId, ...rest] = argv;
  if (!poolId || !payer || !tinybars || !hederaTxId || rest.length) {
    throw new Error(`expected four arguments.\n  ${USAGE}`);
  }
  if (!/^\d+$/.test(poolId)) throw new Error(`poolId must be a whole number, got "${poolId}"`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) {
    throw new Error(
      `payer must be a 20-byte EVM address, got "${payer}".\n` +
        `It is the address the network holds for the paying account - the one in the log line, ` +
        `not one derived from a key.`,
    );
  }
  if (!/^\d+$/.test(tinybars) || BigInt(tinybars) <= 0n) {
    throw new Error(`tinybars must be a positive whole number, got "${tinybars}"`);
  }
  if (!HEDERA_TX_ID.test(hederaTxId)) {
    throw new Error(`hederaTxId must look like 0.0.1235@1700000000.000000000, got "${hederaTxId}"`);
  }
  return { poolId: BigInt(poolId), payer, tinybars: BigInt(tinybars), hederaTxId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const network = caip2(cfg.network);

  const contractId = readDeployment(network)?.contractId;
  if (!contractId) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(contractId));

  console.log(`\nattributing ${args.hederaTxId} to pool ${args.poolId} on ${network}\n`);
  try {
    const deposit = await pools.recordDeposit(args);
    console.log(`  recorded deposit ${deposit.depositId}, ${deposit.gasUsed} gas`);
    console.log(
      deposit.counted
        ? `  it took a seat`
        : `  it took no seat - late on arrival, and refundable at once (ADR 0004)`,
    );
  } catch (error) {
    const reason = await revertReasonOf(pools, error);
    if (reason === "DuplicateTransaction") {
      // The whole point of the replay guard. Not a failure, and not something to fix.
      console.log(`  already recorded. The contract refuses a payment twice, so nothing to do.`);
      return;
    }
    // Say which contract error fired where it can be read. `CONTRACT_REVERT_EXECUTED` on its
    // own sends a reader to the wrong place - `NotCoordinator` and `Insolvent` need opposite
    // responses, and neither is "retry harder".
    throw new Error(reason ? `${reason}: ${(error as Error).message}` : (error as Error).message);
  } finally {
    client.close();
  }
}

async function revertReasonOf(pools: PoolsClient, error: unknown): Promise<string | undefined> {
  const transactionId = (error as { transactionId?: { toString(): string } } | null)?.transactionId;
  if (!transactionId) return undefined;
  return pools.revertReasonOf(transactionId.toString());
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
