import { network } from "hardhat";

export const { viem, networkHelpers } = await network.getOrCreate();
export const { time } = networkHelpers;

/** 1 tinybar in weibars. Hedera's EVM denominates HBAR in weibars; x402 quotes tinybars. */
export const TINYBAR_TO_WEIBAR = 10n ** 10n;

export const HOUR = 3600n;

/** Tinybars, as weibars - what a `value:` field wants when the ledger is kept in tinybars. */
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

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
