# ADR 0006 — Nothing settles until recording can succeed

- **Date:** 2026-09-08
- **Status:** Accepted
- **Depends on:** [ADR 0003](0003-pool-authority-model.md), [ADR 0004](0004-deposits-that-cannot-be-refused.md)
- **Implements:** [quorum-scheme.md §7](../quorum-scheme.md#7-resource-server-verification-rules-must) rules 2, 5, 6 and 7

## Context

`/settle` is the irreversible step. §7 rule 6 draws the consequence: once it reports success the
coordinator **MUST NOT** fail the request, because the money has moved and refusing the payer no
longer un-moves it.

[ADR 0004](0004-deposits-that-cannot-be-refused.md) removed every buyer-side revert from
`recordDeposit`. What it left behind is a short list of coordinator faults — and all of them now
land in the same place: the window between a settlement that cannot be undone and an attribution
that has not happened yet. Inside that window the payer has paid, the contract holds their HBAR,
and **nothing on chain says whose it is.** They hold a receipt and nothing else.

The window cannot be closed. It can be made very hard to enter, and that is a different and better
problem than making it survivable. Two facts make it available.

### The solvency guard's arithmetic cancels

`recordDeposit` refuses to attribute funds that have not arrived:

```solidity
uint256 wouldCommit = _totalCommitted + tinybars;
uint256 available = address(this).balance;
if (wouldCommit > available) revert Insolvent(wouldCommit, available);
```

By the time it runs, the balance already includes the payment being recorded. Writing `C` for
`_totalCommitted` and `B` for the balance *before* this payment landed, the revert condition is

```
C + tinybars  >  B + tinybars     ⟺     C > B
```

**The deposit's own amount cancels.** Whether this deposit can be recorded does not depend on this
deposit at all — it depends on whether the contract was already solvent for its existing
commitments, which is two view calls and is knowable before anything settles.

### The coordinator reads current state, not indexed state

`PoolsClient` goes through `ContractCallQuery` and `ContractExecuteTransaction` on the SDK client,
so its reads and writes are consensus-node operations against current state. The mirror-node
polling in `scripts/check-payout.ts` is a *verification* that the network agrees the money moved;
it is not a precondition of recording, and the coordinator does not inherit it.

That matters because it removes the reason to wait. A design that blocked on a mirror node before
recording would be pacing itself against a REST API's indexing lag rather than against consensus.

## Decision

**Every condition under which `recordDeposit` could fail is checked before `/settle` is called.**
A payment that would not be recordable is refused with 402 while the buyer still has their money.

### 1. Pre-flight

Each of `recordDeposit`'s reverts has a pre-settle counterpart:

| Revert | Checked before settle by |
|---|---|
| `Insolvent` | `committedTinybars() <= balanceTinybars()` — the cancellation above |
| `NotCoordinator` | `poolOf(poolId).coordinator` equals this server's operator address |
| `NoSuchPool` | `poolId < poolCount()` |
| `ZeroAddress` | the payer's EVM address resolves from the ledger — §7 rule 5's derivation, run early |
| `ZeroAmount` | the advertised unit amount is non-zero |
| `DuplicateTransaction` | the transaction id is already in the buyer's signed transaction, so it can be looked up before it is used |

Two coordinator faults revert nothing and are checked the same way: the operator account holds
enough HBAR to pay for the call, and the pool is `Open` with its deadline far enough ahead
(below).

`DuplicateTransaction` deserves a note, because the check is softer than the others. Under the
Hedera `exact` binding the buyer sets `transactionId` to one generated for the facilitator's
account and freezes it there, so the id is readable from `payload.binding.transaction` before
settlement — but the contract keeps only `keccak256(hederaTxId)` in private storage and exposes no
getter, so the coordinator asks the index rather than the contract. That is subject to indexing
lag, and it is belt-and-braces regardless: a genuine replay of the same payload is rejected by the
network before it reaches the contract, because Hedera will not accept a duplicate transaction id.

### 2. The 402 stops before the deadline does

[ADR 0004](0004-deposits-that-cannot-be-refused.md) names the mitigation for its own limitation —
a buyer who pays in time and is recorded late loses their seat, not their money — and leaves it to
the resource server. This is where it lives: **the coordinator stops advertising a pool one
settle-and-record round trip before its deadline**, and answers 402 for a pool inside that guard
interval as though it were closed.

### 3. After settling, the request does not fail

Pre-flight makes the remaining faults transient by construction, so they are retried rather than
reported:

- **`Insolvent` after a clean pre-flight can only mean the transfer is not yet visible to the node
  being asked.** The ambiguity is gone: the contract was solvent a moment ago, so the shortfall is
  the payment's own arrival. Retry a small number of times over a few seconds.
- **`DuplicateTransaction` on a retry means the previous attempt succeeded** and its response was
  lost. It is a success, and the deposit is read back rather than re-recorded. Treating it as a
  failure would manufacture a permanent phantom in the failure log.

Whether the retry is ever needed depends on something this project has not measured: whether the
facilitator's `/settle` returns before or after its transaction reaches consensus. The retry costs
nothing when the answer is "after", and is the difference between a working payment and a lost one
when it is "before". It is not worth resolving by inspection when it can be covered.

### 4. A failure that survives all of that is recorded where a maintainer and a script can both find it

The coordinator holds no database — deliberately, because §8 derives entitlement from chain state
so that a server restart loses nothing. A failure log is the one thing that wants to be durable,
and giving it a private database would put the system's only piece of invisible, trusted state
exactly where its failures are.

So the log is layered, and no layer is load-bearing alone:

| Layer | What it is | Built |
|---|---|---|
| **Structured stderr** | One JSON line — pool, payer, tinybars, transaction id, error — written synchronously before anything else is attempted | ✅ |
| **Manual drain** | `recordDeposit` is coordinator-only but idempotent by its own replay guard, so a maintainer can safely re-run it from a log line after fixing the cause | ✅ |
| **An HCS topic** | The durable queue: append-only, consensus-ordered, timestamped, readable by anyone through the mirror node | ❌ **Chosen, not built** |
| **The payer's receipt** | §7 rule 6 already returns `attributed: false` with the transaction id, so the party with the most at stake holds a copy and can trigger a retry by presenting it | ❌ Follows §8 redemption |

**The Hedera Consensus Service is the right home for this queue, and the reason is not
convenience.** A failed attribution is the coordinator's fault, in a design whose entire claim is
that the coordinator holds nothing you have to trust it for. Writing those failures to a private
store would make the one class of event that reflects badly on the coordinator the one class only
the coordinator can see. On HCS the failures are as publicly auditable as the successes: the retry
worker, the maintainer, the payer and a reviewer all read the same ordered log, and its
consensus timestamps are not the coordinator's to edit.

It is recorded here as the chosen design and left unimplemented, rather than left out. The stderr
line carries the same fields, so the queue can be added behind the same call site without changing
what is logged.

## Rationale

**Preconditions beat reconciliation.** The alternative shape — settle first, then reconcile
whatever failed — was rejected. It is the same amount of code, and it moves the buyer's exposure
from "was refused, still has their money" to "has paid, is waiting for someone to notice". A
reconciliation loop is still needed for the residue either way; the question is only how much
traffic goes through it, and pre-flight makes that answer *approximately none* instead of
*whatever fails*.

**Polling the mirror node was rejected for a reason worth writing down.** It looked necessary and
was not: it paces the coordinator against an indexing API that nothing in the recording path
consults. It also degrades badly under exactly the condition it exists for, since a slow index
makes every payment slow rather than making one payment correct.

**The cancellation is what makes the rule affordable.** "Check everything before the irreversible
step" is easy to assert and usually impossible, because the irreversible step is what creates the
state the checks need. Here it happens to be false: the solvency guard's dependence on the
payment cancels exactly, so the one check that looked like it needed the payment to have arrived
does not. Two view calls buy the whole rule.

**stderr is the floor because it cannot fail.** HCS is a Hedera transaction, so a coordinator that
cannot pay for `recordDeposit` cannot pay to record that it could not. A durable queue whose
availability correlates with the failure it exists to capture is not a floor, however good it is
as a queue.

## Consequences

- **Two extra view calls per payment**, before settlement. On a threshold-gated resource where a
  payer waits on a facilitator round trip anyway, this is not a cost worth optimising.
- **A pool is unbuyable for a short interval before its deadline.** That is the point — the
  alternative is selling a seat the coordinator cannot deliver — but the guard interval is a
  guess at a round trip, and a bad guess is visible as either lost selling time or lost seats.
- **The residual window is real and is not claimed to be closed.** A coordinator that dies between
  `/settle` returning and its log line reaching stderr leaves a payment attributable only from
  the facilitator's records and the payer's receipt. Every layer above narrows this; none removes
  it. It is the same liveness trust [ADR 0002](0002-payment-attribution-on-hedera.md) accepted,
  observed at its narrowest point.
- **Retrying is safe, and that is a property of the contract rather than of the coordinator.**
  `_txIdSeen` makes attribution exactly-once whoever calls it and however often, which is what
  lets a manual drain be a supported operation instead of a dangerous one.
- The unbuilt bindings do not have this problem in this form. Where the hold is contract-mediated
  from the outset, there is no gap between settlement and attribution for a coordinator to fall
  into — see [ADR 0001](0001-what-quorum-binds-to.md).
