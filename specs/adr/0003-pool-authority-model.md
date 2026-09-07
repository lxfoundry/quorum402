# ADR 0003 — Who may do what to a pool

- **Date:** 2026-09-07
- **Status:** Accepted
- **Depends on:** [ADR 0002](0002-payment-attribution-on-hedera.md)

## Context

[ADR 0002](0002-payment-attribution-on-hedera.md) puts the pool contract's own Hedera account
in `payTo`, and closes the attribution gap with a coordinator that records each settled
payment. That leaves an authority question the ADR did not answer: **who is that coordinator,
who may open a pool in the first place, and who — if anyone — holds a key over the funds
while they sit in the contract?**

The question is not cosmetic. A threshold pool exists because participants do not want to
trust the organiser with their money. Any privileged role that can reach the funds subtracts
directly from the thing the primitive claims.

One contract serves many pools. Each pool carries its own threshold, deadline, unit price and
recipient, and pools share a single Hedera account balance.

## Options

**A — One global coordinator, owned contract.** The deployer is the operator; it alone opens
pools and records deposits. Simplest, and matches a single-tenant resource server.

**B — Permissionless creation, coordinator named per pool.** Anyone opens a pool and names the
resource server that will attribute payments to it. No global role exists.

**C — Permissionless creation, per-pool deposit address.** As B, but a factory clones a child
contract per pool, so each pool has its own Hedera entity and `payTo`, and funds are
physically segregated rather than tracked in a shared ledger.

## Decision

**Option B. The contract is ownerless — no admin, no pause, no upgrade — `createPool` is
permissionless, and each pool names its own coordinator.**

Three rules follow, and are enforced on-chain:

| Rule | Enforcement |
|---|---|
| **No privileged account exists** | There is no owner variable. The deployer's address appears nowhere in storage |
| **A coordinator may attribute, and nothing else** | `recordDeposit` is gated on `msg.sender == pool.coordinator`. No other method admits it |
| **Attributed funds are backed by real funds** | Global solvency invariant, checked on every `recordDeposit` (below) |

Two semantics are fixed here because they are authority questions in disguise:

- **One seat per payer.** The threshold counts *distinct payers*, each paying exactly the
  advertised unit amount. A second payment from the same account does not buy a second seat
- **A pool's terms are immutable once created.** Threshold, deadline, unit amount, recipient
  and coordinator are set at creation and no method changes them

## Rationale

**The backend is needed for attribution, not for creation.** The coordinator is the only party
that can record a deposit, so a pool no coordinator serves is inert — anyone may create it, and
no money can ever be attributed to it. That is what makes permissionless creation safe rather
than merely permissive: naming the coordinator *in the pool* is the act that gives a pool
meaning, and it is the offerer who names it.

**An admin key is a liability in this design, not a safety net.** The failure it would guard
against — a stuck or misconfigured pool — is already handled by the deadline and the refund
path. What it would add is a party who can freeze a refund. For a primitive whose entire claim
is "you do not have to trust the organiser with your money", that trade is the wrong way round.

**The solvency invariant turns ADR 0002's trust claim into an on-chain one.** ADR 0002 argues
that a coordinator "can omit a deposit, but cannot invent one" — true, but as stated it rests
on third parties checking the mirror node. The contract can enforce a stronger version
directly. Let `totalCommitted` be every tinybar the contract owes to a payer or a recipient.
Then, on every `recordDeposit`:

```
totalCommitted + amount  <=  address(this).balance / 1e10
```

`totalCommitted` rises when a deposit is recorded and falls **only when HBAR actually leaves
the contract**. A threshold therefore cannot be crossed without real HBAR having arrived, and
no pool can be paid out of another pool's funds. It costs one storage slot.

**Option A was rejected** because it reintroduces the organiser the primitive exists to remove,
and because it makes the contract read as one backend's private ledger rather than a reference
implementation of a scheme. `quorum` is proposed as a scheme others would implement; a venue
whose operation requires the author's server is a poor argument for that.

**Option C is better where coordinators distrust each other, and costs more than this
deployment needs.** See the limitation below.

## Consequences

### The limitation this accepts: coordinators can race for unattributed funds

Nothing on-chain links an incoming transfer to a pool — that is the whole of ADR 0002. With
per-pool coordinators, a coordinator of pool B can therefore attribute, to pool B, a payment
that a buyer made for pool A.

The solvency invariant bounds this precisely. Funds already committed to pool A are counted in
`totalCommitted`, so B cannot reach them: there is no headroom. What B can take is money that
has arrived and has **not yet been attributed to anything** — the window between settlement and
`recordDeposit`, which is the same window ADR 0002 already identifies and already mitigates
with short deadlines.

**This is a real weakness of a shared deposit address, and Option C is the fix**, not a larger
invariant: one Hedera entity per pool segregates the funds and the race disappears. It is not
built because it costs a contract deployment and a mirror-node entity-id lookup per pool, paid
before any pool works at all, to close a race that only opens between coordinators who distrust
each other. **The demo runs a single coordinator, so the race is not exercised; the design does
not depend on that being true.**

### Other consequences

- **Unattributed funds are unrecoverable.** With no owner there is no sweep. HBAR that arrives
  and is never recorded stays in the contract forever. This is deliberate: a sweep is a
  privileged path to the money, which is the thing being refused. It also gives the coordinator
  a reason to be correct, since it cannot fix a mistake afterwards
- **The payer must be recorded as an EVM address**, not a Hedera account id, or the refund path
  has no `msg.sender` to match. The coordinator resolves `0.0.x → 0x…` before recording. The
  Hedera transaction id is stored alongside it, as a string, so any third party can verify the
  deposit against the ledger
- **Sybil resistance is absent.** "Distinct payers" means distinct accounts, and accounts are
  free. `quorum` coordinates payment, not identity; a deployment that needs sybil resistance
  composes an identity check at the coordinator. Stated rather than implied
- Immutable terms mean a pool created wrong is abandoned, not corrected. With short deadlines
  and permissionless creation, the cost is one wasted pool
