/**
 * What to put in front of a payer about their own seats, and which button - if any - to offer.
 *
 * Pure. Every input is a fact somebody else already read, which is what makes the rules below
 * testable without a network: they are the part of the demo most able to be quietly wrong, and
 * being wrong here means rendering a button that reverts.
 *
 * Two sources, because neither answers the whole question:
 *
 *   - the **index** knows which pools an address has paid into and under which transaction id.
 *     The contract keeps no per-address list and hashes the transaction id away, so nothing else
 *     can answer that
 *   - the **chain** knows what a pool is doing *now*. The index is built from events, and a pool
 *     past its deadline that nobody has stamped still reads `Open` there
 *
 * So the index says which rows exist and the chain says what they mean - the same division the
 * coordinator makes in §8.
 */
import type { PoolState } from "../../src/pool/client.js";
import type { IndexedDeposit, IndexedPool } from "../../src/graph/client.js";
import type { PaidSeat } from "./wallets.js";

/**
 * The pool's state as the network would answer it, not as it was last written down.
 *
 * ADR 0004's lazy expiry: `PoolExpired` is emitted by `expire`, `claimRefund` and `refundAll` and
 * by nothing else, so between a deadline passing and somebody stamping it, stored state and
 * `statusOf` disagree. The subgraph schema says to read `state` against `deadline`; this is that,
 * in one place, so no caller has to remember to.
 */
export function effectiveState(state: PoolState, deadline: number, now: number): PoolState {
  return state === "Open" && now >= deadline ? "Expired" : state;
}

/**
 * What a payer can do about one seat.
 *
 * `redeem` is the resource; `reclaim` is the money back; `wait` is a pool still filling; `none`
 * is a row with nothing left to do. Each maps to a rule that is enforced somewhere else - the
 * contract for reclaim, §8 for redeem - and never to a preference of this file's.
 */
export type SeatAction = "redeem" | "reclaim" | "wait" | "none";

/**
 * Which action this deposit permits, from the two rules that actually decide it.
 *
 * **Reclaim** follows `QuorumPools._isRefundable`: `!refunded && (expired || !counted)`. Note what
 * that means and what a plausible reading would get wrong - a payment that took **no seat** is
 * refundable the moment it is recorded, in an open pool as much as an expired one, because it
 * will never become a seat and waiting would be waiting forever.
 *
 * **Redeem** follows `quorum-scheme.md` §8 step 5: a counted deposit in a pool that is `Met`
 * **or** `Released`. `Released` is not an oversight - a pool that has already paid the seller
 * still entitles every counted payer, and testing for `Met` alone would withdraw the resource at
 * the instant the payout landed.
 */
export function seatAction(params: {
  counted: boolean | null;
  refunded: boolean;
  state: PoolState;
}): SeatAction {
  if (params.refunded) return "none";
  // `null` means the coordinator settled the payment but could not say whether it counted
  // (ADR 0006). Neither button is safe on that, and the index resolves it within seconds.
  if (params.counted === null) return "wait";
  if (!params.counted) return "reclaim";
  if (params.state === "Met" || params.state === "Released") return "redeem";
  if (params.state === "Expired") return "reclaim";
  return "wait";
}

/** One row of "my seats", ready to render. */
export interface SeatRow {
  poolId: string;
  /** Which benchmark the pool sells. Resolved from its resource URL, never guessed. */
  slug: string;
  transaction: string;
  /** The seat this payment took, when it took one. */
  seat: number | null;
  counted: boolean | null;
  refunded: boolean;
  /**
   * Whether The Graph has this deposit yet.
   *
   * Gates the Redeem button, because §8 step 4 cannot resolve a transaction id to a deposit
   * without the index - so a redemption attempted before this is true answers 404 and the payer
   * is told their good seat does not exist.
   */
  indexed: boolean;
  state: PoolState;
  /** The stored state, kept when it disagrees with `state` - which is worth showing, not hiding. */
  storedState: PoolState;
  filled: number;
  threshold: number;
  deadline: number;
  secondsLeft: number;
  unitTinybars: string;
  action: SeatAction;
}

/** What the chain says about a pool right now, where the caller has bothered to ask. */
export interface LivePool {
  state: PoolState;
  seats: number;
}

/**
 * Merge what the index knows with what this process just watched happen.
 *
 * Keyed on pool **and** transaction: a transaction id names one deposit across the whole
 * contract, and pairing it with the pool means a remembered seat and its indexed twin collapse
 * into one row rather than appearing twice while the index catches up.
 *
 * `sells` filters to the resources this coordinator actually serves. Without it the list fills
 * with seats from earlier runs against ephemeral ports - real deposits, but ones this server
 * would answer 401 for, so a Redeem button beside them would be a button that lies.
 */
export function mergeSeats(params: {
  indexed: IndexedDeposit[];
  remembered: PaidSeat[];
  /** Resource URL to slug, for the resources on offer here. */
  sells: Map<string, string>;
  /** Pool id to what the chain last said, for pools the caller read. */
  live: Map<string, LivePool>;
  now: number;
}): SeatRow[] {
  const rows = new Map<string, SeatRow>();

  const add = (
    pool: IndexedPool,
    seat: {
      transaction: string;
      seat: number | null;
      counted: boolean | null;
      refunded: boolean;
      indexed: boolean;
    },
  ): void => {
    const slug = params.sells.get(pool.resourceUrl);
    if (!slug) return;

    const chain = params.live.get(pool.poolId);
    const storedState = chain?.state ?? pool.state;
    const filled = chain?.seats ?? pool.seats;
    const state = effectiveState(storedState, pool.deadline, params.now);

    const key = `${pool.poolId}:${seat.transaction}`;
    const existing = rows.get(key);
    rows.set(key, {
      poolId: pool.poolId,
      slug,
      transaction: seat.transaction,
      seat: seat.seat,
      counted: seat.counted,
      // Once either source has seen a refund it stays seen: the chain cannot un-refund it, and
      // a stale `false` would offer the money back a second time.
      refunded: seat.refunded || (existing?.refunded ?? false),
      indexed: seat.indexed || (existing?.indexed ?? false),
      state,
      storedState,
      filled,
      threshold: pool.threshold,
      deadline: pool.deadline,
      secondsLeft: Math.max(0, pool.deadline - params.now),
      unitTinybars: pool.unitTinybars.toString(),
      action: seatAction({ counted: seat.counted, refunded: seat.refunded, state }),
    });
  };

  // Remembered first, so an indexed row overwrites it: the index is the later, fuller answer,
  // and it is the only one of the two that knows about a refund.
  for (const paid of params.remembered) {
    add(paid.pool, {
      transaction: paid.transaction,
      seat: paid.seat,
      counted: paid.counted,
      refunded: false,
      indexed: false,
    });
  }

  for (const deposit of params.indexed) {
    add(deposit.pool, {
      transaction: deposit.transaction,
      // `seatsAfter` is the pool's count once this deposit was applied, so for a counted deposit
      // it is the seat number. For a late one it is the count unchanged, which is not a seat.
      seat: deposit.counted ? deposit.seatsAfter : null,
      counted: deposit.counted,
      refunded: deposit.refunded,
      indexed: true,
    });
  }

  // Newest pool first. Pool ids are allocated sequentially, so they order by age exactly.
  return [...rows.values()].sort((a, b) => Number(BigInt(b.poolId) - BigInt(a.poolId)));
}
