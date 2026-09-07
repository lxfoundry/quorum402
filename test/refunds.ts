import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEventLogs } from "viem";
import { State, poolFixture, takeSeats, time, txId, viem, weibars } from "./helpers.js";

describe("claimRefund", () => {
  it("pays a buyer back when the pool missed its deadline", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, buyer, unit, deadline } = fixture;
    await takeSeats(fixture, 2);
    await time.increaseTo(deadline);

    const asBuyer = await fixture.asBuyer(0);
    const tx = await asBuyer.write.claimRefund([0n]);

    await viem.assertions.emitWithArgs(tx, pools, "Refunded", [0n, buyer(0), 0n, unit]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: buyer(0), amount: weibars(unit) },
    ]);

    assert.equal((await pools.read.depositAt([0n, 0n])).refunded, true);
    assert.equal(await pools.read.committedTinybars(), unit); // the other buyer's, still owed
  });

  it("stamps the pool expired on the way, ordered before the refund", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, publicClient, deadline } = fixture;
    await takeSeats(fixture, 1);
    await time.increaseTo(deadline);

    assert.equal((await pools.read.poolOf([0n])).state, State.Open);
    const asBuyer = await fixture.asBuyer(0);
    const hash = await asBuyer.write.claimRefund([0n]);
    const receipt = await publicClient.getTransactionReceipt({ hash });

    // The spec warns a subgraph mapping that assumes expiry has a transaction of its own
    // will mis-order state. It does not: both events land here, expiry first.
    const events = parseEventLogs({ abi: pools.abi, logs: receipt.logs }).map((e) => e.eventName);
    assert.deepEqual(events, ["PoolExpired", "Refunded"]);
    assert.equal(await pools.read.statusOf([0n]), State.Expired);
  });

  it("refuses while the pool can still succeed", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await takeSeats(fixture, 2);

    const asBuyer = await fixture.asBuyer(0);
    await viem.assertions.revertWithCustomError(
      asBuyer.write.claimRefund([0n]),
      fixture.pools,
      "NothingToRefund",
    );
  });

  it("refuses a counted deposit in a met pool - quorum was reached", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    await takeSeats(fixture, 2);
    await time.increaseTo(fixture.deadline + 1n);

    const asBuyer = await fixture.asBuyer(0);
    await viem.assertions.revertWithCustomError(
      asBuyer.write.claimRefund([0n]),
      fixture.pools,
      "NothingToRefund",
    );
  });

  it("pays a late deposit back at once, without waiting for the deadline", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, asCoordinator, buyer, settle, unit } = fixture;
    const short = unit - 1n;
    await settle(short);
    await asCoordinator.write.recordDeposit([0n, buyer(0), short, txId(1)]);

    assert.equal(await pools.read.statusOf([0n]), State.Open);
    const asBuyer = await fixture.asBuyer(0);
    const tx = await asBuyer.write.claimRefund([0n]);

    await viem.assertions.balancesHaveChanged(tx, [{ address: buyer(0), amount: weibars(short) }]);
    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal(await pools.read.statusOf([0n]), State.Open); // still open, still fillable
  });

  it("is still open to a late payer after the pool was released", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    const { pools, asCoordinator, buyer, settle, unit } = fixture;
    await takeSeats(fixture, 2);
    await settle(unit);
    await asCoordinator.write.recordDeposit([0n, buyer(5), unit, txId(50)]);
    await pools.write.release([0n]);

    const asLate = await fixture.asBuyer(5);
    const tx = await asLate.write.claimRefund([0n]);
    await viem.assertions.balancesHaveChanged(tx, [{ address: buyer(5), amount: weibars(unit) }]);
    assert.equal(await pools.read.committedTinybars(), 0n);
  });

  it("sweeps every deposit the caller holds, in one call", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, asCoordinator, buyer, settle, unit, deadline } = fixture;
    await takeSeats(fixture, 1); // buyer 0 takes a seat
    for (const n of [10, 11]) {
      await settle(unit); // and then pays twice more, taking no seat either time
      await asCoordinator.write.recordDeposit([0n, buyer(0), unit, txId(n)]);
    }
    await time.increaseTo(deadline);

    const asBuyer = await fixture.asBuyer(0);
    const tx = await asBuyer.write.claimRefund([0n]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: buyer(0), amount: weibars(unit * 3n) },
    ]);
    assert.equal(await pools.read.committedTinybars(), 0n);
  });

  it("refuses a second time", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await takeSeats(fixture, 1);
    await time.increaseTo(fixture.deadline);

    const asBuyer = await fixture.asBuyer(0);
    await asBuyer.write.claimRefund([0n]);
    await viem.assertions.revertWithCustomError(
      asBuyer.write.claimRefund([0n]),
      fixture.pools,
      "NothingToRefund",
    );
  });

  it("pays a payer who reenters exactly once", async () => {
    const attacker = await viem.deployContract("ReentrantPayer");
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, asCoordinator, settle, unit, deadline, publicClient } = fixture;

    await settle(unit);
    await asCoordinator.write.recordDeposit([0n, attacker.address, unit, txId(1)]);
    await attacker.write.arm([pools.address, 0n]);
    await time.increaseTo(deadline);

    const before = await publicClient.getBalance({ address: attacker.address });
    await attacker.write.claim();
    const after = await publicClient.getBalance({ address: attacker.address });

    assert.equal(await attacker.read.reentryAttempts(), 1n);
    assert.equal(await attacker.read.reentryPaid(), false);
    assert.equal(after - before, weibars(unit));
    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal(await pools.read.balanceTinybars(), 0n);
  });

  it("pays each of a reentering payer's deposits exactly once, when the inner claim succeeds", async () => {
    const attacker = await viem.deployContract("ReentrantPayer");
    const fixture = await poolFixture({ threshold: 3 });
    const { pools, asCoordinator, settle, unit, deadline, publicClient } = fixture;

    // Two deposits from one payer: the first takes a seat, the second cannot and is late from
    // the moment it lands. Both are refundable once the pool expires, which is what makes the
    // inner claim find something to pay - the case the single-deposit test above cannot reach,
    // because there the reentry always reverts NothingToRefund and proves only that the
    // attacker got nothing. Here the reentry *succeeds*, and what stops the money being paid
    // twice is the storage re-read of `refunded` on each pass of the outer loop.
    await settle(unit);
    await asCoordinator.write.recordDeposit([0n, attacker.address, unit, txId(1)]);
    await settle(unit);
    await asCoordinator.write.recordDeposit([0n, attacker.address, unit, txId(2)]);
    await attacker.write.arm([pools.address, 0n]);
    await time.increaseTo(deadline);

    const before = await publicClient.getBalance({ address: attacker.address });
    await attacker.write.claim();
    const after = await publicClient.getBalance({ address: attacker.address });

    assert.equal(await attacker.read.reentryAttempts(), 1n);
    assert.equal(await attacker.read.reentryPaid(), true);
    assert.equal(after - before, weibars(unit * 2n));

    // Where a double payment would show: the contract would be short, and would still believe
    // it owed something.
    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal(await pools.read.balanceTinybars(), 0n);

    const [first, second] = [
      await pools.read.depositAt([0n, 0n]),
      await pools.read.depositAt([0n, 1n]),
    ];
    assert.equal(first.refunded, true);
    assert.equal(second.refunded, true);
  });
});

describe("refundAll", () => {
  it("pushes refunds for everyone, so a broke buyer needs no gas", async () => {
    const fixture = await poolFixture({ threshold: 4 });
    const { pools, buyer, unit, deadline } = fixture;
    await takeSeats(fixture, 3);
    await time.increaseTo(deadline);

    const tx = await pools.write.refundAll([0n, 10n]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: buyer(0), amount: weibars(unit) },
      { address: buyer(1), amount: weibars(unit) },
      { address: buyer(2), amount: weibars(unit) },
    ]);
    assert.equal(await pools.read.committedTinybars(), 0n);
  });

  it("stops at maxDeposits and resumes where the money still is", async () => {
    const fixture = await poolFixture({ threshold: 4 });
    const { pools, unit, deadline } = fixture;
    await takeSeats(fixture, 3);
    await time.increaseTo(deadline);

    await pools.write.refundAll([0n, 2n]);
    assert.equal(await pools.read.committedTinybars(), unit);
    assert.equal((await pools.read.depositAt([0n, 2n])).refunded, false);

    await pools.write.refundAll([0n, 2n]);
    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal((await pools.read.depositAt([0n, 2n])).refunded, true);
  });

  it("returns nothing to do rather than failing, so a driver loop can just stop", async () => {
    const fixture = await poolFixture({ threshold: 4 });
    await takeSeats(fixture, 2);
    await time.increaseTo(fixture.deadline);
    await fixture.pools.write.refundAll([0n, 10n]);

    assert.equal((await fixture.pools.simulate.refundAll([0n, 10n])).result, 0n);
    await fixture.pools.write.refundAll([0n, 10n]); // and it does not revert
  });

  it("keeps going past a payer who will not take the money", async () => {
    const picky = await viem.deployContract("PickyRecipient");
    const fixture = await poolFixture({ threshold: 4 });
    const { pools, asCoordinator, buyer, settle, unit, deadline } = fixture;

    await settle(unit);
    await asCoordinator.write.recordDeposit([0n, picky.address, unit, txId(80)]);
    await takeSeats(fixture, 2);
    await time.increaseTo(deadline);

    const tx = await pools.write.refundAll([0n, 10n]);
    await viem.assertions.emitWithArgs(tx, pools, "PayoutFailed", [0n, picky.address, unit]);
    await viem.assertions.balancesHaveChanged(tx, [
      { address: buyer(0), amount: weibars(unit) },
      { address: buyer(1), amount: weibars(unit) },
    ]);

    // The refusing payer is owed, not forgotten, and the pool is otherwise settled.
    assert.equal(await pools.read.creditOf([picky.address]), unit);
    assert.equal(await pools.read.committedTinybars(), unit);
  });

  it("expires a due pool itself, so nobody has to call expire first", async () => {
    const fixture = await poolFixture({ threshold: 3 });
    await takeSeats(fixture, 1);
    await time.increaseTo(fixture.deadline);

    assert.equal((await fixture.pools.read.poolOf([0n])).state, State.Open);
    const tx = await fixture.pools.write.refundAll([0n, 10n]);
    await viem.assertions.emit(tx, fixture.pools, "PoolExpired");
    assert.equal((await fixture.pools.read.poolOf([0n])).state, State.Expired);
  });

  it("refunds nothing from a pool that met its threshold", async () => {
    const fixture = await poolFixture({ threshold: 2 });
    await takeSeats(fixture, 2);
    await time.increaseTo(fixture.deadline + 1n);

    assert.equal((await fixture.pools.simulate.refundAll([0n, 10n])).result, 0n);
    assert.equal(await fixture.pools.read.committedTinybars(), fixture.unit * 2n);
  });
});
