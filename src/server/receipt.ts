/**
 * The receipt a payer gets back - `quorum-scheme.md` §6.1.
 *
 * A body rather than a header, because response bodies are a server concern under the HTTP
 * transport and the protocol facts stay in `PAYMENT-RESPONSE`. What is here is everything a
 * payer needs to act on their own: what they hold, whether it took a seat, and the two ways
 * out of the pool that do not require this server to still be running.
 */
import type { PoolState, PoolTerms } from "../pool/client.js";

export interface Receipt {
  poolId: string;
  /** The EVM address the deposit was recorded against. */
  payer: string;
  /** The settlement this receipt descends from. Resolvable on HashScan. */
  transaction: string;
  /**
   * Whether the payment is recorded against the pool.
   *
   * Separate from `counted`, and §6.1 forbids conflating them: a payment can be attributed
   * without taking a seat - it arrived after the last one, or after the deadline - in which
   * case it is refundable at once.
   */
  attributed: boolean;
  /**
   * Whether it took a seat. **`null` means unknown, not false.**
   *
   * Unknown happens on one path: the attribution was recovered from the contract's replay
   * guard, which proves the payment landed and cannot say which deposit it is. Reporting
   * `false` there would tell a payer they have no seat when they may well have one.
   */
  counted: boolean | null;
  /** The seat number this payment took, when it took one. */
  seat: number | null;
  threshold: number;
  deadline: number;
  pool: { state: PoolState; filled: number };
  next: NextAction[];
}

export type NextAction =
  | { action: "redeem"; when: string; header: string }
  | { action: "reclaim"; when: string; contract: string; method: string };

/**
 * The contract call a payer makes to get their money back - §9, and the one escape hatch this
 * server is not involved in.
 *
 * One constant because two responses quote it: the receipt handed out at payment time, and the
 * refusal a redemption gets when the seat did not happen. Re-signing `claimRefund` in the
 * contract has to move both, and nothing else links them.
 */
export const CLAIM_REFUND = "claimRefund(uint256)";

export function buildReceipt(params: {
  terms: PoolTerms;
  /** The pool as it stands *after* this payment was recorded. */
  state: PoolState;
  seats: number;
  payer: string;
  transaction: string;
  attributed: boolean;
  counted: boolean | null;
  contractId: string;
}): Receipt {
  return {
    poolId: params.terms.poolId.toString(),
    payer: params.payer,
    transaction: params.transaction,
    attributed: params.attributed,
    counted: params.counted,
    seat: params.counted === true ? params.seats : null,
    threshold: params.terms.threshold,
    deadline: params.terms.deadline,
    pool: { state: params.state, filled: params.seats },
    // Both routes out, always, whatever this receipt says. §9 keeps reversal off this server
    // entirely - a payer can reclaim without it, which is the point, since the server's
    // failure is the one they most need protection from.
    next: [
      { action: "redeem", when: "threshold met", header: "QUORUM-RECEIPT" },
      {
        action: "reclaim",
        when: "deadline passes",
        contract: params.contractId,
        method: CLAIM_REFUND,
      },
    ],
  };
}
