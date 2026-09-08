import "dotenv/config";

export interface Config {
  operatorId: string;
  operatorKey: string;
  network: "testnet" | "mainnet";
  mirrorUrl: string;
  facilitatorUrl: string;
  port: number;
  payToId: string | undefined;
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

  return {
    ...networkConfig(),
    operatorId: required("HEDERA_OPERATOR_ID"),
    operatorKey: required("HEDERA_OPERATOR_KEY"),
    facilitatorUrl: process.env.X402_FACILITATOR_URL?.trim() || "https://api.testnet.blocky402.com",
    port: Number(process.env.PORT?.trim() || 4021),
    payToId: process.env.PAY_TO_ID?.trim() || undefined,
  };
}

/** CAIP-2 id for the configured network, as x402 expects it. */
export function caip2(network: "testnet" | "mainnet"): `hedera:${typeof network}` {
  return `hedera:${network}`;
}
