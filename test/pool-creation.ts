import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOUR, State, ZERO_ADDRESS, time, viem } from "./helpers.js";

const UNIT = 100_000_000n; // 1 HBAR in tinybars
const RESOURCE = "https://quorum402.example/resource/1";

async function deploy() {
  const pools = await viem.deployContract("QuorumPools");
  const [offerer, coordinator, recipient] = await viem.getWalletClients();
  const deadline = (await time.latest()) + Number(HOUR);
  return {
    pools,
    offerer: offerer!.account.address,
    coordinator: coordinator!.account.address,
    recipient: recipient!.account.address,
    deadline: BigInt(deadline),
  };
}

describe("createPool", () => {
  it("allocates pool ids sequentially from zero", async () => {
    const { pools, coordinator, recipient, deadline } = await deploy();
    assert.equal(await pools.read.poolCount(), 0n);

    await pools.write.createPool([recipient, coordinator, UNIT, 3, deadline, RESOURCE]);
    await pools.write.createPool([recipient, coordinator, UNIT, 3, deadline, RESOURCE]);

    assert.equal(await pools.read.poolCount(), 2n);
  });

  it("stores the terms it was given, and opens the pool", async () => {
    const { pools, coordinator, recipient, deadline } = await deploy();
    await pools.write.createPool([recipient, coordinator, UNIT, 5, deadline, RESOURCE]);

    const pool = await pools.read.poolOf([0n]);
    assert.equal(pool.recipient.toLowerCase(), recipient.toLowerCase());
    assert.equal(pool.coordinator.toLowerCase(), coordinator.toLowerCase());
    assert.equal(pool.unitTinybars, UNIT);
    assert.equal(pool.threshold, 5);
    assert.equal(pool.seats, 0);
    assert.equal(pool.deadline, deadline);
    assert.equal(pool.state, State.Open);
    assert.equal(pool.resourceUrl, RESOURCE);
    assert.equal(await pools.read.statusOf([0n]), State.Open);
  });

  it("emits PoolCreated with the terms a subgraph needs", async () => {
    const { pools, coordinator, recipient, deadline } = await deploy();
    const tx = await pools.write.createPool([recipient, coordinator, UNIT, 5, deadline, RESOURCE]);

    await viem.assertions.emitWithArgs(tx, pools, "PoolCreated", [
      0n,
      coordinator,
      recipient,
      UNIT,
      5,
      deadline,
      RESOURCE,
    ]);
  });

  it("commits nothing on creation - a pool starts owing no one anything", async () => {
    const { pools, coordinator, recipient, deadline } = await deploy();
    await pools.write.createPool([recipient, coordinator, UNIT, 5, deadline, RESOURCE]);

    assert.equal(await pools.read.committedTinybars(), 0n);
    assert.equal(await pools.read.balanceTinybars(), 0n);
  });

  describe("refuses terms that could never settle", () => {
    it("a threshold of zero, which would be met before anyone paid", async () => {
      const { pools, coordinator, recipient, deadline } = await deploy();
      await viem.assertions.revertWithCustomError(
        pools.write.createPool([recipient, coordinator, UNIT, 0, deadline, RESOURCE]),
        pools,
        "BadThreshold",
      );
    });

    it("a unit price of zero, which would let a seat be taken for nothing", async () => {
      const { pools, coordinator, recipient, deadline } = await deploy();
      await viem.assertions.revertWithCustomError(
        pools.write.createPool([recipient, coordinator, 0n, 3, deadline, RESOURCE]),
        pools,
        "BadUnitAmount",
      );
    });

    it("a deadline that has already passed, which is born expired", async () => {
      const { pools, coordinator, recipient } = await deploy();
      const past = BigInt(await time.latest());
      await viem.assertions.revertWithCustomError(
        pools.write.createPool([recipient, coordinator, UNIT, 3, past, RESOURCE]),
        pools,
        "DeadlineInPast",
      );
    });

    it("a zero recipient, which would burn the proceeds", async () => {
      const { pools, coordinator, deadline } = await deploy();
      await viem.assertions.revertWithCustomError(
        pools.write.createPool([ZERO_ADDRESS, coordinator, UNIT, 3, deadline, RESOURCE]),
        pools,
        "ZeroAddress",
      );
    });

    it("a zero coordinator, which no one could ever record a deposit for", async () => {
      const { pools, recipient, deadline } = await deploy();
      await viem.assertions.revertWithCustomError(
        pools.write.createPool([recipient, ZERO_ADDRESS, UNIT, 3, deadline, RESOURCE]),
        pools,
        "ZeroAddress",
      );
    });
  });

  it("has no pool at an unallocated id", async () => {
    const { pools } = await deploy();
    await viem.assertions.revertWithCustomError(pools.read.poolOf([0n]), pools, "NoSuchPool");
  });
});
