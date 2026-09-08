/**
 * Rebuild pool state from the log.
 *
 * The contract emits on every state transition precisely so this file never has to call back
 * into it - and on Hedera that is not a preference. The JSON-RPC relay implements no
 * `trace_filter` and no `trace_block`, so graph-node call handlers cannot run here at all, and
 * an `eth_call` from a mapping would read *current* state into a historical block. Everything
 * below is derived from event data and nothing else.
 */
import { Address, BigInt, ethereum, log } from "@graphprotocol/graph-ts";
import {
  DepositRecorded,
  LateDeposit,
  PayoutFailed,
  PoolCreated,
  PoolExpired,
  Refunded,
  Released,
  ThresholdMet,
  Withdrawn,
} from "../generated/QuorumPools/QuorumPools";
import {
  Account,
  Deposit,
  Participation,
  PayoutFailure,
  Pool,
  Protocol,
  Withdrawal,
} from "../generated/schema";

const PROTOCOL_ID = "quorum402";

const OPEN = "Open";
const MET = "Met";
const EXPIRED = "Expired";
const RELEASED = "Released";

/**
 * `LateReason` as the contract declares it. The order is the contract's, because an enum
 * crosses the wire as its index and nothing else.
 */
const LATE_REASONS: string[] = ["ThresholdMet", "DeadlinePassed", "SeatTaken", "WrongAmount"];

function lateReason(raw: i32): string {
  if (raw < 0 || raw >= LATE_REASONS.length) {
    // Halts the subgraph rather than inventing a label. A reason this file cannot name means
    // the contract gained an enum member and these mappings are behind it - worth stopping
    // for, because the alternative is a plausible-looking wrong answer.
    log.critical("LateDeposit carried reason {}, which these mappings have no name for", [
      raw.toString(),
    ]);
  }
  return LATE_REASONS[raw];
}

function protocol(block: ethereum.Block): Protocol {
  let p = Protocol.load(PROTOCOL_ID);
  if (p == null) {
    p = new Protocol(PROTOCOL_ID);
    p.poolCount = 0;
    p.openPools = 0;
    p.metPools = 0;
    p.releasedPools = 0;
    p.expiredPools = 0;
    p.depositCount = 0;
    p.lateCount = 0;
    p.payerCount = 0;
    p.tinybarsIn = BigInt.zero();
    p.tinybarsReleased = BigInt.zero();
    p.tinybarsRefunded = BigInt.zero();
    p.tinybarsStranded = BigInt.zero();
  }
  p.lastEventBlock = block.number;
  return p;
}

function account(address: Address): Account {
  let a = Account.load(address.toHexString());
  if (a == null) {
    a = new Account(address.toHexString());
    a.address = address;
    a.poolCount = 0;
    a.depositCount = 0;
    a.tinybarsPaid = BigInt.zero();
    a.tinybarsRefunded = BigInt.zero();
    a.creditTinybars = BigInt.zero();
  }
  return a;
}

function stateCount(p: Protocol, state: string, delta: i32): void {
  if (state == OPEN) p.openPools += delta;
  else if (state == MET) p.metPools += delta;
  else if (state == EXPIRED) p.expiredPools += delta;
  else if (state == RELEASED) p.releasedPools += delta;
}

/** Move a pool between states, keeping the per-state counters honest in one place. */
function moveTo(pool: Pool, p: Protocol, state: string): void {
  stateCount(p, pool.state, -1);
  pool.state = state;
  stateCount(p, state, 1);
}

function depositKey(poolId: BigInt, index: BigInt): string {
  return poolId.toString() + "-" + index.toString();
}

function participationKey(poolId: BigInt, payer: Address): string {
  return poolId.toString() + "-" + payer.toHexString();
}

/**
 * The payer's row for one pool, created on first contact.
 *
 * `poolCount` on the account is incremented here rather than in the handlers, because "how
 * many pools has this address paid into" is exactly "how many Participation rows does it
 * have", and counting it anywhere else is a second definition waiting to disagree.
 */
function participation(pool: Pool, a: Account, payer: Address, at: BigInt): Participation {
  const key = participationKey(pool.poolId, payer);
  let part = Participation.load(key);
  if (part == null) {
    part = new Participation(key);
    part.pool = pool.id;
    part.payer = a.id;
    part.seatTaken = false;
    part.depositCount = 0;
    part.tinybarsPaid = BigInt.zero();
    part.tinybarsRefunded = BigInt.zero();
    part.firstPaidAt = at;
    a.poolCount += 1;
  }
  return part;
}

export function handlePoolCreated(event: PoolCreated): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;

  const pool = new Pool(poolId.toString());
  pool.poolId = poolId;
  pool.coordinator = event.params.coordinator;
  pool.recipient = event.params.recipient;
  pool.unitTinybars = event.params.unitTinybars;
  pool.threshold = event.params.threshold.toI32();
  pool.deadline = event.params.deadline;
  pool.resourceUrl = event.params.resourceUrl;
  pool.state = OPEN;
  pool.seats = 0;
  pool.committedTinybars = BigInt.zero();
  pool.refundedTinybars = BigInt.zero();
  pool.createdAt = event.block.timestamp;
  pool.createdBlock = event.block.number;
  pool.createdTx = event.transaction.hash;
  pool.save();

  p.poolCount += 1;
  p.openPools += 1;
  p.save();
}

export function handleDepositRecorded(event: DepositRecorded): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("DepositRecorded for pool {}, which was never created", [poolId.toString()]);
    return;
  }

  const payer = event.params.payer;
  const a = account(payer);
  const tinybars = event.params.tinybars;
  const seats = event.params.seatsAfter.toI32();

  const deposit = new Deposit(depositKey(poolId, event.params.depositId));
  deposit.pool = pool.id;
  deposit.depositId = event.params.depositId;
  deposit.payer = a.id;
  deposit.payerAddress = payer;
  deposit.tinybars = tinybars;
  deposit.hederaTxId = event.params.hederaTxId;
  deposit.counted = true;
  deposit.seatsAfter = seats;
  deposit.recordedAt = event.block.timestamp;
  deposit.recordedBlock = event.block.number;
  deposit.recordedTx = event.transaction.hash;
  deposit.refunded = false;
  deposit.save();

  const part = participation(pool, a, payer, event.block.timestamp);
  part.seatTaken = true;
  part.depositCount += 1;
  part.tinybarsPaid = part.tinybarsPaid.plus(tinybars);
  part.save();

  // First payment ever from this address, so it joins the distinct-payer count. Checked
  // before the increment below, which is what makes it a transition rather than a state.
  if (a.depositCount == 0) p.payerCount += 1;
  a.depositCount += 1;
  a.tinybarsPaid = a.tinybarsPaid.plus(tinybars);
  a.save();

  pool.seats = seats;
  pool.committedTinybars = pool.committedTinybars.plus(tinybars);
  pool.save();

  p.depositCount += 1;
  p.tinybarsIn = p.tinybarsIn.plus(tinybars);
  p.save();
}

export function handleLateDeposit(event: LateDeposit): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("LateDeposit for pool {}, which was never created", [poolId.toString()]);
    return;
  }

  const payer = event.params.payer;
  const a = account(payer);
  const tinybars = event.params.tinybars;

  const deposit = new Deposit(depositKey(poolId, event.params.depositId));
  deposit.pool = pool.id;
  deposit.depositId = event.params.depositId;
  deposit.payer = a.id;
  deposit.payerAddress = payer;
  deposit.tinybars = tinybars;
  deposit.hederaTxId = event.params.hederaTxId;
  deposit.counted = false;
  deposit.lateReason = lateReason(event.params.reason);
  // The pool's seat count, which this payment did not change - that is what makes it late.
  deposit.seatsAfter = pool.seats;
  deposit.recordedAt = event.block.timestamp;
  deposit.recordedBlock = event.block.number;
  deposit.recordedTx = event.transaction.hash;
  deposit.refunded = false;
  deposit.save();

  const part = participation(pool, a, payer, event.block.timestamp);
  part.depositCount += 1;
  part.tinybarsPaid = part.tinybarsPaid.plus(tinybars);
  part.save();

  if (a.depositCount == 0) p.payerCount += 1;
  a.depositCount += 1;
  a.tinybarsPaid = a.tinybarsPaid.plus(tinybars);
  a.save();

  // Late money is still the pool's to give back, so it is committed like any other deposit.
  pool.committedTinybars = pool.committedTinybars.plus(tinybars);
  pool.save();

  p.lateCount += 1;
  p.tinybarsIn = p.tinybarsIn.plus(tinybars);
  p.save();
}

export function handleThresholdMet(event: ThresholdMet): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("ThresholdMet for pool {}, which was never created", [poolId.toString()]);
    return;
  }
  moveTo(pool, p, MET);
  pool.seats = event.params.seats.toI32();
  pool.metAt = event.params.at;
  pool.save();
  p.save();
}

export function handlePoolExpired(event: PoolExpired): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("PoolExpired for pool {}, which was never created", [poolId.toString()]);
    return;
  }
  moveTo(pool, p, EXPIRED);
  pool.settledAt = event.params.at;
  pool.save();
  p.save();
}

export function handleReleased(event: Released): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("Released for pool {}, which was never created", [poolId.toString()]);
    return;
  }
  const tinybars = event.params.tinybars;
  moveTo(pool, p, RELEASED);
  pool.releasedTinybars = tinybars;
  // `Released` carries no timestamp of its own, unlike ThresholdMet and PoolExpired, which
  // are emitted alongside the deadline arithmetic that produced them. The block's is the
  // same moment.
  pool.settledAt = event.block.timestamp;
  pool.committedTinybars = pool.committedTinybars.minus(tinybars);
  pool.save();

  p.tinybarsReleased = p.tinybarsReleased.plus(tinybars);
  p.save();
}

export function handleRefunded(event: Refunded): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("Refunded for pool {}, which was never created", [poolId.toString()]);
    return;
  }
  const key = depositKey(poolId, event.params.depositId);
  const deposit = Deposit.load(key);
  if (deposit == null) {
    log.critical("Refunded deposit {}, which was never recorded", [key]);
    return;
  }

  const tinybars = event.params.tinybars;
  deposit.refunded = true;
  deposit.refundedAt = event.block.timestamp;
  deposit.save();

  const payer = event.params.payer;
  const a = account(payer);
  a.tinybarsRefunded = a.tinybarsRefunded.plus(tinybars);
  a.save();

  const part = Participation.load(participationKey(poolId, payer));
  if (part == null) {
    log.critical("Refunded {} to {}, which holds no participation in pool {}", [
      key,
      payer.toHexString(),
      poolId.toString(),
    ]);
    return;
  }
  part.tinybarsRefunded = part.tinybarsRefunded.plus(tinybars);
  part.save();

  pool.refundedTinybars = pool.refundedTinybars.plus(tinybars);
  pool.committedTinybars = pool.committedTinybars.minus(tinybars);
  pool.save();

  p.tinybarsRefunded = p.tinybarsRefunded.plus(tinybars);
  p.save();
}

export function handlePayoutFailed(event: PayoutFailed): void {
  const p = protocol(event.block);
  const poolId = event.params.poolId;
  const pool = Pool.load(poolId.toString());
  if (pool == null) {
    log.critical("PayoutFailed for pool {}, which was never created", [poolId.toString()]);
    return;
  }
  const tinybars = event.params.tinybars;

  // One transition can strand money for several addresses - a refund sweep pushes to many -
  // so the id is the log's own position, not the pool's.
  const failure = new PayoutFailure(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  failure.pool = pool.id;
  failure.to = event.params.to;
  failure.tinybars = tinybars;
  failure.at = event.block.timestamp;
  failure.block = event.block.number;
  failure.tx = event.transaction.hash;
  failure.save();

  const a = account(event.params.to);
  a.creditTinybars = a.creditTinybars.plus(tinybars);
  a.save();

  p.tinybarsStranded = p.tinybarsStranded.plus(tinybars);
  p.save();
}

export function handleWithdrawn(event: Withdrawn): void {
  const p = protocol(event.block);
  const tinybars = event.params.tinybars;

  const withdrawal = new Withdrawal(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString(),
  );
  withdrawal.to = event.params.to;
  withdrawal.tinybars = tinybars;
  withdrawal.at = event.block.timestamp;
  withdrawal.block = event.block.number;
  withdrawal.tx = event.transaction.hash;
  withdrawal.save();

  const a = account(event.params.to);
  a.creditTinybars = a.creditTinybars.minus(tinybars);
  a.save();

  p.tinybarsStranded = p.tinybarsStranded.minus(tinybars);
  p.save();
}
