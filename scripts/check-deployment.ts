/**
 * Is the contract at the recorded address the contract in this tree, and can anyone change it?
 *
 * Two questions a reader of the README should not have to take on trust, and both are answered
 * from the mirror node rather than from anything this repository claims:
 *
 *   1. the runtime bytecode on the network hashes to what these sources compile to
 *   2. no external key can update or delete it (ADR 0003)
 *
 * Run: npm run build && npm run check:deployment
 *      npm run check:deployment -- --contract 0.0.x
 */
import { caip2, loadConfig } from "../src/config.js";
import { hashscanContract } from "../src/hedera/explorer.js";
import {
  adminKeyKind,
  codeHashOf,
  deploymentPath,
  fetchDeployedContract,
  parseEntityId,
  readArtifact,
  readDeployment,
} from "../src/pool/deployment.js";

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let contractId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--contract") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--contract needs an entity id, e.g. --contract 0.0.1234`);
      // Checked here rather than at the mirror node, which would spend twelve retries before
      // failing on something the argument itself already showed.
      parseEntityId(value);
      contractId = value;
    } else throw new Error(`unknown argument "${argv[i]}"`);
  }

  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const recorded = readDeployment(network);
  contractId ??= recorded?.contractId;
  if (!contractId) {
    throw new Error(
      `no deployment recorded at ${deploymentPath(network)}. Run: npm run deploy, or pass --contract 0.0.x`,
    );
  }

  console.log(`\nchecking ${contractId} on ${network}\n`);
  let failures = 0;

  const expectedCodeHash = codeHashOf(readArtifact().deployedBytecode);
  const onChain = await fetchDeployedContract(cfg.mirrorUrl, contractId);
  const actualCodeHash = codeHashOf(onChain.runtime_bytecode ?? "");

  if (actualCodeHash === expectedCodeHash) {
    ok(`runtime bytecode matches this tree (sha256 ${actualCodeHash})`);
  } else {
    bad("the deployed code is not what this tree compiles to");
    info(`expected ${expectedCodeHash}`);
    info(`on chain ${actualCodeHash}`);
    failures++;
  }

  const admin = adminKeyKind(onChain, contractId);
  if (admin === "external") {
    bad("an external key can update or delete this contract");
    failures++;
  } else {
    ok(`admin key: ${admin} - nobody outside the contract can update or delete it`);
  }

  // The record is what the README quotes. A stale one is how a reader ends up verifying a
  // contract nobody is using any more.
  if (recorded && recorded.contractId === contractId && recorded.codeHash !== actualCodeHash) {
    bad(`${deploymentPath(network)} records a different code hash than the network reports`);
    failures++;
  }

  info(hashscanContract(cfg.network, contractId));
  return failures;
}

main().then(
  (failures) => {
    console.log(failures === 0 ? "\nverified\n" : `\nFAILED with ${failures} problem(s)\n`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(`\nFAILED: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
