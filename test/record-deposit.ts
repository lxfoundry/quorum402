import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOUR,
  LateReason,
  RESOURCE,
  State,
  UNIT,
  ZERO_ADDRESS,
  poolFixture,
  time,
  txId,
  viem,
} from "./helpers.js";

describe("recordDeposit", () => {
  it("is the coordinator's to call, and nobody else's", async () => {
    const { pools, asBuyer, buyer, settle } = await poolFixture();
    await settle(UNIT);

    await viem.assertions.revertWithCustomError(
      pools.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]),
      pools,
      "NotCoordinator",
    );
    const asSomeBuyer = await asBuyer(0);
    await viem.assertions.revertWithCustomError(
      asSomeBuyer.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]),
      pools,
      "NotCoordinator",
    );
  });

  it("refuses a payer of zero, which no one could ever refund", async () => {
    const { pools, asCoordinator, settle } = await poolFixture();
    await settle(UNIT);

    await viem.assertions.revertWithCustomError(
      asCoordinator.write.recordDeposit([0n, ZERO_ADDRESS, UNIT, txId(1)]),
      pools,
      "ZeroAddress",
    );
  });

  it("refuses a payment of nothing, which no one could ever refund either", async () => {
    const { pools, asCoordinator, buyer, settle } = await poolFixture();
    await settle(UNIT);

    // The HBAR is here, so this is not the solvency gate talking: a deposit of zero is
    // refused because nothing arrived to be stranded by refusing it, and because its payer
    // could never clear it - claimRefund would find nothing to pay and revert.
    await viem.assertions.revertWithCustomError(
      asCoordinator.write.recordDeposit([0n, buyer(0), 0n, txId(1)]),
      pools,
      "ZeroAmount",
    );
    assert.equal(await pools.read.depositCount([0n]), 0n);
  });

  it("refuses a payment that has not arrived", async () => {
    const { pools, asCoordinator, buyer } = await poolFixture();

    await viem.assertions.revertWithCustomError(
      asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]),
      pools,
      "Insolvent",
    );
    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal(await pools.read.depositCount([0n]), 0n);
  });

  it("counts a settled payment, takes a seat, and says so", async () => {
    const { pools, asCoordinator, buyer, settle } = await poolFixture();
    await settle(UNIT);

    const tx = await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]);
    await viem.assertions.emitWithArgs(tx, pools, "DepositRecorded", [
      0n,
      buyer(0),
      0n,
      UNIT,
      txId(1),
      1,
    ]);

    const pool = await pools.read.poolOf([0n]);
    assert.equal(pool.seats, 1);
    assert.equal(pool.state, State.Open);
    assert.equal(await pools.read.committedTinybars(), UNIT);
    assert.equal(await pools.read.depositCount([0n]), 1n);

    const deposit = await pools.read.depositAt([0n, 0n]);
    assert.equal(deposit.payer.toLowerCase(), buyer(0).toLowerCase());
    assert.equal(deposit.tinybars, UNIT);
    assert.equal(deposit.counted, true);
    assert.equal(deposit.refunded, false);
  });

  it("refuses the same Hedera transaction a second time, in any pool", async () => {
    const { pools, asCoordinator, buyer, coordinator, recipient, settle } = await poolFixture();
    const deadline = BigInt(await time.latest()) + HOUR;
    await pools.write.createPool([recipient, coordinator, UNIT, 3, deadline, RESOURCE]);
    await settle(UNIT * 2n);

    await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]);

    await viem.assertions.revertWithCustomError(
      asCoordinator.write.recordDeposit([0n, buyer(1), UNIT, txId(1)]),
      pools,
      "DuplicateTransaction",
    );
    // The guard is global: the same settlement cannot be spent into a second pool either.
    await viem.assertions.revertWithCustomError(
      asCoordinator.write.recordDeposit([1n, buyer(1), UNIT, txId(1)]),
      pools,
      "DuplicateTransaction",
    );
  });

  it("marks the pool Met when the last seat is taken", async () => {
    const { pools, asCoordinator, buyer, settle, threshold } = await poolFixture({ threshold: 3 });

    for (let i = 0; i < threshold - 1; i++) {
      await settle(UNIT);
      await asCoordinator.write.recordDeposit([0n, buyer(i), UNIT, txId(i)]);
      assert.equal(await pools.read.statusOf([0n]), State.Open);
    }

    await settle(UNIT);
    const tx = await asCoordinator.write.recordDeposit([0n, buyer(threshold - 1), UNIT, txId(99)]);
    await viem.assertions.emit(tx, pools, "ThresholdMet");

    assert.equal(await pools.read.statusOf([0n]), State.Met);
    assert.equal((await pools.read.poolOf([0n])).seats, threshold);
    assert.equal(await pools.read.committedTinybars(), UNIT * BigInt(threshold));
  });

  describe("records a payment it cannot count, and says why", () => {
    it("the payer already holds a seat", async () => {
      const { pools, asCoordinator, buyer, settle } = await poolFixture();
      await settle(UNIT * 2n);
      await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]);

      const tx = await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(2)]);
      await viem.assertions.emitWithArgs(tx, pools, "LateDeposit", [
        0n,
        buyer(0),
        1n,
        UNIT,
        txId(2),
        LateReason.SeatTaken,
      ]);

      assert.equal((await pools.read.poolOf([0n])).seats, 1);
      assert.equal((await pools.read.depositAt([0n, 1n])).counted, false);
    });

    it("the amount is not the unit price", async () => {
      const { pools, asCoordinator, buyer, settle } = await poolFixture();
      const short = UNIT - 1n;
      await settle(short);

      const tx = await asCoordinator.write.recordDeposit([0n, buyer(0), short, txId(1)]);
      await viem.assertions.emitWithArgs(tx, pools, "LateDeposit", [
        0n,
        buyer(0),
        0n,
        short,
        txId(1),
        LateReason.WrongAmount,
      ]);

      assert.equal((await pools.read.poolOf([0n])).seats, 0);
    });

    it("the deadline has passed", async () => {
      const { pools, asCoordinator, buyer, settle, deadline } = await poolFixture();
      await settle(UNIT);
      await time.increaseTo(deadline);

      const tx = await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]);
      await viem.assertions.emitWithArgs(tx, pools, "LateDeposit", [
        0n,
        buyer(0),
        0n,
        UNIT,
        txId(1),
        LateReason.DeadlinePassed,
      ]);

      assert.equal((await pools.read.poolOf([0n])).seats, 0);
      assert.equal(await pools.read.statusOf([0n]), State.Expired);
    });

    it("the threshold was already met", async () => {
      const { pools, asCoordinator, buyer, settle, threshold } = await poolFixture({ threshold: 2 });
      for (let i = 0; i < threshold; i++) {
        await settle(UNIT);
        await asCoordinator.write.recordDeposit([0n, buyer(i), UNIT, txId(i)]);
      }
      assert.equal(await pools.read.statusOf([0n]), State.Met);

      await settle(UNIT);
      const tx = await asCoordinator.write.recordDeposit([0n, buyer(5), UNIT, txId(50)]);
      await viem.assertions.emitWithArgs(tx, pools, "LateDeposit", [
        0n,
        buyer(5),
        2n,
        UNIT,
        txId(50),
        LateReason.ThresholdMet,
      ]);

      assert.equal((await pools.read.poolOf([0n])).seats, threshold);
    });
  });

  it("owes a late payer their money back all the same", async () => {
    const { pools, asCoordinator, buyer, settle, deadline } = await poolFixture();
    await settle(UNIT);
    await time.increaseTo(deadline);
    await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]);

    // Uncounted is not unowed. The money arrived; it belongs to the payer either way.
    assert.equal(await pools.read.committedTinybars(), UNIT);
  });

  it("holds the solvency invariant across a pool's life", async () => {
    const { pools, asCoordinator, buyer, settle } = await poolFixture({ threshold: 2 });
    await settle(UNIT * 2n);
    await asCoordinator.write.recordDeposit([0n, buyer(0), UNIT, txId(1)]);
    await asCoordinator.write.recordDeposit([0n, buyer(1), UNIT, txId(2)]);

    // Two payments arrived, two are committed - and a third cannot be attributed to money
    // that is not there, even though the pool is now Met and the deposit would only be late.
    assert.equal(await pools.read.committedTinybars(), await pools.read.balanceTinybars());
    await viem.assertions.revertWithCustomError(
      asCoordinator.write.recordDeposit([0n, buyer(2), UNIT, txId(3)]),
      pools,
      "Insolvent",
    );
  });
});
