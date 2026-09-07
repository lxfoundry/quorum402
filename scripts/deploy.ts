/**
 * Put QuorumPools on Hedera.
 *
 * Deployment goes through the SDK rather than a JSON-RPC relay, which is why
 * `hardhat.config.ts` has no network entry: the contract's Hedera *entity id* is what x402
 * needs in `PaymentRequirements.payTo`, and the SDK is what hands that back. A relay would
 * return an EVM address and leave the entity id to be looked up afterwards.
 *
 * The contract is created with NO ADMIN KEY. That is the deployment expressing what ADR 0003
 * decided: nobody owns this contract, so nobody may update or delete it. It is also
 * irreversible - a contract created without an admin key can never be given one.
 *
 * Run: npm run build && npm run deploy
 */
import { Client, ContractCreateFlow, Hbar, AccountId, PrivateKey } from "@hiero-ledger/sdk";
import { caip2, loadConfig } from "../src/config.js";
import {
  CONTRACT_NAME,
  codeHashOf,
  readArtifact,
  readDeployment,
  writeDeployment,
} from "../src/pool/deployment.js";
import type { Deployment } from "../src/pool/deployment.js";

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

/**
 * Sized with headroom rather than trimmed. An INSUFFICIENT_GAS failure costs the fee and a
 * second run, while unused gas is refunded only up to 20% of the limit - so being wrong low
 * is worse than being wrong high, but not by much. The run prints what it actually used.
 */
const DEFAULT_GAS = 3_000_000;

interface Args {
  force: boolean;
  gas: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, gas: DEFAULT_GAS };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--force":
        args.force = true;
        break;
      case "--gas": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value <= 0) throw new Error(`--gas must be a positive integer`);
        args.gas = value;
        break;
      }
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return args;
}

interface MirrorContract {
  evm_address?: string;
  runtime_bytecode?: string;
  admin_key?: unknown;
}

/**
 * Read the contract back from the mirror node. The receipt says a contract id was created;
 * only the runtime bytecode says *which* contract it is, and the ingestion lag means it is
 * not there the instant the receipt arrives.
 */
async function fetchDeployedContract(mirrorUrl: string, contractId: string): Promise<MirrorContract> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await fetch(`${mirrorUrl}/api/v1/contracts/${contractId}`);
    if (res.ok) {
      const body = (await res.json()) as MirrorContract;
      if (body.runtime_bytecode) return body;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`mirror node never returned runtime bytecode for ${contractId}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const network = caip2(cfg.network);
  let failures = 0;

  console.log(`\ndeploying ${CONTRACT_NAME} to ${network}\n`);

  console.log("artifact");
  const artifact = readArtifact();
  const creationCode = Buffer.from(artifact.bytecode.replace(/^0x/, ""), "hex");
  const expectedCodeHash = codeHashOf(artifact.deployedBytecode);
  ok(`compiled, ${creationCode.length} bytes of creation bytecode`);
  info(`runtime code sha256 ${expectedCodeHash}`);

  // A second deployment does not replace the first: the old contract keeps running, keeps
  // whatever HBAR buyers have already paid into it, and stays the address the README names.
  // Overwriting the record is how that contract gets forgotten with money still in it.
  const existing = readDeployment(network);
  if (existing && !args.force) {
    throw new Error(
      `${CONTRACT_NAME} is already deployed to ${network} as ${existing.contractId}.\n` +
        `Deploying again leaves that contract live, holding whatever has been paid into it.\n` +
        `Pass --force if that is genuinely what you want.`,
    );
  }
  if (existing) info(`--force: replacing the record of ${existing.contractId}, which stays live`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(AccountId.fromString(cfg.operatorId), PrivateKey.fromStringECDSA(cfg.operatorKey));
  // The default cap is well under what a contract creation of this size costs, and the
  // failure it produces names the cap rather than the contract.
  client.setDefaultMaxTransactionFee(new Hbar(30));

  try {
    console.log("\ncreate");
    info(`operator ${cfg.operatorId}, gas limit ${args.gas.toLocaleString()}`);
    const response = await new ContractCreateFlow()
      .setBytecode(creationCode)
      .setGas(args.gas)
      .setContractMemo("quorum402 pool contract")
      // No .setAdminKey(). Deliberate, and permanent - see the header.
      .execute(client);

    const receipt = await response.getReceipt(client);
    const contractId = receipt.contractId;
    if (!contractId) throw new Error("contract creation returned no contract id");
    const transactionId = response.transactionId.toString();
    ok(`created ${contractId.toString()}  txId=${transactionId}`);

    const record = await response.getRecord(client);
    const gasUsed = record.contractFunctionResult?.gasUsed;
    info(`fee ${record.transactionFee.toString()}${gasUsed ? `, gas used ${gasUsed.toString()}` : ""}`);

    console.log("\nverify");
    const onChain = await fetchDeployedContract(cfg.mirrorUrl, contractId.toString());
    const actualCodeHash = codeHashOf(onChain.runtime_bytecode ?? "");
    if (actualCodeHash === expectedCodeHash) {
      ok("the deployed runtime bytecode is what this tree compiles to");
    } else {
      bad(`deployed code does not match this tree`);
      info(`expected ${expectedCodeHash}`);
      info(`on chain ${actualCodeHash}`);
      failures++;
    }
    if (onChain.admin_key == null) {
      ok("no admin key - the contract cannot be updated or deleted by anyone");
    } else {
      bad("the contract has an admin key, which ADR 0003 says it must not");
      failures++;
    }

    const evmAddress = onChain.evm_address ?? `0x${contractId.toEvmAddress()}`;
    const deployment: Deployment = {
      contract: CONTRACT_NAME,
      network,
      contractId: contractId.toString(),
      evmAddress,
      transactionId,
      deployedAt: new Date().toISOString(),
      codeHash: actualCodeHash,
    };
    console.log("\nrecord");
    ok(`wrote ${writeDeployment(deployment)}`);
    info(`contractId  ${deployment.contractId}   <- PaymentRequirements.payTo`);
    info(`evmAddress  ${deployment.evmAddress}`);
    info(`https://hashscan.io/${cfg.network}/contract/${deployment.contractId}`);
  } finally {
    client.close();
  }

  return failures;
}

main().then(
  (failures) => {
    console.log(failures === 0 ? "\ndeployed\n" : `\ndeployed, with ${failures} problem(s)\n`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(`\nFAILED: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
