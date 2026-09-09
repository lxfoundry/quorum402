import "dotenv/config";

export interface Config {
  operatorId: string;
  operatorKey: string;
  network: "testnet" | "mainnet";
  mirrorUrl: string;
  facilitatorUrl: string;
  port: number;
  /**
   * The origin this server is reachable at, without a trailing slash.
   *
   * Load-bearing, and in a way that is easy to miss: a pool stores its `resourceUrl` on-chain
   * at creation, and the coordinator finds the pool for a request by matching that string. So
   * the URL baked into the pool has to be one this server actually answers on. Get it wrong
   * and every request 404s while the pool sits open and payable - the two halves fail apart,
   * and neither says why.
   */
  publicBaseUrl: string;
  payToId: string | undefined;
  /**
   * The subgraph redemption resolves transaction ids through - `quorum-scheme.md` §8.
   *
   * Optional, and the coordinator runs without it: selling seats and settling payments need
   * only the contract. Redemption does not work without it, because the transaction id a
   * payment settled under is emitted and never stored, so with no index there is nothing to
   * resolve a payer's receipt against.
   */
  subgraphUrl: string | undefined;
}

class MissingConfig extends Error {
  constructor(keys: string[]) {
    super(
      `Missing required environment variable(s): ${keys.join(", ")}\n` +
        `Copy .env.example to .env and fill them in. .env is gitignored and must stay that way -\n` +
        `this repository is public.`,
    );
    this.name = "MissingConfig";
  }
}

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new MissingConfig([key]);
  return value;
}

/**
 * Which network, and where to read it from. Split out of `loadConfig` because it needs no
 * credentials: generating a subgraph manifest, or checking one for drift in CI, should not
 * require a private key to be present for a job that never signs anything.
 */
export function networkConfig(): Pick<Config, "network" | "mirrorUrl"> {
  const network = (process.env.HEDERA_NETWORK?.trim() || "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`HEDERA_NETWORK must be "testnet" or "mainnet", got "${network}"`);
  }
  return {
    network,
    mirrorUrl: process.env.HEDERA_MIRROR_URL?.trim() || `https://${network}.mirrornode.hedera.com`,
  };
}

export function loadConfig(): Config {
  const missing = (["HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY"] as const).filter(
    (k) => !process.env[k]?.trim(),
  );
  if (missing.length) throw new MissingConfig(missing);

  const port = Number(process.env.PORT?.trim() || 4021);

  return {
    ...networkConfig(),
    operatorId: required("HEDERA_OPERATOR_ID"),
    operatorKey: required("HEDERA_OPERATOR_KEY"),
    facilitatorUrl: process.env.X402_FACILITATOR_URL?.trim() || "https://api.testnet.blocky402.com",
    port,
    publicBaseUrl: normaliseBaseUrl(
      process.env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`,
    ),
    payToId: process.env.PAY_TO_ID?.trim() || undefined,
    subgraphUrl: process.env.SUBGRAPH_URL?.trim() || undefined,
  };
}

/**
 * Strip trailing slashes, so a base URL joins the same way however it was written.
 *
 * `resourceUrl` is compared as an exact string against what the chain holds, and a stray
 * slash makes two spellings of one URL that never match.
 */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** CAIP-2 id for the configured network, as x402 expects it. */
export function caip2(network: "testnet" | "mainnet"): `hedera:${typeof network}` {
  return `hedera:${network}`;
}
