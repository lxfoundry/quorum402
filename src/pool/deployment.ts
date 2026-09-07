/**
 * Where the pool contract is deployed, and whether what is deployed is still this code.
 *
 * Unlike `.env` and `.accounts.json`, this record is committed. A contract address is public
 * information the README has to name anyway - and a reader should not have to take the
 * README's word for which source sits behind it. `codeHash` is the SHA-256 of the runtime
 * bytecode this tree compiles to; the mirror node hands back the runtime bytecode the network
 * actually runs. Two hashes that match settle the question without anyone verifying source on
 * an explorer.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file rather than from `process.cwd()`. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ARTIFACT = join(ROOT, "artifacts", "contracts", "QuorumPools.sol", "QuorumPools.json");
const DEPLOYMENTS = join(ROOT, "deployments");

export const CONTRACT_NAME = "QuorumPools";

export interface Deployment {
  contract: string;
  /** CAIP-2, as x402 names the network. */
  network: string;
  /** Hedera entity id, `0.0.x`. This is what goes in `PaymentRequirements.payTo`. */
  contractId: string;
  /** The contract's long-zero EVM address, for anything speaking EVM. */
  evmAddress: string;
  transactionId: string;
  deployedAt: string;
  /** SHA-256 of the runtime bytecode, as returned by `codeHashOf`. */
  codeHash: string;
}

export interface Compiled {
  abi: unknown[];
  /** Creation bytecode - what gets deployed. */
  bytecode: string;
  /** Runtime bytecode - what ends up on the network, and what `codeHash` covers. */
  deployedBytecode: string;
}

/**
 * `artifacts/` is gitignored, so this is the one input a fresh clone does not have. Say so in
 * the error rather than failing on a missing path the reader has to interpret.
 */
export function readArtifact(): Compiled {
  if (!existsSync(ARTIFACT)) {
    throw new Error(`${CONTRACT_NAME} is not compiled (${ARTIFACT} missing). Run: npm run build`);
  }
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as Compiled;
  if (!artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error(`${ARTIFACT} has no creation bytecode`);
  }
  return artifact;
}

/** Case and the `0x` prefix are not part of the code. Normalise before hashing either side. */
export function codeHashOf(bytecode: string): string {
  const normalised = bytecode.trim().toLowerCase().replace(/^0x/, "");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/** `hedera:testnet` -> `deployments/hedera-testnet.json`. A colon is not a filename. */
export function deploymentPath(network: string): string {
  return join(DEPLOYMENTS, `${network.replace(/:/g, "-")}.json`);
}

export function readDeployment(network: string): Deployment | undefined {
  const path = deploymentPath(network);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

export function writeDeployment(deployment: Deployment): string {
  mkdirSync(DEPLOYMENTS, { recursive: true });
  const path = deploymentPath(deployment.network);
  writeFileSync(path, JSON.stringify(deployment, null, 2) + "\n");
  return path;
}
