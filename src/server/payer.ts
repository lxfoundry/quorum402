/**
 * Who paid, read out of the payment itself.
 *
 * `quorum-scheme.md` §7 rule 5 is the reason this file exists rather than one property access,
 * and it is worth restating because the obvious field is the wrong one. The Hedera binding
 * documents `SettlementResponse.payer` as *"the Hedera account ID of the fee payer that
 * sponsored the transaction"* - which is the facilitator. A coordinator that attributes
 * deposits from it records **every deposit in every pool against the facilitator**. That
 * succeeds silently, and every refund it produces is unreachable.
 *
 * The paying account is the debited party in the binding payload's own transfer: the thing the
 * payer signed and the facilitator validates. Rule 4 is what makes "the debited party" a
 * well-defined phrase - a transfer can net to zero while debiting two accounts, which would
 * leave both the seat and the refund destination ambiguous.
 */
import { Transaction, TransferTransaction } from "@hiero-ledger/sdk";

export type TransferRejection =
  /** Not decodable, or not a bare `TransferTransaction` - which the binding requires. */
  | "not-a-transfer"
  /** Anything beyond a plain HBAR transfer. The binding allows transfer operations only. */
  | "not-a-plain-hbar-transfer"
  /** No transaction id frozen into it, so nothing to settle under or record against. */
  | "no-transaction-id"
  /** Rule 4: one debited account, or the payer is ambiguous. */
  | "not-exactly-one-payer"
  /** The credit leg does not pay the pool contract. */
  | "wrong-recipient"
  /** The credit leg is not one seat. */
  | "wrong-amount";

export interface InspectedTransfer {
  /** The single debited account. This, and nothing else, is the payer. */
  payerAccountId: string;
  /**
   * The transaction id the payer froze into the transfer.
   *
   * Known **before** settlement, which ADR 0006 depends on twice: it is the id the deposit
   * will be recorded under, so it can be checked for replay in advance, and it is what the
   * facilitator's settlement response is cross-checked against afterwards.
   */
  transactionId: string;
  /** What the credit leg actually pays, in tinybars. */
  tinybars: bigint;
}

export type TransferInspection =
  | { ok: true; transfer: InspectedTransfer }
  | { ok: false; reason: TransferRejection; detail: string };

function reject(reason: TransferRejection, detail: string): TransferInspection {
  return { ok: false, reason, detail };
}

/**
 * Check a binding payload's transfer against the terms it claims to pay, and say who paid.
 *
 * Runs before `/verify` and `/settle`, so every rejection here costs the payer nothing.
 */
export function inspectBindingTransfer(params: {
  transactionBase64: string;
  /** The pool contract's Hedera account id, from the requirement the server advertised. */
  payTo: string;
  /** One seat, in tinybars. */
  amount: bigint;
}): TransferInspection {
  let decoded: Transaction;
  try {
    decoded = Transaction.fromBytes(Buffer.from(params.transactionBase64, "base64"));
  } catch (error) {
    return reject("not-a-transfer", error instanceof Error ? error.message : String(error));
  }

  // The binding is explicit that this MUST be a `TransferTransaction` directly, and MUST NOT be
  // wrapped in a `ScheduleCreateTransaction` or any other type. The facilitator enforces it
  // too; enforcing it here means a wrapped payload is refused rather than round-tripped.
  if (!(decoded instanceof TransferTransaction)) {
    return reject("not-a-transfer", `payload is a ${decoded.constructor.name}`);
  }
  if (decoded.tokenTransfers.size > 0 || decoded.nftTransfers.size > 0) {
    return reject("not-a-plain-hbar-transfer", "the transfer moves tokens as well as HBAR");
  }

  const transactionId = decoded.transactionId?.toString();
  if (!transactionId) return reject("no-transaction-id", "the transfer carries no transaction id");

  const legs = decoded.hbarTransfersList.map((transfer) => ({
    accountId: transfer.accountId.toString(),
    tinybars: BigInt(transfer.amount.toTinybars().toString()),
  }));

  const debits = legs.filter((leg) => leg.tinybars < 0n);
  const credits = legs.filter((leg) => leg.tinybars > 0n);

  // Strict on purpose: exactly one account out, exactly one in. Rule 4 requires the first, and
  // the second is the shape this scheme's payments have - a seat is one payer paying one pool.
  // Anything else is refused before settlement rather than interpreted after it, because every
  // interpretation of a third leg is a guess about money that has already moved.
  if (debits.length !== 1) {
    return reject("not-exactly-one-payer", `the transfer debits ${debits.length} accounts`);
  }
  if (credits.length !== 1) {
    return reject("not-exactly-one-payer", `the transfer credits ${credits.length} accounts`);
  }

  const [debit] = debits as [(typeof legs)[number]];
  const [credit] = credits as [(typeof legs)[number]];

  if (credit.accountId !== params.payTo) {
    return reject("wrong-recipient", `pays ${credit.accountId}, not ${params.payTo}`);
  }
  if (credit.tinybars !== params.amount) {
    return reject("wrong-amount", `pays ${credit.tinybars} tinybars, not ${params.amount}`);
  }

  return {
    ok: true,
    transfer: {
      payerAccountId: debit.accountId,
      transactionId,
      tinybars: credit.tinybars,
    },
  };
}
