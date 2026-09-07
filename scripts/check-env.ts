/**
 * Preflight. Verifies every external assumption the payment path depends on, before any
 * transaction is built, and says which one broke when one does.
 *
 * Run: npm run check:env
 */
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { caip2, loadConfig } from "../src/config.js";
import { Facilitator } from "../src/x402/facilitator.js";

const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);

async function main(): Promise<number> {
  let failures = 0;

  console.log("\nquorum402 preflight\n");

  // 1. Configuration
  console.log("config");
  let cfg;
  try {
    cfg = loadConfig();
    ok(`operator ${cfg.operatorId} on ${cfg.network}`);
    ok(`facilitator ${cfg.facilitatorUrl}`);
  } catch (err) {
    bad((err as Error).message);
    return 1;
  }

  // 2. The operator key must parse and must match the account. A mismatch here produces
  //    INVALID_SIGNATURE much later, at a point where the cause is not obvious.
  console.log("\noperator key");
  let operatorKey: PrivateKey;
  try {
    operatorKey = PrivateKey.fromStringECDSA(cfg.operatorKey);
    ok("parsed as ECDSA secp256k1");
  } catch {
    try {
      operatorKey = PrivateKey.fromStringDer(cfg.operatorKey);
      ok("parsed as DER");
    } catch (err) {
      bad(`could not parse HEDERA_OPERATOR_KEY: ${(err as Error).message}`);
      return 1;
    }
  }

  // 3. Account exists, is funded, and the key matches
  console.log("\noperator account");
  try {
    const res = await fetch(`${cfg.mirrorUrl}/api/v1/accounts/${cfg.operatorId}?limit=1`);
    if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
    const acct = (await res.json()) as {
      balance?: { balance?: number };
      key?: { key?: string };
      deleted?: boolean;
    };
    const tinybars = acct.balance?.balance ?? 0;
    const hbar = tinybars / 1e8;
    if (acct.deleted) {
      bad("account is deleted");
      failures++;
    } else {
      ok(`exists, balance ${hbar.toLocaleString()} HBAR`);
    }
    if (hbar < 10) {
      bad(`balance is low (${hbar} HBAR) - fund it before running the demo`);
      failures++;
    }

    const derived = operatorKey.publicKey.toStringRaw().toLowerCase();
    const onChain = (acct.key?.key ?? "").toLowerCase();
    if (onChain && derived && onChain !== derived) {
      bad(`key does not match account ${cfg.operatorId} (on-chain public key differs)`);
      failures++;
    } else if (onChain) {
      ok("private key matches the account's public key");
    }
  } catch (err) {
    bad(`mirror node lookup failed: ${(err as Error).message}`);
    failures++;
  }

  // 4. The facilitator must actually offer `exact` on our network, and tell us the fee payer.
  console.log("\nfacilitator");
  const network = caip2(cfg.network);
  try {
    const facilitator = new Facilitator(cfg.facilitatorUrl);
    const feePayer = await facilitator.feePayerFor(network);
    ok(`supports exact on ${network}`);
    ok(`feePayer ${feePayer}`);

    const res = await fetch(`${cfg.mirrorUrl}/api/v1/accounts/${feePayer}?limit=1`);
    if (res.ok) {
      const fp = (await res.json()) as { balance?: { balance?: number } };
      const hbar = (fp.balance?.balance ?? 0) / 1e8;
      if (hbar < 1) {
        bad(`feePayer ${feePayer} looks unfunded (${hbar} HBAR) - settlement will fail`);
        failures++;
      } else {
        ok(`feePayer funded (${Math.round(hbar).toLocaleString()} HBAR)`);
      }
    }
  } catch (err) {
    bad((err as Error).message);
    failures++;
  }

  // 5. The SDK can reach consensus nodes - freezing a transaction needs node account ids.
  console.log("\nhedera client");
  try {
    const client =
      cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
    client.setOperator(AccountId.fromString(cfg.operatorId), operatorKey);
    const nodes = Object.keys(client.network).length;
    if (nodes === 0) throw new Error("no consensus nodes in client network map");
    ok(`client configured, ${nodes} consensus nodes`);
    client.close();
  } catch (err) {
    bad(`client setup failed: ${(err as Error).message}`);
    failures++;
  }

  console.log(
    failures === 0
      ? "\npreflight passed\n"
      : `\npreflight FAILED with ${failures} problem(s)\n`,
  );
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
