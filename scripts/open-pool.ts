/**
 * Open a pool over one benchmark. The seller's action, not the server's.
 *
 * ADR 0003: a pool names its own coordinator and its own recipient at creation, and the
 * contract has no owner. Nothing about opening a pool goes through the resource server - it
 * only finds out that a pool exists by reading the chain, the same way anyone else would.
 *
 * The resource URL is the join between the two halves, and it is exact-matched: the pool
 * stores the string, and the coordinator resolves a request by looking for it. Both sides
 * build it from `PUBLIC_BASE_URL` through `resourceUrlFor`, so there is one spelling.
 *
 * Run: npm run pool:open -- --slug agent-spend-eu [--ttl 900] [--threshold 3]
 *                          [--hbar 1] [--recipient <label|0.0.x>]
 */
import { AccountId, Client, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import { BENCHMARKS, benchmarkFor, resourceUrlFor } from "../src/benchmark/catalogue.js";
import { caip2, loadConfig } from "../src/config.js";
import { evmAddressOf } from "../src/hedera/mirror.js";
import { PoolsClient } from "../src/pool/client.js";
import { readDeployment } from "../src/pool/deployment.js";
import { hbarToTinybars } from "../src/x402/hedera-exact.js";
import { loadAccounts } from "./accounts.js";

/** Long enough to run a demo unhurried, short enough that a forgotten pool expires today. */
const DEFAULT_TTL_SECONDS = 900;

interface Args {
  slug: string;
  ttl: number;
  threshold?: number;
  hbar?: string;
  recipient?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { slug: "", ttl: DEFAULT_TTL_SECONDS };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case "--slug":
        args.slug = next ?? "";
        i++;
        break;
      case "--ttl":
        args.ttl = Number(next ?? DEFAULT_TTL_SECONDS);
        i++;
        break;
      case "--threshold":
        args.threshold = Number(next);
        i++;
        break;
      case "--hbar":
        // Stays text all the way to `hbarToTinybars`; Number() would turn a small amount into
        // scientific notation on the way through.
        args.hbar = next;
        i++;
        break;
      case "--recipient":
        args.recipient = next;
        i++;
        break;
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  if (!args.slug) {
    throw new Error(
      `--slug is required. Available: ${BENCHMARKS.map((b) => b.slug).join(", ")}`,
    );
  }
  if (!Number.isFinite(args.ttl) || args.ttl < 60) {
    throw new Error(`--ttl must be at least 60 seconds, got ${args.ttl}`);
  }
  return args;
}

/**
 * Where the money goes if the pool fills.
 *
 * A label from `.accounts.json`, a raw `0.0.x`, or the operator. The operator is the default
 * because this repository's throwaway accounts are all buyers - and a buyer must not be the
 * recipient, or the demo pays a payer.
 */
function resolveRecipient(recipient: string | undefined, network: string, operatorId: string) {
  if (!recipient) return { accountId: operatorId, isOperator: true };
  if (/^\d+\.\d+\.\d+$/.test(recipient)) return { accountId: recipient, isOperator: false };
  const account = loadAccounts(network).find((a) => a.label === recipient);
  if (!account) {
    const labels = loadAccounts(network)
      .map((a) => a.label)
      .join(", ");
    throw new Error(`no account labelled "${recipient}". Available: ${labels}`);
  }
  return { accountId: account.accountId, isOperator: false };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const network = caip2(cfg.network);

  const benchmark = benchmarkFor(args.slug);
  if (!benchmark) {
    throw new Error(
      `no benchmark "${args.slug}". Available: ${BENCHMARKS.map((b) => b.slug).join(", ")}`,
    );
  }

  const contractId = readDeployment(network)?.contractId;
  if (!contractId) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const threshold = args.threshold ?? benchmark.minimumContributors;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`--threshold must be a whole number of seats, got ${args.threshold}`);
  }
  if (threshold < benchmark.minimumContributors) {
    // Worth refusing rather than warning. The floor is the reason this resource is sold to a
    // crowd at all, and a pool opened below it would publish the aggregate to a panel small
    // enough to recover an individual contributor from it.
    throw new Error(
      `${benchmark.slug} may not be published to fewer than ${benchmark.minimumContributors} ` +
        `distinct buyers; --threshold ${threshold} is below its suppression floor`,
    );
  }

  const unitTinybars = hbarToTinybars(args.hbar ?? benchmark.seatPriceHbar);
  const resourceUrl = resourceUrlFor(cfg.publicBaseUrl, benchmark.slug);
  const recipientAccount = resolveRecipient(args.recipient, cfg.network, cfg.operatorId);

  const [coordinator, recipient] = await Promise.all([
    evmAddressOf(cfg.mirrorUrl, cfg.operatorId),
    evmAddressOf(cfg.mirrorUrl, recipientAccount.accountId),
  ]);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(contractId));

  try {
    const deadline = Math.floor(Date.now() / 1000) + args.ttl;
    const created = await pools.createPool({
      recipient,
      coordinator,
      unitTinybars,
      threshold,
      deadline,
      resourceUrl,
    });

    console.log(`\npool ${created.poolId} open on ${network}\n`);
    console.log(`  benchmark    ${benchmark.id}`);
    console.log(`  resource     ${resourceUrl}`);
    console.log(`  seat price   ${unitTinybars} tinybars`);
    console.log(`  threshold    ${threshold} distinct buyers`);
    console.log(`  deadline     ${new Date(deadline * 1000).toISOString()} (${args.ttl}s)`);
    console.log(`  coordinator  ${cfg.operatorId}  ${coordinator}`);
    console.log(`  recipient    ${recipientAccount.accountId}  ${recipient}`);
    console.log(`  contract     ${contractId}`);
    console.log(`  created by   ${created.transactionId}  (${created.gasUsed} gas)`);
    if (recipientAccount.isOperator) {
      console.log(
        `\n  note: the seller and the coordinator are the same account in this run.\n` +
          `        Pass --recipient <label|0.0.x> to keep them apart, which is what ADR 0003\n` +
          `        assumes and what a real deployment would do.`,
      );
    }
    console.log(`\n  serve it with: PUBLIC_BASE_URL=${cfg.publicBaseUrl} npm run server\n`);
  } finally {
    client.close();
  }
}

await main();
