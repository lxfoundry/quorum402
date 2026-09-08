/**
 * Deriving the payer from the payment, and refusing the payments where it is ambiguous.
 *
 * `quorum-scheme.md` §7 rules 4 and 5. Both failures are silent ones: attributing a deposit to
 * the fee payer succeeds and makes every refund unreachable, and a transfer that debits two
 * accounts settles perfectly well while leaving no answer to "whose seat is this".
 *
 * The transactions here are built with the SDK and frozen, so what is inspected is the same
 * kind of blob a buyer actually sends. Nothing is submitted - freezing needs no network.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  Client,
  Hbar,
  PrivateKey,
  ScheduleCreateTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { inspectBindingTransfer } from "../src/server/payer.js";
import { buildPartiallySignedTransfer } from "../src/x402/hedera-exact.js";
import type { PaymentRequirements } from "../src/x402/types.js";

const BUYER = "0.0.1001";
const OTHER_BUYER = "0.0.1002";
const CONTRACT = "0.0.10409980";
const FEE_PAYER = "0.0.7162784";
const UNIT = 100_000_000n;

const client = Client.forTestnet();

// `Client.forTestnet()` opens network channels the moment it is built. Nothing here submits
// anything, but the channels keep the event loop alive and the test runner would hang on a
// file whose assertions had all already passed.
after(() => client.close());

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: UNIT.toString(),
  asset: "0.0.0",
  payTo: CONTRACT,
  maxTimeoutSeconds: 120,
  extra: { paymentFlow: "upfront", feePayer: FEE_PAYER },
};

/** What a buyer sends: the real builder, signed and frozen, exactly as the payment path uses it. */
async function buyerPayment(): Promise<string> {
  return buildPartiallySignedTransfer({
    client,
    payerId: BUYER,
    payerKey: PrivateKey.generateECDSA(),
    requirements,
  });
}

function frozen(build: (tx: TransferTransaction) => TransferTransaction): string {
  const tx = build(new TransferTransaction())
    .setTransactionId(TransactionId.generate(FEE_PAYER))
    .freezeWith(client);
  return Buffer.from(tx.toBytes()).toString("base64");
}

function inspect(transactionBase64: string) {
  return inspectBindingTransfer({ transactionBase64, payTo: CONTRACT, amount: UNIT });
}

describe("payer derivation", () => {
  it("names the debited account as the payer, not the fee payer", async () => {
    // The fee payer's account appears in this transaction - it owns the transaction id - and
    // must not be mistaken for the buyer. That mistake is the one §7 rule 5 exists to prevent.
    const result = inspect(await buyerPayment());

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.transfer.payerAccountId, BUYER);
    assert.notEqual(result.ok && result.transfer.payerAccountId, FEE_PAYER);
    assert.equal(result.ok && result.transfer.tinybars, UNIT);
  });

  it("reads the transaction id the buyer froze in, before anything settles", async () => {
    // ADR 0006 leans on this twice: replay is checked against it in advance, and the
    // settlement response is cross-checked against it afterwards.
    const result = inspect(await buyerPayment());

    assert.equal(result.ok, true);
    assert.match(
      (result.ok && result.transfer.transactionId) || "",
      new RegExp(`^${FEE_PAYER.replace(/\./g, "\\.")}@\\d+\\.\\d+$`),
    );
  });

  it("refuses a transfer that debits two accounts to reach the right total", async () => {
    // Nets to zero, credits the contract exactly one seat, and is unattributable: two accounts
    // paid, one seat is on offer, and nothing says which of them refunds go to.
    const half = UNIT / 2n;
    const result = inspect(
      frozen((tx) =>
        tx
          .addHbarTransfer(BUYER, Hbar.fromTinybars((-half).toString()))
          .addHbarTransfer(OTHER_BUYER, Hbar.fromTinybars((-half).toString()))
          .addHbarTransfer(CONTRACT, Hbar.fromTinybars(UNIT.toString())),
      ),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-exactly-one-payer");
  });

  it("refuses a transfer that pays somebody other than the pool contract", async () => {
    const result = inspect(
      frozen((tx) =>
        tx
          .addHbarTransfer(BUYER, Hbar.fromTinybars((-UNIT).toString()))
          .addHbarTransfer(OTHER_BUYER, Hbar.fromTinybars(UNIT.toString())),
      ),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "wrong-recipient");
  });

  it("refuses a transfer that is not one seat", async () => {
    // A stale 402, or a client that cached a pool's price. ADR 0004 would record it as a late
    // deposit and refund it; refusing before settlement saves the buyer the round trip.
    const short = UNIT - 1n;
    const result = inspect(
      frozen((tx) =>
        tx
          .addHbarTransfer(BUYER, Hbar.fromTinybars((-short).toString()))
          .addHbarTransfer(CONTRACT, Hbar.fromTinybars(short.toString())),
      ),
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "wrong-amount");
  });

  it("refuses a transfer wrapped in a scheduled transaction", async () => {
    // The binding: the payload MUST be a TransferTransaction directly, and MUST NOT be wrapped
    // in a ScheduleCreateTransaction or any other transaction type.
    const inner = new TransferTransaction()
      .addHbarTransfer(BUYER, Hbar.fromTinybars((-UNIT).toString()))
      .addHbarTransfer(CONTRACT, Hbar.fromTinybars(UNIT.toString()));
    const scheduled = new ScheduleCreateTransaction()
      .setScheduledTransaction(inner)
      .setTransactionId(TransactionId.generate(FEE_PAYER))
      .freezeWith(client);

    const result = inspect(Buffer.from(scheduled.toBytes()).toString("base64"));

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-a-transfer");
  });

  it("refuses a payload that is not a transaction at all", async () => {
    const result = inspect(Buffer.from("not a transaction", "utf8").toString("base64"));

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-a-transfer");
  });
});
