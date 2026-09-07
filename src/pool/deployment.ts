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

export interface DeployedContract {
  evm_address?: string;
  runtime_bytecode?: string;
  admin_key?: { _type?: string; key?: string } | null;
}

/**
 * Read the contract back from the mirror node. A creation receipt says a contract id was
 * allocated; only the runtime bytecode says *which* contract is behind it, and mirror
 * ingestion lags consensus by a second or two.
 */
export async function fetchDeployedContract(
  mirrorUrl: string,
  contractId: string,
): Promise<DeployedContract> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await fetch(`${mirrorUrl}/api/v1/contracts/${contractId}`);
    if (res.ok) {
      const body = (await res.json()) as DeployedContract;
      if (body.runtime_bytecode) return body;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`mirror node never returned runtime bytecode for ${contractId}`);
}

/** Protobuf base-128 varint, little-endian groups of 7 bits. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

/**
 * The protobuf `Key` a contract holds when it is its own administrator, hex encoded the way
 * the mirror node returns `admin_key.key`.
 *
 * Hand-encoded rather than pulled out of the SDK, which does not export the protobuf types.
 * `Key.contractID` is field 1 and length-delimited (tag 0x0a); inside it, shard, realm and
 * num are fields 1, 2 and 3 (tags 0x08, 0x10, 0x18), and proto3 omits the ones that are zero
 * - which is why a `0.0.x` contract encodes to five bytes.
 */
export function selfAdminKeyHex(contractId: string): string {
  const [shard = 0, realm = 0, num = 0] = contractId.split(".").map(Number);
  const id: number[] = [];
  if (shard) id.push(0x08, ...varint(shard));
  if (realm) id.push(0x10, ...varint(realm));
  id.push(0x18, ...varint(num));
  return Buffer.from([0x0a, ...varint(id.length), ...id]).toString("hex");
}

/**
 * Who, if anyone, can update or delete the deployed contract.
 *
 * `none` and `self` are both immutable, and Hedera writes `self` for a contract created with
 * no admin key: the only key that could authorise an update belongs to the contract, and a
 * contract signs nothing it has no code to sign. `external` is the one that matters - it means
 * a private key somewhere can change or delete the contract holding buyers' funds, which is
 * the thing ADR 0003 says must not exist.
 */
export function adminKeyKind(
  contract: DeployedContract,
  contractId: string,
): "none" | "self" | "external" {
  const key = contract.admin_key?.key;
  if (!contract.admin_key || !key) return "none";
  return key.toLowerCase() === selfAdminKeyHex(contractId) ? "self" : "external";
}
