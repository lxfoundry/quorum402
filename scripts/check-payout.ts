/**
 * Does a released pool pay its recipient exactly what the buyer put in?
 *
 * This is the one question the local suite cannot answer, and the first run of this script
 * answered it the other way from what the spec had assumed: the contract had been written
 * believing Hedera's EVM denominates value in 18-decimal weibars, and it does not. Both sides
 * of the local comparison were written here, so the suite could only ever confirm that this
 * repository agreed with itself.
 *
 * So this asks the network, twice and in two directions:
 *
 *   1. the contract's own `balanceTinybars()` - `address(this).balance` unmodified - against
 *      the balance the mirror node reports, which is Hedera's own accounting in tinybars
 *   2. the recipient's balance either side of a real `release`, which puts `call{value:}` on
 *      the same scale from the other end
 *
 * One pool, threshold 1, one real x402 payment, one release. It spends testnet HBAR and
 * leaves a released pool behind, so keep `--hbar` small.
 *
 * Run: npm run check:payout
 *      npm run check:payout -- --hbar 0.25 --buyer buyer1 --recipient buyer3
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { caip2, loadConfig } from "../src/config.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";
import { hashscanContract } from "../src/hedera/explorer.js";
import { awaitBalance, balanceTinybars, evmAddressOf } from "../src/hedera/mirror.js";
import { Facilitator } from "../src/x402/facilitator.js";
import {
  HBAR_ASSET,
  buildPartiallySignedTransfer,
  buildPaymentPayload,
  hbarToTinybars,
} from "../src/x402/hedera-exact.js";
import { settlementTxId } from "../src/x402/types.js";
import type { PaymentRequirements, ResourceDescriptor } from "../src/x402/types.js";
import { loadAccounts, loadBuyer } from "./accounts.js";

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

/** How long the pool stays open. Long enough to settle a payment, short enough to forget. */
const POOL_SECONDS = 600;

interface Args {
  hbar: string;
  buyer?: string;
  recipient?: string;
  contract?: string;
}

function parseArgs(argv: string[]): Args {
  // The amount stays text until it reaches `hbarToTinybars`: Number() would turn a small
  // amount into scientific notation on the way through.
  const args: Args = { hbar: "0.25" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--hbar":
        args.hbar = argv[++i] ?? "0.25";
        break;
      case "--buyer":
        args.buyer = argv[++i];
        break;
      case "--recipient":
        args.recipient = argv[++i];
        break;
      case "--contract":
        args.contract = argv[++i];
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const unitTinybars = hbarToTinybars(args.hbar);
  if (unitTinybars <= 0n) throw new Error("--hbar must be greater than zero");

  const contractId = args.contract ?? readDeployment(network)?.contractId;
  if (!contractId) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const buyer = loadBuyer(args.buyer, cfg.network);
  // The recipient must not be the operator: the operator pays the fees for every call below,
  // so its balance moves for reasons that have nothing to do with the payout, and the
  // measurement stops meaning anything.
  const recipientAccount =
    args.recipient !== undefined
      ? loadBuyer(args.recipient, cfg.network)
      : loadAccounts(cfg.network).find((a) => a.accountId !== buyer.accountId);
  if (!recipientAccount) {
    throw new Error("need a second account to receive the payout. Run: npm run accounts:create -- 3");
  }

  console.log(`\none pool, one payment, one payout on ${network}\n`);
  let failures = 0;

  console.log("parties");
  const coordinator = await evmAddressOf(cfg.mirrorUrl, cfg.operatorId);
  const payer = await evmAddressOf(cfg.mirrorUrl, buyer.accountId);
  const recipient = await evmAddressOf(cfg.mirrorUrl, recipientAccount.accountId);
  info(`pool        ${contractId}`);
  info(`coordinator ${cfg.operatorId}  ${coordinator}`);
  info(`buyer       ${buyer.accountId}  ${payer}`);
  info(`recipient   ${recipientAccount.accountId}  ${recipient}`);
  info(`unit price  ${unitTinybars} tinybars (${args.hbar} HBAR)`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(contractId));
  const facilitator = new Facilitator(cfg.facilitatorUrl);

  try {
    console.log("\nbefore");
    const contractBefore = await balanceTinybars(cfg.mirrorUrl, contractId);
    const recipientBefore = await balanceTinybars(cfg.mirrorUrl, recipientAccount.accountId);
    info(`contract  ${contractBefore} tinybars`);
    info(`recipient ${recipientBefore} tinybars`);

    console.log("\ncreate pool");
    const deadline = Math.floor(Date.now() / 1000) + POOL_SECONDS;
    const created = await pools.createPool({
      recipient,
      coordinator,
      unitTinybars,
      threshold: 1,
      deadline,
      resourceUrl: "https://quorum402.example/pool/first-payout",
    });
    ok(`pool ${created.poolId}, threshold 1, ${created.gasUsed} gas`);

    console.log("\npay");
    const feePayer = await facilitator.feePayerFor(network);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network,
      amount: unitTinybars.toString(),
      asset: HBAR_ASSET,
      payTo: contractId,
      maxTimeoutSeconds: 120,
      extra: { feePayer },
    };
    const resource: ResourceDescriptor = {
      url: "https://quorum402.example/pool/first-payout",
      description: "quorum402 first pooled payout",
      mimeType: "application/json",
    };
    const transaction = await buildPartiallySignedTransfer({
      client,
      payerId: AccountId.fromString(buyer.accountId),
      payerKey: PrivateKey.fromStringECDSA(buyer.privateKey),
      requirements,
    });
    const payload = buildPaymentPayload({ resource, requirements, transactionBase64: transaction });
    const settlement = await facilitator.settle(payload, requirements);
    if (!settlement.success) {
      bad(`settlement failed: ${settlement.errorReason ?? "no reason given"}`);
      return failures + 1;
    }
    const hederaTxId = settlementTxId(settlement);
    if (!hederaTxId) {
      bad(`settled, but the response names no transaction id: ${JSON.stringify(settlement)}`);
      return failures + 1;
    }
    ok(`settled ${hederaTxId}`);

    const funded = await awaitBalance(cfg.mirrorUrl, contractId, contractBefore + unitTinybars);
    if (funded === contractBefore + unitTinybars) {
      ok(`contract holds ${funded} tinybars, up by the unit price`);
    } else {
      bad(`contract holds ${funded} tinybars, expected ${contractBefore + unitTinybars}`);
      failures++;
    }

    // The first of the two unit checks, and it only means anything with money in the contract:
    // `balanceTinybars()` returns `address(this).balance` straight out of the EVM, so agreeing
    // with the mirror node says the EVM counts in tinybars - not in the 18-decimal weibars the
    // JSON-RPC relay shows Ethereum tooling. Run against an empty contract it passes on 0 == 0
    // and proves nothing, which is how the wrong unit survived being written down.
    const selfReported = await pools.balanceTinybars();
    if (selfReported === funded && funded > 0n) {
      ok(`the contract reads its own balance as ${selfReported} - the EVM counts in tinybars`);
    } else {
      bad(`the contract reads its balance as ${selfReported}, the network says ${funded}`);
      failures++;
    }

    console.log("\nrecord the deposit");
    const deposit = await pools.recordDeposit({
      poolId: created.poolId,
      payer,
      tinybars: unitTinybars,
      hederaTxId,
    });
    // `recordDeposit` never reverts for a buyer-side reason (ADR 0004), so "it succeeded" is
    // not the check - whether the deposit took a seat is.
    if (deposit.counted) {
      ok(`deposit ${deposit.depositId} took a seat, ${deposit.gasUsed} gas`);
    } else {
      bad(`deposit ${deposit.depositId} was recorded late and took no seat`);
      failures++;
    }
    const state = await pools.statusOf(created.poolId);
    if (state === "Met") {
      ok("pool state: Met");
    } else {
      bad(`pool state: ${state}, expected Met`);
      failures++;
    }

    console.log("\nrelease");
    const released = await pools.release(created.poolId);
    ok(`released, ${released.gasUsed} gas`);

    const paid = await awaitBalance(
      cfg.mirrorUrl,
      recipientAccount.accountId,
      recipientBefore + unitTinybars,
    );
    const delta = paid - recipientBefore;
    if (delta === unitTinybars) {
      ok(`recipient received exactly ${delta} tinybars`);
    } else {
      bad(`recipient received ${delta} tinybars, expected ${unitTinybars}`);
      info(
        delta === 0n
          ? "the payout did not land"
          : `off by a factor of ${Number(delta) / Number(unitTinybars)}`,
      );
      failures++;
    }

    const committed = await pools.committedTinybars();
    if (committed === 0n) {
      ok("nothing left committed - the pool owes nobody");
    } else {
      bad(`${committed} tinybars still committed after release`);
      failures++;
    }

    info(hashscanContract(cfg.network, contractId));
  } finally {
    client.close();
  }

  return failures;
}

main().then(
  (failures) => {
    console.log(
      failures === 0
        ? "\nthe EVM moves tinybars, in and out - observed, not documented\n"
        : `\nFAILED with ${failures} problem(s)\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(`\nFAILED: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
