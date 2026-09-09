/**
 * Everything that must be true before a payment is settled.
 *
 * [ADR 0006](../../specs/adr/0006-nothing-settles-until-recording-can-succeed.md). `/settle` is
 * irreversible and `quorum-scheme.md` §7 rule 6 forbids failing the request after it returns,
 * so the window between settlement and attribution is where a payer can end up having paid
 * with nothing on chain saying whose money it is. This is the gate that keeps traffic out of
 * it: every condition under which `recordDeposit` could fail, checked while the buyer still
 * has their money.
 *
 * The check that looks impossible is the solvency one, because the funds arrive *with* the
 * settlement. It cancels. `recordDeposit` reverts `Insolvent` when
 * `_totalCommitted + tinybars > address(this).balance`, and by the time it runs the balance
 * already includes this payment, so with `C` for committed and `B` for the balance before the
 * payment landed:
 *
 *     C + tinybars > B + tinybars   ⟺   C > B
 *
 * The deposit's own amount appears on both sides. Whether this deposit can be recorded depends
 * only on whether the contract was already solvent, which is two view calls and needs nothing
 * to have settled.
 */
import type { PoolAvailability, UnavailableReason } from "./pools.js";

export type PreflightRefusal =
  /** §7 rule 2. The pool is closed, past its deadline, or inside the guard interval. */
  | { reason: "pool-not-selling"; cause: UnavailableReason; detail: string }
  /** This server is not the pool's coordinator, so `recordDeposit` would revert. */
  | { reason: "not-our-pool"; detail: string }
  /** `C > B`: the contract cannot cover what it already owes, so this deposit cannot be added. */
  | { reason: "contract-insolvent"; detail: string }
  /** The coordinator cannot pay for the call it is about to need. */
  | { reason: "coordinator-underfunded"; detail: string }
  /** This settlement has already been attributed. */
  | { reason: "duplicate-transaction"; detail: string };

export type PreflightResult = { ok: true } | ({ ok: false } & PreflightRefusal);

/**
 * How much HBAR the coordinator must hold before it will settle anything.
 *
 * Sized to be many `recordDeposit` calls rather than one, so the refusal - and the alert -
 * arrives while there is still room to fix it, instead of at the moment it first matters.
 * Five HBAR against a call that costs a small fraction of one.
 */
export const MIN_COORDINATOR_TINYBARS = 500_000_000n;

export interface SolvencyReader {
  committedTinybars(): Promise<bigint>;
  balanceTinybars(): Promise<bigint>;
}

export interface PreflightDeps {
  contract: SolvencyReader;
  /** This server's Hedera account id - the coordinator that will call `recordDeposit`. */
  coordinatorAccountId: string;
  /** The same account's EVM address, which is what a pool stores. */
  coordinatorAddress: string;
  /**
   * What the coordinator holds. A thunk rather than a mirror URL, so this gate is a decision
   * over numbers and can be tested as one - the network read belongs to whoever wires it.
   */
  coordinatorBalanceTinybars: () => Promise<bigint>;
  minCoordinatorTinybars?: bigint;
  /**
   * Whether this settlement has already been attributed. Optional, and softer than the rest.
   *
   * The contract hashes `hederaTxId` into private storage and exposes no getter, so the only
   * place to ask is the index - which lags. It is also belt-and-braces: a genuine replay of
   * the same payload carries the same transaction id, and Hedera refuses a duplicate
   * transaction id before it ever reaches the contract. Left injectable rather than assumed,
   * so wiring the index in later changes this file not at all.
   *
   * **May reject.** A rejection is no opinion, not a refusal - see the call below for why that
   * rule belongs here rather than at whatever wires the index in.
   */
  isAlreadyRecorded?: (hederaTxId: string) => Promise<boolean>;
}

/**
 * May this payment be settled?
 *
 * Takes the pool's availability rather than re-deriving it, so that "is this pool still
 * selling" has exactly one implementation (`PoolRegistry`) and one answer.
 */
export async function preflight(
  deps: PreflightDeps,
  params: { availability: PoolAvailability; hederaTxId: string },
): Promise<PreflightResult> {
  const { availability } = params;
  if (!availability.available) {
    return {
      ok: false,
      reason: "pool-not-selling",
      cause: availability.reason,
      detail: `pool ${availability.terms.poolId} is ${availability.state} and ${availability.reason}`,
    };
  }

  const { terms } = availability;
  if (terms.coordinator.toLowerCase() !== deps.coordinatorAddress.toLowerCase()) {
    return {
      ok: false,
      reason: "not-our-pool",
      detail: `pool ${terms.poolId} names coordinator ${terms.coordinator}, this server is ${deps.coordinatorAddress}`,
    };
  }

  const [committed, balance] = await Promise.all([
    deps.contract.committedTinybars(),
    deps.contract.balanceTinybars(),
  ]);
  if (committed > balance) {
    return {
      ok: false,
      reason: "contract-insolvent",
      detail: `the contract owes ${committed} tinybars and holds ${balance}`,
    };
  }

  const floor = deps.minCoordinatorTinybars ?? MIN_COORDINATOR_TINYBARS;
  const coordinatorBalance = await deps.coordinatorBalanceTinybars();
  if (coordinatorBalance < floor) {
    return {
      ok: false,
      reason: "coordinator-underfunded",
      detail: `coordinator ${deps.coordinatorAccountId} holds ${coordinatorBalance} tinybars, below the ${floor} floor`,
    };
  }

  // §6.2 and ADR 0006: a definite yes refuses, and nothing else does. The index lags, so it can
  // never prove a payment is *new* - the contract's own guard stays the authority, and this
  // only catches a duplicate early enough to save the payer a settlement. An index that cannot
  // answer therefore has no opinion, because refusing good payments during an index outage
  // would trade away the thing this scheme exists to do for a guard already enforced elsewhere.
  //
  // The rule lives here, with the gate, rather than in a `.catch` wherever the index is wired:
  // a second caller would otherwise have to rediscover it from a comment.
  if (deps.isAlreadyRecorded && (await recordedSays(deps.isAlreadyRecorded, params.hederaTxId))) {
    return {
      ok: false,
      reason: "duplicate-transaction",
      detail: `${params.hederaTxId} has already been attributed`,
    };
  }

  return { ok: true };
}

/** A definite yes, or no opinion. An index that cannot answer never refuses a payment. */
async function recordedSays(
  ask: (hederaTxId: string) => Promise<boolean>,
  hederaTxId: string,
): Promise<boolean> {
  try {
    return await ask(hederaTxId);
  } catch (error) {
    // Logged, because otherwise an index outage is loud on the redemption path and completely
    // silent here - two halves of one incident that would look unrelated.
    const because = error instanceof Error ? error.message : String(error);
    console.error(`replay check skipped for ${hederaTxId}: ${because}`);
    return false;
  }
}
