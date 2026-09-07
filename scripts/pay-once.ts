/**
 * One real x402 `exact` payment, settled on Hedera testnet through the facilitator.
 *
 * This is the smallest thing that proves the payment path end to end: a buyer signs a
 * transfer it cannot submit, the facilitator completes and submits it, and the funds move.
 * Everything the pool does later is built on this handshake.
 *
 * Run: npm run pay -- [hbarAmount] [buyerLabel]
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

async function main(): Promise<void> {
  // Keep the argv text as-is; converting through Number() first would mangle small amounts
  // into scientific notation before they ever reach the tinybar conversion.
  const hbarText = process.argv[2] ?? "1";
  const buyerLabel = process.argv[3];
  const amountTinybars = hbarToTinybars(hbarText);
  if (amountTinybars <= 0n) {
    throw new Error(`amount must be greater than zero, got "${hbarText}"`);
  }

  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const buyer = loadBuyer(buyerLabel, cfg.network);
  // The seller. Defaults to the operator - any account other than the payer works, and the
  // transfer must net to zero across exactly two parties.
  const payTo = cfg.payToId || cfg.operatorId;

  if (payTo === buyer.accountId) {
    throw new Error(`payTo (${payTo}) must differ from the payer (${buyer.accountId})`);
  }

  const facilitator = new Facilitator(cfg.facilitatorUrl);
  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();

  try {
    // 1. Ask the facilitator who pays fees. Never hardcode this.
    const feePayer = await facilitator.feePayerFor(network);

    const amount = amountTinybars.toString();
    const resource: ResourceDescriptor = {
      url: "https://quorum402.example/pool/demo",
      description: "quorum402 single-payer settlement check",
      mimeType: "application/json",
    };

    // 2. What a resource server would have returned in its 402 response.
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network,
      amount,
      asset: HBAR_ASSET,
      payTo,
      maxTimeoutSeconds: 120,
      extra: { feePayer },
    };

    console.log(`\npayer     ${buyer.accountId} (${buyer.label})`);
    console.log(`payTo     ${payTo}`);
    console.log(`feePayer  ${feePayer}  (facilitator sponsors gas and submits)`);
    console.log(`amount    ${amount} tinybars  (${hbarText} HBAR)\n`);

    // 3. Buyer signs a transaction it cannot submit: the transaction id belongs to the
    //    facilitator, so only the facilitator's signature can complete it.
    const transaction = await buildPartiallySignedTransfer({
      client,
      payerId: AccountId.fromString(buyer.accountId),
      payerKey: PrivateKey.fromStringECDSA(buyer.privateKey),
      requirements,
    });
    console.log(`built partially signed transfer (${transaction.length} b64 chars)`);

    const payload = buildPaymentPayload({ resource, requirements, transactionBase64: transaction });

    // 4. Verify is read-only - it must not move funds.
    const verification = await facilitator.verify(payload, requirements);
    if (!verification.isValid) {
      throw new Error(`facilitator rejected the payment: ${verification.invalidReason}`);
    }
    console.log("verify    isValid=true");

    // 5. Settle is the irreversible step.
    const settlement = await facilitator.settle(payload, requirements);
    if (!settlement.success) {
      throw new Error(`settlement failed: ${settlement.errorReason ?? "no reason given"}`);
    }
    const txId = settlementTxId(settlement);
    console.log(`settle    success=true  txId=${txId ?? "(not in response)"}`);

    // 6. Trust the ledger, not the response. Confirm independently on the mirror node.
    if (txId) {
      await confirmOnMirror(cfg.mirrorUrl, txId, payTo, buyer.accountId);
    } else {
      // Settlement succeeded but we cannot name the transaction. Show the raw body so the
      // field name can be added rather than guessed at again.
      console.log("");
      console.log(`raw settlement response: ${JSON.stringify(settlement)}`);
      console.log("Funds moved - find it under the payer on HashScan:");
      console.log(`  https://hashscan.io/testnet/account/${buyer.accountId}`);
    }
  } finally {
    client.close();
  }
}

/**
 * The facilitator saying "success" is a claim. The mirror node is the record. Poll briefly -
 * mirror ingestion lags consensus by a second or two.
 */
async function confirmOnMirror(
  mirrorUrl: string,
  transactionId: string,
  payTo: string,
  payer: string,
): Promise<void> {
  // Mirror node wants 0.0.x-seconds-nanos, the SDK gives 0.0.x@seconds.nanos.
  const mirrorId = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  const url = `${mirrorUrl}/api/v1/transactions/${mirrorId}`;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as {
        transactions?: { result?: string; charged_tx_fee?: number; transfers?: unknown[] }[];
      };
      const tx = body.transactions?.[0];
      if (tx) {
        console.log(`\nmirror node confirms: result=${tx.result}`);
        const transfers = (tx.transfers ?? []) as { account: string; amount: number }[];
        for (const t of transfers) {
          if (t.account === payer || t.account === payTo) {
            const sign = t.amount > 0 ? "+" : "";
            console.log(`  ${t.account.padEnd(14)} ${sign}${t.amount} tinybars`);
          }
        }
        console.log(
          `\nHashScan: https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionId)}\n`,
        );
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`\nmirror node had not indexed ${transactionId} yet - check HashScan directly\n`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}\n`);
  process.exit(1);
});
