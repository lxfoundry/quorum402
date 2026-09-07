# ADR 0004 — Deposits that cannot be refused

- **Date:** 2026-09-07
- **Status:** Accepted
- **Depends on:** [ADR 0002](0002-payment-attribution-on-hedera.md), [ADR 0003](0003-pool-authority-model.md)

## Context

Under the `exact` binding, **the money moves before the contract hears about it.** The
facilitator submits the transfer and it reaches consensus; only afterwards does the coordinator
call `recordDeposit`. The two steps are separate transactions with a real gap between them.

That inverts the usual assumption about input validation. In a normal payable function, a
`revert` returns the caller's funds and costs them nothing but gas. Here a `revert` leaves
settled HBAR sitting in the contract with no record of who sent it — and [ADR 0003](0003-pool-authority-model.md)
removed the owner, so there is no sweep. **A rejected deposit is a lost deposit.**

Several ordinary conditions produce exactly that:

| Condition | How it happens |
|---|---|
| Threshold already met | Buyer 6 settles in the same seconds buyer 5 crosses the line |
| Deadline already passed | The buyer paid in time; the coordinator recorded late |
| Payer already holds a seat | A retried client, or a buyer who did not see their first receipt |
| Amount is not the unit amount | A stale 402 challenge, or a pool whose price the client cached |

None of these is the buyer's fault in any way they could have avoided, and each of them
destroys real money if the contract answers with `revert`.

Separately, the deadline needs someone to notice it. A deadline passing produces no
transaction, so a pool that nobody touches stays `Open` in storage after it has expired in
fact.

## Decision

**`recordDeposit` never reverts for a buyer-side reason.** Every deposit is accepted. A deposit
that cannot take a seat is recorded as **late** — attributed to its payer, not counted toward
the threshold, and refundable immediately.

| Kind | Seat | Counts toward threshold | Refundable |
|---|---|---|---|
| **counted** | yes | yes | once the pool expires |
| **late** | no | no | at once, whatever state the pool is in |

The only reverts left are coordinator faults, where no funds are at risk:

| Reverts | Why it is safe to revert |
|---|---|
| Unknown `poolId` | Nothing was attributed, so nothing is lost that was not already lost |
| Caller is not the pool's coordinator | [ADR 0003](0003-pool-authority-model.md) |
| `hederaTxId` already recorded | Replay. The first record stands |
| Solvency check fails | The funds this claims to attribute have not arrived |
| `payer` is the zero address | Would create an unclaimable deposit |

**And expiry is lazy.** `claimRefund` and `refundAll` transition the pool to `Expired` and emit
`PoolExpired` before moving any funds, so `expire(poolId)` is an option and never a
prerequisite. A pool whose deadline has passed behaves as expired whether or not anyone said so.

The refund test is per deposit, not per pool:

```
refundable(deposit) = !deposit.refunded && (!deposit.counted || pool.state == Expired)
```

## Rationale

**Accepting a bad deposit costs a table row. Rejecting one costs the buyer their money.** The
asymmetry is total, and it does not depend on how likely any of the four conditions is. The
buyer-6 race is not even unlikely — it is the expected behaviour of a pool that fills, since
the whole point is that many buyers pay at once against a threshold none of them can watch
settle.

**Late deposits keep the accident visible.** The alternative — silently counting an overpayment,
or a second seat — would make the ledger disagree with the threshold semantics
[ADR 0003](0003-pool-authority-model.md) fixed. Recording the deposit and marking it refundable
keeps the arithmetic exact and leaves an event a subgraph can show: *this payment arrived and
did not make it.*

**Lazy expiry is also the correct ordering.** Setting the state before the transfer is
checks-effects-interactions, which the refund path needs anyway to be reentrancy-safe. Making
`expire` a public wrapper over the same internal transition costs one function and removes a
class of demo failure where a refund reverts because nobody ran a step first.

**It also removes the keeper.** Because refunds are pull-based and expiry is lazy, no scheduled
transaction, cron job or watcher is required for a pool to resolve correctly at its deadline.
`expire(poolId)` exists only so the expiry can be *stamped* on-chain and indexed at the moment
it happens, rather than at the moment the first buyer claims. Anyone may call it.

## Consequences

### The limitation this accepts: the coordinator's latency can cost a buyer their seat

The contract judges lateness by `block.timestamp` **when the deposit is recorded**, not when the
transfer reached consensus. It has no way to do otherwise — a Hedera contract cannot read a
mirror node, and a `paidAt` supplied by the coordinator would only move the trust rather than
remove it.

So a buyer who paid comfortably in time, whose attribution lands after the deadline, gets a
refund instead of a seat. Their money is safe; their seat is not. This is
[ADR 0002](0002-payment-attribution-on-hedera.md)'s liveness trust showing up in a concrete
place, and it is the sharpest argument for the unbuilt bindings, where the hold is
contract-mediated from the outset and the gap does not exist.

Mitigation is a convention on the resource server, not a contract change: **stop serving the
402 challenge for a pool before its deadline, by more than the settle-and-record round trip.**

### Other consequences

- `expire(poolId)` is **idempotent** — calling it on an already-expired pool succeeds and
  changes nothing. It reverts only when the deadline has not passed, or when the pool reached
  its threshold, both of which mean the caller has misread the state
- A pool can never become `Expired` after reaching its threshold: `recordDeposit` takes a seat
  only while `block.timestamp < deadline`, so `Met` is unreachable once the deadline is behind
- **`refundAll` works on a met or released pool**, because late deposits are refundable
  regardless of pool state. It is not gated on expiry
- A payer may hold several late deposits in one pool, so deposits are a list, not a mapping
  keyed by payer. `claimRefund` sweeps every refundable deposit the caller holds in that pool
- `PoolExpired` will usually be emitted **in the same transaction as the first `Refunded`**, and
  ordered before it. Subgraph mappings must not assume expiry arrives in a transaction of its own
