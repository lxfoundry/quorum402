import { network } from "hardhat";

export const { viem, networkHelpers } = await network.getOrCreate();
export const { time } = networkHelpers;

/** 1 tinybar in weibars. Hedera's EVM denominates HBAR in weibars; x402 quotes tinybars. */
export const TINYBAR_TO_WEIBAR = 10n ** 10n;

export const HOUR = 3600n;

/** 1 HBAR, in tinybars - the unit price every fixture uses unless it says otherwise. */
export const UNIT = 100_000_000n;

export const RESOURCE = "https://quorum402.example/resource/1";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Tinybars as weibars - what a `value:` field wants when the ledger is kept in tinybars. */
export function weibars(tinybars: bigint): bigint {
  return tinybars * TINYBAR_TO_WEIBAR;
}

export enum State {
  Open = 0,
  Met = 1,
  Expired = 2,
  Released = 3,
}

export enum LateReason {
  ThresholdMet = 0,
  DeadlinePassed = 1,
  SeatTaken = 2,
  WrongAmount = 3,
}

export interface PoolOptions {
  threshold?: number;
  unit?: bigint;
  /** Seconds from now until the deadline. */
  ttl?: bigint;
}

/**
 * A deployed contract with one pool open in it, plus contract handles bound to each actor.
 *
 * The actors are the ones the spec names: an offerer who opened the pool and is its recipient,
 * a coordinator (the resource server) who is the only account that may record a deposit, and
 * buyers who touch the contract only if the pool fails.
 */
export async function poolFixture(options: PoolOptions = {}) {
  const wallets = await viem.getWalletClients();
  const [offerer, coordinatorWallet, ...buyerWallets] = wallets;
  const publicClient = await viem.getPublicClient();

  const pools = await viem.deployContract("QuorumPools");
  const as = (wallet: (typeof wallets)[number]) =>
    viem.getContractAt("QuorumPools", pools.address, { client: { wallet } });

  const threshold = options.threshold ?? 3;
  const unit = options.unit ?? UNIT;
  const deadline = BigInt(await time.latest()) + (options.ttl ?? HOUR);
  const recipient = offerer!.account.address;
  const coordinator = coordinatorWallet!.account.address;

  await pools.write.createPool([recipient, coordinator, unit, threshold, deadline, RESOURCE]);

  /**
   * Put HBAR in the contract the way an x402 settlement does.
   *
   * On Hedera the real transfer is a native CryptoTransfer that credits the contract with no
   * code executed - which is the point of ADR 0002, and was verified on testnet before this
   * contract was written. There is no such thing here, so the fixture sends value and lands in
   * `receive()`. The contract cannot tell the difference: neither path attributes anything, and
   * attribution is `recordDeposit`'s job either way.
   */
  async function settle(tinybars: bigint): Promise<void> {
    const hash = await offerer!.sendTransaction({ to: pools.address, value: weibars(tinybars) });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const buyers = buyerWallets.slice(0, 6);

  return {
    pools,
    asCoordinator: await as(coordinatorWallet!),
    asBuyer: async (index: number) => as(buyers[index]!),
    buyer: (index: number) => buyers[index]!.account.address,
    buyerCount: buyers.length,
    offerer: offerer!,
    recipient,
    coordinator,
    threshold,
    unit,
    deadline,
    publicClient,
    settle,
    as,
  };
}

/** A distinct, plausible-looking Hedera transaction id. Only its uniqueness matters here. */
export function txId(n: number): string {
  return `0.0.${1000 + n}@178879${String(1000 + n).padStart(4, "0")}.000000000`;
}

export type PoolFixture = Awaited<ReturnType<typeof poolFixture>>;

/** Settle and record `count` payments from distinct buyers, the way a filling pool does. */
export async function takeSeats(fixture: PoolFixture, count: number, from = 0): Promise<void> {
  for (let i = from; i < from + count; i++) {
    await fixture.settle(fixture.unit);
    await fixture.asCoordinator.write.recordDeposit([0n, fixture.buyer(i), fixture.unit, txId(i)]);
  }
}
