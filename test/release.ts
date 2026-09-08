import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESOURCE,
  State,
  poolFixture,
  takeSeats,
  time,
  txId,
  viem,
} from "./helpers.js";

describe("release", () => {
  it("pays the recipient the pool named at creation, and nothing else", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, recipient, threshold, unit } = fixture;
    await takeSeats(fixture, threshold);

    const tx = await pools.write.release([0n]);
    await viem.assertions.emitWithArgs(tx, pools, "Released", [
      0n,
      recipient,
      unit * BigInt(threshold),
    ]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: recipient, amount: unit * BigInt(threshold) },
    ]);

    assert.equal(await pools.read.statusOf([0n]), State.Released);
    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal(await pools.read.balanceTinybars(), 0n);
  });

  it("is permissionless - it chooses nothing, so gating it would only let someone stall", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    await takeSeats(fixture, 2);

    // A buyer, who has no authority anywhere else in this contract.
    const asBuyer = await fixture.asBuyer(4);
    await asBuyer.write.release([0n]);

    assert.equal(await fixture.pools.read.statusOf([0n]), State.Released);
  });

  it("pays for seats only, leaving a late payer's money where it is", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    const { pools, asCoordinator, buyer, settle, recipient, unit } = fixture;
    await takeSeats(fixture, 2);

    // A payment that arrived after the threshold was met. It is owed back, not paid out.
    await settle(unit);
    await asCoordinator.write.recordDeposit([0n, buyer(5), unit, txId(50)]);

    const tx = await pools.write.release([0n]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: recipient, amount: unit * 2n },
    ]);

    assert.equal(await pools.read.committedTinybars(), unit);
    assert.equal(await pools.read.balanceTinybars(), unit);
  });

  it("refuses a pool that has not met its threshold", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await takeSeats(fixture, 2);

    await viem.assertions.revertWithCustomError(
      fixture.pools.write.release([0n]),
      fixture.pools,
      "NotMet",
    );
  });

  it("refuses a pool that missed its deadline", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await takeSeats(fixture, 2);
    await time.increaseTo(fixture.deadline);

    await viem.assertions.revertWithCustomError(
      fixture.pools.write.release([0n]),
      fixture.pools,
      "NotMet",
    );
  });

  it("refuses to pay a second time", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    await takeSeats(fixture, 2);
    await fixture.pools.write.release([0n]);

    await viem.assertions.revertWithCustomError(
      fixture.pools.write.release([0n]),
      fixture.pools,
      "NotMet",
    );
  });

  it("still pays a met pool after its deadline - quorum was reached, and stays reached", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    const { pools, recipient, unit } = fixture;
    await takeSeats(fixture, 2);
    await time.increaseTo(fixture.deadline + 1n);

    assert.equal(await pools.read.statusOf([0n]), State.Met);
    const tx = await pools.write.release([0n]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: recipient, amount: unit * 2n },
    ]);
  });

  describe("when the recipient will not take the money", () => {
    it("credits it rather than stranding it, and still owes it", async () => {
      const picky = await viem.deployContract("PickyRecipient");
      const fixture = await poolFixture({ threshold: 2 });
      const { pools, coordinator, asCoordinator, buyer, settle, unit } = fixture;

      const deadline = BigInt(await time.latest()) + 3600n;
      await pools.write.createPool([picky.address, coordinator, unit, 2, deadline, RESOURCE]);
      for (let i = 0; i < 2; i++) {
        await settle(unit);
        await asCoordinator.write.recordDeposit([1n, buyer(i), unit, txId(100 + i)]);
      }

      const tx = await pools.write.release([1n]);
      await viem.assertions.emitWithArgs(tx, pools, "PayoutFailed", [
        1n,
        picky.address,
        unit * 2n,
      ]);

      // The pool is done, but the money has not left, so it is still owed.
      assert.equal(await pools.read.statusOf([1n]), State.Released);
      assert.equal(await pools.read.creditOf([picky.address]), unit * 2n);
      assert.equal(await pools.read.committedTinybars(), unit * 2n);
      assert.equal(await pools.read.balanceTinybars(), unit * 2n);
    });

    it("lets it be pulled later, once it will", async () => {
      const picky = await viem.deployContract("PickyRecipient");
      const fixture = await poolFixture({ threshold: 2 });
      const { pools, coordinator, asCoordinator, buyer, settle, unit } = fixture;

      const deadline = BigInt(await time.latest()) + 3600n;
      await pools.write.createPool([picky.address, coordinator, unit, 2, deadline, RESOURCE]);
      for (let i = 0; i < 2; i++) {
        await settle(unit);
        await asCoordinator.write.recordDeposit([1n, buyer(i), unit, txId(100 + i)]);
      }
      await pools.write.release([1n]);

      await picky.write.setAccepting([true]);
      const tx = await picky.write.withdrawFrom([pools.address]);
      await viem.assertions.emitWithArgs(tx, pools, "Withdrawn", [picky.address, unit * 2n]);

      assert.equal(await pools.read.creditOf([picky.address]), 0n);
      assert.equal(await pools.read.committedTinybars(), 0n);
      assert.equal(await pools.read.balanceTinybars(), 0n);
    });
  });

  it("has nothing to withdraw for someone owed nothing", async () => {
    const { pools } = await poolFixture();
    await viem.assertions.revertWithCustomError(pools.write.withdraw(), pools, "NoCredit");
  });
});

describe("expire", () => {
  it("stamps a pool whose deadline passed, for anyone who asks", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await takeSeats(fixture, 1);
    await time.increaseTo(fixture.deadline);

    const asBuyer = await fixture.asBuyer(4);
    const tx = await asBuyer.write.expire([0n]);
    await viem.assertions.emit(tx, fixture.pools, "PoolExpired");

    assert.equal((await fixture.pools.read.poolOf([0n])).state, State.Expired);
  });

  it("is optional - a pool reads as expired before anyone stamps it", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await time.increaseTo(fixture.deadline);

    assert.equal(await fixture.pools.read.statusOf([0n]), State.Expired);
    assert.equal((await fixture.pools.read.poolOf([0n])).state, State.Open);
  });

  it("does nothing the second time, rather than failing", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await time.increaseTo(fixture.deadline);
    await fixture.pools.write.expire([0n]);

    await fixture.pools.write.expire([0n]);
    assert.equal(await fixture.pools.read.statusOf([0n]), State.Expired);
  });

  it("refuses a pool whose deadline has not passed", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await viem.assertions.revertWithCustomError(
      fixture.pools.write.expire([0n]),
      fixture.pools,
      "NotDue",
    );
  });

  it("refuses a met pool, whatever the clock says", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    await takeSeats(fixture, 2);
    await time.increaseTo(fixture.deadline + 1n);

    await viem.assertions.revertWithCustomError(
      fixture.pools.write.expire([0n]),
      fixture.pools,
      "NotDue",
    );
    assert.equal(await fixture.pools.read.statusOf([0n]), State.Met);
  });

  it("refuses a released pool", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    await takeSeats(fixture, 2);
    await fixture.pools.write.release([0n]);
    await time.increaseTo(fixture.deadline + 1n);

    await viem.assertions.revertWithCustomError(
      fixture.pools.write.expire([0n]),
      fixture.pools,
      "NotDue",
    );
  });
});
