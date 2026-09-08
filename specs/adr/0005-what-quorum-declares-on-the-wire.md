# ADR 0005 — What `quorum` declares on the wire

- **Date:** 2026-09-08
- **Status:** Accepted
- **Depends on:** [ADR 0001](0001-what-quorum-binds-to.md)

## Context

[ADR 0001](0001-what-quorum-binds-to.md) decided that `quorum` composes over `exact`. It did not
decide how a resource server *announces* a quorum-gated resource, and that turns out to be the
harder question, because the payment underneath is an ordinary `exact` payment and the wire has
to carry the part that is not ordinary.

x402 v2 declares two axes. Read from `specs/x402-specification-v2.md` and
`specs/schemes/exact/scheme_exact.md` in `x402-foundation/x402`, fetched **2026-09-08**:

| Field | What it declares |
|---|---|
| `scheme` | *"Payment scheme identifier"*. Spec §6: schemes *"define how payments are formed, validated, and settled"* |
| `extra.paymentFlow` | Spec §6.1: *"**when** settlement occurs relative to resource execution"* — `authorization`, `upfront`, `escrow` |

`quorum` fits neither as defined. Its payment **formation** is `exact`'s, unchanged — that is the
whole point of composing over it. Its **timing** is `upfront`-like: funds commit before the
resource runs. What differs is something neither field expresses: the resource may never be
produced at all, because the release condition is the participation of other payers.

Two further facts shape the decision.

**The skip rule is written against `paymentFlow`, not `scheme`:**

> Clients MUST NOT construct a payment for a `paymentFlow` they do not recognize, and SHOULD skip
> such `accepts[]` entries when selecting.

There is no equivalent normative rule for an unrecognised `scheme`. A client that ignores an
unknown scheme is following convention, not the specification.

**`upfront` leaves the payer without a remedy, and says so:**

> Under `upfront` the payment commits first, so a handler failure leaves the client charged with
> nothing delivered; this specification defines no refund, and any remedy is the resource
> server's own arrangement.

## Options

**A — an extension over `exact`.** x402 v2 has an extensions mechanism, and coordination terms
could ride in it. Every existing client could pay without change.

**B — a new scheme, and nothing else.** `scheme: "quorum"` in `accepts`, and rely on clients
ignoring what they do not recognise.

**C — a new scheme, a new payment flow, and a plain `exact` fallback entry.** Three declarations,
each carrying a different part of the truth.

## Decision

**Option C.**

1. **`scheme: "quorum"`** — a wrapping scheme whose payload nests the hold binding's payload
   verbatim.
2. **`extra.paymentFlow: "conditional"`** — a fourth flow, proposed here: funds commit before the
   resource, and the resource may never execute, in which case the commitment is reversed by a
   path the scheme defines.
3. **A second `accepts[]` entry**, plain `exact`, describing the identical payment and declaring
   `paymentFlow: "upfront"`. The withholding is named at the response level, in
   `resource.description` and in `error` — an `accepts[]` entry has no human-readable field to
   carry it. That asymmetry is the fallback's residual weakness, and it is the Consequence below.

## Rationale

**Entitlement changed, so the scheme changed.** A settled `exact` payment entitles the payer to
the resource. A settled `quorum` payment entitles them to a seat, and to their money back if the
seat never becomes a resource. `scheme` is the field that carries what paying means; putting a
change of that size in `extra` leaves a payment whose entitlement silently differs from what its
scheme promises. Option A fails on this alone.

**Ordering changed, so the flow changed.** Spec §6.1 defines flows by where `/verify` and
`/settle` sit around resource execution, and requires `extra.paymentFlow` to be present whenever the resolved
flow is not `authorization` — *"so clients can reason about pre-handler fund commitment without
scheme-specific knowledge"*. That reasoning extends one step: a client should be able to reason
about whether the resource is guaranteed to execute at all, without scheme-specific knowledge.
`conditional` is that declaration.

**The fallback is what makes legacy behaviour defined rather than hoped for.** Option B rests on
an unrecognised scheme being skipped, and the specification does not say that. Declaring
`paymentFlow: "conditional"` invokes the one skip rule that *is* normative, and the `exact` entry
then gives a client that skipped it something real to pay. The two entries describe the same
payment — same `payTo`, `amount`, `asset` — because under this design there is nothing exotic
about the payment itself.

**Proposing a value for a protocol-reserved key is done in the open.** Spec §6.1 reserves
`paymentFlow` and requires that clients and servers *"MUST interpret them as defined here rather
than as opaque scheme-private fields"*. A new value is therefore a specification-level act, not a
private extension, and it is written up as a flow with an ordering row rather than smuggled in as
a string this project happens to emit.

## Consequences

- **A generic client can pay, and cannot participate.** It pays the fallback, is recorded, holds a
  seat, and receives a receipt instead of the resource. If the pool fails it is refunded without
  doing anything, because `refundAll` is permissionless and pushes. If the pool succeeds it must
  return to redeem, which it will not know how to do — but because entitlement is derived from
  chain state rather than a session, **nothing is permanently lost as long as it holds the paying
  key**.
- **The fallback entry is accurate about timing and silent about conditionality.** `upfront` is a
  true statement about when funds commit and cannot express that the resource is conditional.
  `resource.description` carries it in prose, which no client is obliged to read. This is the
  residual weakness of offering a fallback at all, and the price of the interoperability it buys.
- **`quorum` now proposes two things upstream, not one.** The flow is the more reusable of the
  two: anything whose resource is contingent — an auction that may not clear, a booking that may
  not reach minimum numbers — needs the same declaration, and none of it is quorum-specific.
- **The Hedera `exact` binding declares neither an `assetTransferMethod` nor a default flow**, so
  a client has nothing to resolve against. Declaring `paymentFlow` explicitly on both entries is
  not politeness here; spec §6.1 requires it once the resolved flow is not `authorization`. This
  is a rule a server must obey, so it is stated normatively in
  [quorum-scheme.md](../quorum-scheme.md) §5 rather than only here.
