/**
 * Which button a payer is offered, and why.
 *
 * These rules are enforced elsewhere - `QuorumPools._isRefundable` for a refund,
 * `quorum-scheme.md` §8 step 5 for a redemption - and this file's job is to be the same rules
 * rather than a second, nearly-right copy. Getting one wrong renders a button that reverts, which
 * is the demo's version of a wrong answer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveState, mergeSeats, seatAction } from "../scripts/demo/seats.js";
import type { IndexedDeposit, IndexedPool } from "../src/graph/client.js";
import type { PaidSeat } from "../scripts/demo/wallets.js";

const NOW = 1_788_945_000;
const URL = "http://localhost:4021/benchmark/agent-spend-eu";
const SELLS = new Map([[URL, "agent-spend-eu"]]);
const TX = "0.0.1001@1788945000.000000000";

function pool(over: Partial<IndexedPool> = {}): IndexedPool {
  return {
    poolId: "7",
    state: "Open",
    seats: 2,
    threshold: 3,
    deadline: NOW + 600,
    unitTinybars: 10_000_000n,
    resourceUrl: URL,
    ...over,
  };
}

function deposit(over: Partial<IndexedDeposit> = {}): IndexedDeposit {
  return {
    depositId: 0n,
    transaction: TX,
    tinybars: 10_000_000n,
    counted: true,
    refunded: false,
    seatsAfter: 2,
    pool: pool(),
    ...over,
  };
}

describe("effectiveState", () => {
  it("calls a pool expired the moment its deadline passes, stamped or not", () => {
    // ADR 0004's lazy expiry. The index will keep saying `Open` until somebody calls `expire`,
    // and a UI that believed it would offer a Pay button on a pool that cannot take a payment.
    assert.equal(effectiveState("Open", NOW - 1, NOW), "Expired");
    assert.equal(effectiveState("Open", NOW, NOW), "Expired");
    assert.equal(effectiveState("Open", NOW + 1, NOW), "Open");
  });

  it("leaves a decided pool alone, whatever the clock says", () => {
    // Quorum was reached, and no clock un-reaches it - `expire` reverts `NotDue` on a met pool.
    assert.equal(effectiveState("Met", NOW - 999, NOW), "Met");
    assert.equal(effectiveState("Released", NOW - 999, NOW), "Released");
    assert.equal(effectiveState("Expired", NOW - 999, NOW), "Expired");
  });
});

describe("seatAction", () => {
  it("offers the money back on a payment that took no seat, even while the pool is open", () => {
    // `_isRefundable` is `!refunded && (expired || !counted)`. A late payment will never become
    // a seat, so telling this payer to wait would be telling them to wait forever.
    assert.equal(seatAction({ counted: false, refunded: false, state: "Open" }), "reclaim");
    assert.equal(seatAction({ counted: false, refunded: false, state: "Met" }), "reclaim");
  });

  it("offers the resource on a counted seat in a met pool", () => {
    assert.equal(seatAction({ counted: true, refunded: false, state: "Met" }), "redeem");
  });

  it("still offers the resource after the seller has been paid", () => {
    // §8 step 5 takes `Met` **or** `Released`. Testing for `Met` alone would withdraw the
    // resource at the instant the payout landed - the coupling §6 forbids.
    assert.equal(seatAction({ counted: true, refunded: false, state: "Released" }), "redeem");
  });

  it("offers the money back on a counted seat once the pool expires", () => {
    assert.equal(seatAction({ counted: true, refunded: false, state: "Expired" }), "reclaim");
  });

  it("offers nothing on a counted seat in a pool still filling", () => {
    assert.equal(seatAction({ counted: true, refunded: false, state: "Open" }), "wait");
  });

  it("offers nothing once the money has already gone back", () => {
    assert.equal(seatAction({ counted: true, refunded: true, state: "Expired" }), "none");
    assert.equal(seatAction({ counted: false, refunded: true, state: "Open" }), "none");
  });

  it("waits rather than guessing when attribution is unknown", () => {
    // ADR 0006: settled, but the coordinator could not say whether it counted. Neither button
    // is safe on that, and the index resolves it within seconds.
    assert.equal(seatAction({ counted: null, refunded: false, state: "Met" }), "wait");
  });
});

describe("mergeSeats", () => {
  const remembered = (over: Partial<PaidSeat> = {}): PaidSeat => ({
    wallet: "buyer1",
    transaction: TX,
    seat: 2,
    counted: true,
    pool: pool(),
    at: NOW * 1000,
    ...over,
  });

  /**
   * `mergeSeats` with the fixtures every case shares.
   *
   * The interesting half of each test is one or two arguments; spelling out the other four each
   * time buried them.
   */
  const merge = (over: Partial<Parameters<typeof mergeSeats>[0]> = {}) =>
    mergeSeats({ indexed: [], remembered: [], sells: SELLS, live: new Map(), now: NOW, ...over });

  it("collapses a just-paid seat and its indexed twin into one row", () => {
    const rows = merge({ indexed: [deposit()], remembered: [remembered()] });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.indexed, true);
  });

  it("shows a seat the index has not caught up with yet, unredeemable", () => {
    const rows = merge({ remembered: [remembered()] });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.seat, 2);
    // §8 step 4 cannot resolve the transaction without the index, so Redeem must stay shut.
    assert.equal(rows[0]?.indexed, false);
  });

  it("hides seats in pools this coordinator does not sell", () => {
    // Earlier e2e runs leave real deposits against ephemeral ports. This server answers 401 for
    // those resources, so a Redeem button beside one would be a button that lies.
    const rows = merge({
      indexed: [deposit({ pool: pool({ resourceUrl: "http://127.0.0.1:56311/benchmark/x" }) })],
    });

    assert.deepEqual(rows, []);
  });

  it("prefers what the chain says over what the index last wrote down", () => {
    // The index lags, and the lag it shows most is a pool that filled a moment ago.
    const rows = merge({
      indexed: [deposit()],
      live: new Map([["7", { state: "Met" as const, seats: 3 }]]),
    });

    assert.equal(rows[0]?.state, "Met");
    assert.equal(rows[0]?.filled, 3);
    assert.equal(rows[0]?.action, "redeem");
  });

  it("applies lazy expiry to a pool the index still calls open", () => {
    const rows = merge({ indexed: [deposit({ pool: pool({ deadline: NOW - 5 }) })] });

    assert.equal(rows[0]?.storedState, "Open");
    assert.equal(rows[0]?.state, "Expired");
    assert.equal(rows[0]?.action, "reclaim");
    assert.equal(rows[0]?.secondsLeft, 0);
  });

  it("does not offer a refund twice", () => {
    const rows = merge({
      indexed: [deposit({ refunded: true, pool: pool({ state: "Expired" }) })],
      remembered: [remembered({ pool: pool({ state: "Expired" }) })],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.refunded, true);
    assert.equal(rows[0]?.action, "none");
  });

  it("reports a late deposit as holding no seat", () => {
    const rows = merge({ indexed: [deposit({ counted: false, seatsAfter: 3 })] });

    // `seatsAfter` on a late deposit is the pool's count unchanged, which is not a seat number.
    assert.equal(rows[0]?.seat, null);
    assert.equal(rows[0]?.action, "reclaim");
  });

  it("puts the newest pool first", () => {
    const rows = merge({
      indexed: [
        deposit({ pool: pool({ poolId: "7" }) }),
        deposit({ transaction: "0.0.2@2.2", pool: pool({ poolId: "11" }) }),
      ],
    });

    assert.deepEqual(
      rows.map((r) => r.poolId),
      ["11", "7"],
    );
  });
});
