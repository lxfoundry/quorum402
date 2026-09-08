/**
 * Can an x402 `exact` payment name a CONTRACT as `payTo`?
 *
 * The whole attribution design rests on it. ADR 0002 puts the pool contract's own Hedera
 * account in `payTo` so that funds land in the contract at the moment of settlement, never in
 * a coordinator's custody. If the facilitator validates `payTo` as an *account* entity and
 * rejects a contract id, that decision does not work and attribution has to be reopened -
 * which is much cheaper to discover before the contract exists than after.
 *
 * Two things are actually in question, and they fail in different places:
 *
 *   1. the facilitator's verification rules  -> /verify answers this, and moves nothing
 *   2. the network itself, since a native CryptoTransfer to a contract executes no code and
 *      might plausibly be refused outright -> only a real settlement answers this
 *
 * So the default run is read-only. Pass --settle to send a real payment and confirm on the
 * mirror node that the contract's balance actually moved.
 *
 * The target defaults to the most recently created contract on testnet, which is deliberate:
 * the test is about the *kind* of entity, not about owning it. Settled funds go to a stranger
 * and are not recoverable, so keep the amount small. Pass --contract 0.0.x to choose one.
 *
 * Run: npm run check:payto
 *      npm run check:payto -- --settle
 *      npm run check:payto -- --contract 0.0.10407447 --settle --amount 0.1
 */
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { caip2, loadConfig } from "../src/config.js";
import { Facilitator } from "../src/x402/facilitator.js";
import {
  HBAR_ASSET,
  buildPartiallySignedTransfer,
  buildPaymentPayload,
  hbarToTinybars,
} from "../src/x402/hedera-exact.js";
import { settlementTxId } from "../src/x402/types.js";
import type { PaymentRequirements, ResourceDescriptor } from "../src/x402/types.js";
import { loadBuyer } from "./accounts.js";

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

interface Args {
  contract?: string;
  amountHbar: string;
  settle: boolean;
  buyer?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { amountHbar: "0.1", settle: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--settle":
        args.settle = true;
        break;
      case "--contract":
        args.contract = argv[++i];
        break;
      case "--amount":
        // Kept as text. Number() would turn small amounts into scientific notation before
        // they ever reach the tinybar conversion.
        args.amountHbar = argv[++i] ?? "0.1";
        break;
      case "--buyer":
        args.buyer = argv[++i];
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return args;
}

/** The newest contract the mirror node knows about. Any contract answers the question. */
async function newestContract(mirrorUrl: string): Promise<string> {
  const res = await fetch(`${mirrorUrl}/api/v1/contracts?limit=5&order=desc`);
  if (!res.ok) throw new Error(`mirror node returned ${res.status} listing contracts`);
  const body = (await res.json()) as { contracts?: { contract_id?: string; deleted?: boolean }[] };
  const found = (body.contracts ?? []).find((c) => c.contract_id && !c.deleted);
  if (!found?.contract_id) throw new Error("mirror node listed no live contracts");
  return found.contract_id;
}

/**
 * Confirm the target really is a contract and not an account that merely looks like one.
 * A false pass here would be the worst outcome available: it would read as evidence for the
 * design while proving nothing about contracts at all.
 */
async function assertIsContract(mirrorUrl: string, id: string): Promise<void> {
  const res = await fetch(`${mirrorUrl}/api/v1/contracts/${id}`);
  if (res.status === 404) {
    throw new Error(`${id} is not a contract on this network (mirror node has no contract record)`);
  }
  if (!res.ok) throw new Error(`mirror node returned ${res.status} for contract ${id}`);
  const body = (await res.json()) as { deleted?: boolean; evm_address?: string };
  if (body.deleted) throw new Error(`contract ${id} is deleted`);
  ok(`${id} is a contract (evm ${body.evm_address ?? "unknown"})`);
}

async function balanceTinybars(mirrorUrl: string, id: string): Promise<number> {
  const res = await fetch(`${mirrorUrl}/api/v1/accounts/${id}?limit=1`);
  if (!res.ok) throw new Error(`mirror node returned ${res.status} for account ${id}`);
  const body = (await res.json()) as { balance?: { balance?: number } };
  return body.balance?.balance ?? 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const amountTinybars = hbarToTinybars(args.amountHbar);
  if (amountTinybars <= 0n) throw new Error(`amount must be greater than zero`);

  console.log("\ncan an x402 exact payment name a contract as payTo?\n");

  console.log("target");
  const contractId = args.contract ?? (await newestContract(cfg.mirrorUrl));
  await assertIsContract(cfg.mirrorUrl, contractId);
  const before = await balanceTinybars(cfg.mirrorUrl, contractId);
  info(`balance before: ${before} tinybars`);

  console.log("\npayment");
  const buyer = loadBuyer(args.buyer, cfg.network);
  const facilitator = new Facilitator(cfg.facilitatorUrl);
  const feePayer = await facilitator.feePayerFor(network);
  info(`payer     ${buyer.accountId} (${buyer.label})`);
  info(`payTo     ${contractId}  <- a contract, not an account`);
  info(`amount    ${amountTinybars} tinybars (${args.amountHbar} HBAR)`);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    amount: amountTinybars.toString(),
    asset: HBAR_ASSET,
    payTo: contractId,
    maxTimeoutSeconds: 120,
    extra: { feePayer },
  };
  const resource: ResourceDescriptor = {
    url: "https://quorum402.example/preflight/contract-payto",
    description: "ADR 0002 preflight: contract as payTo",
    mimeType: "application/json",
  };

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  let failures = 0;

  try {
    const transaction = await buildPartiallySignedTransfer({
      client,
      payerId: AccountId.fromString(buyer.accountId),
      payerKey: PrivateKey.fromStringECDSA(buyer.privateKey),
      requirements,
    });
    ok("buyer signed a transfer naming the contract as recipient");

    const payload = buildPaymentPayload({ resource, requirements, transactionBase64: transaction });

    console.log("\nfacilitator /verify");
    const verification = await facilitator.verify(payload, requirements);
    if (verification.isValid) {
      ok("accepted - the facilitator does not require payTo to be an account");
    } else {
      bad(`rejected: ${verification.invalidReason ?? "no reason given"}`);
      info("ADR 0002 Option A does not work as written. Attribution reopens.");
      return 1;
    }

    if (!args.settle) {
      console.log("\nverify only. Re-run with --settle to prove the network credits it too.\n");
      return 0;
    }

    console.log("\nfacilitator /settle");
    const settlement = await facilitator.settle(payload, requirements);
    if (!settlement.success) {
      bad(`settlement failed: ${settlement.errorReason ?? "no reason given"}`);
      info("verify passed but the network or the facilitator refused the real transfer.");
      return 1;
    }
    const txId = settlementTxId(settlement);
    ok(`settled${txId ? `  txId=${txId}` : ""}`);
    if (!txId) info(`raw response: ${JSON.stringify(settlement)}`);

    console.log("\nledger");
    // The facilitator saying "success" is a claim; the balance is the record. This is the
    // step that proves a native CryptoTransfer credits a contract with no code executed.
    const expected = before + Number(amountTinybars);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const after = await balanceTinybars(cfg.mirrorUrl, contractId);
      if (after >= expected) {
        ok(`contract balance ${before} -> ${after} tinybars (+${after - before})`);
        info(`https://hashscan.io/testnet/account/${contractId}`);
        return failures;
      }
      if (attempt === 10) {
        bad(`contract balance is ${after}, expected ${expected} - the credit did not land`);
        failures++;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    client.close();
  }

  return failures;
}

main().then(
  (code) => {
    console.log(code === 0 ? "\nADR 0002 Option A holds.\n" : "\nADR 0002 Option A is in doubt.\n");
    process.exit(code === 0 ? 0 : 1);
  },
  (err) => {
    console.error(`\nFAILED: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
