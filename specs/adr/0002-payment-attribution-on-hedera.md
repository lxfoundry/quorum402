# ADR 0002 — Payment attribution on Hedera

- **Date:** 2026-09-07
- **Status:** Accepted
- **Depends on:** [ADR 0001](0001-what-quorum-binds-to.md)

## Context

`quorum` needs to know **who paid into which pool**. On Hedera, the x402 `exact` binding
makes that non-obvious.

The binding is a *native* Hedera transfer, not an EVM call. The client builds a
`TransferTransaction`, sets `transactionId.accountId` to the facilitator's fee-payer account,
signs it — leaving it partially signed — and base64-encodes it into the payment payload. The
facilitator verifies it, adds the fee-payer signature, submits it, and sponsors the gas.

The facilitator's verification rules are strict, and deliberately so:

> The decompiled transaction MUST be a `TransferTransaction` **directly**. It MUST NOT be
> wrapped in a `ScheduleCreateTransaction` or any other transaction type.

> Contain **only** transfer operations (HBAR or HTS FT transfers) necessary to implement the
> requested payment. No additional transfers or non-transfer operations are allowed.

Two consequences follow. First, the payment cannot carry a contract call. Second — and this
is the part that surprises people arriving from EVM — **a native Hedera transfer to a
contract does not execute that contract's code at all.** Hedera's own documentation is
explicit that sending HBAR via `TransferTransaction` does not invoke a contract's
`fallback()`; triggering code requires `ContractExecuteTransaction` with a payable amount,
which the binding forbids.

So funds arrive, and nothing on-chain records who sent them or why. There is a gap between
*"1100 tinybars landed"* and *"Alice is buyer #3 in pool P"*, and it has to be closed on
purpose.

## Options

**A — `payTo` is the pool contract's account; the coordinator attributes afterwards.**
Funds transfer straight to the contract. The resource server, which receives the settlement
response containing a Hedera `transactionId`, then calls
`recordDeposit(payer, amount, transactionId)` and the contract stores that id.

**B — `payTo` is a treasury account; the coordinator forwards funds into the contract.**
Simplest to implement.

**C — the buyer self-registers with a second transaction.**
The buyer pays, then calls `join(poolId)` themselves.

**D — a wrapper token whose transfer performs the join.**
Pay in a wrapped asset whose transfer logic moves the underlying token *and* registers the
payer atomically.

## Decision

**Option A.** `payTo` is the pool contract's account, and the coordinator attributes each
deposit by binding it to the Hedera transaction id that produced it.

## Rationale

**A keeps custody with the contract.** Funds are never held by the coordinator; they land in
the pool at the moment of settlement.

**Binding the transaction id bounds the trust.** Every recorded deposit names a real Hedera
transaction that any third party can independently verify on a mirror node or explorer: that
this payer really transferred this amount to this contract. **The coordinator can omit a
deposit, but it cannot invent one.** That asymmetry matters — fabricated deposits would let a
threshold be crossed fraudulently, and this design makes that impossible without a real
on-chain payment behind it.

**B was rejected** because the coordinator custodies funds between arrival and forwarding.
The whole point of a threshold pool is that participants need not trust the organiser with
their money.

**C was rejected** because it adds a transaction to a flow whose value is that an agent
completes payment in a single x402 handshake — and the contract still cannot verify that the
transfer happened, so the friction buys nothing.

**D does not work on Hedera, and is instructive about why.** See below.

## Option D in detail: the wrapper-token approach

The idea: instead of paying in USDC, pay in a wrapper whose transfer moves the underlying
USDC *and* calls `pool.join(from, amount)` in the same transaction. Attribution becomes
atomic and trustless — no coordinator, no gap.

**On EVM this works.** The `exact` binding there settles by the facilitator calling
`transferWithAuthorization` (EIP-3009) on the token contract, which the spec recommends as
the simplest, truly gasless path. That is a call into a contract the project would deploy, so
its logic is entirely under the project's control. A variant is cleaner still: the Permit2
path already routes settlement through a proxy contract that enforces receiver security via a
witness pattern, so a pool-aware proxy achieves the same atomic join **without changing the
asset**.

**On Hedera it cannot work, for two independent reasons.** The payment is a native transfer
that never enters the EVM, so the wrapper's code has no execution point. And the feature that
would fix this properly — [HIP-1195
Hooks](https://hedera.com/blog/introducing-hooks-programmable-customization-for-hedera-entities/),
which attaches EVM logic to native entities and can execute during `CryptoTransfer` — is
**not available on the Hedera public network**; it exists in the Hiero codebase for
experimentation, and its first use case is allowance hooks that approve or reject a transfer
rather than perform arbitrary side effects. HTS custom fees route value on transfer but
execute no code, so they do not help either.

**The trade-off is the interesting part, and it holds even on EVM.** A wrapper solves
attribution by changing *what the payer must hold*. A generic x402 client holding real USDC
can no longer pay; it must wrap first. For a scheme claiming generality, that buys
trustlessness with interoperability — a bad trade at the scheme level.

This is precisely why `quorum` prefers bindings that change **the hold** rather than **the
asset**. `auth-capture` and `escrow` ([ADR 0001](0001-what-quorum-binds-to.md)) give per-payer,
contract-mediated holds while leaving the asset untouched.

## Consequences

### The limitation this accepts, stated plainly

If the coordinator never records a payment, those funds sit in the contract unattributed, and
the buyer's reclaim path cannot reach them from contract state alone — a Hedera contract
cannot read a mirror node to prove the transfer happened. **This design trusts the
coordinator for liveness, though not for integrity.**

This is a real weakness and is not papered over. It is also the strongest available argument
for the unbuilt bindings: over `auth-capture` or `escrow`, the hold is per-payer and
contract-mediated from the outset, and the assumption disappears entirely. The limitation is
a property of the `exact` binding, not of `quorum`.

Mitigations adopted: short deadlines, so exposure is measured in minutes. A later upgrade
would be an intent-first `commit(poolId)` so the contract knows which payers to expect before
money moves.

### Other consequences

- The pool contract's account is the `payTo` target, so it must not require a receiver
  signature
- HBAR (asset id `0.0.0`, amounts in tinybars) is the initial demo asset. HTS tokens are
  viable where accounts carry automatic association, but HBAR removes a moving part from the
  first settled payment
- A scheduled transaction can never *be* the x402 payment — the binding forbids the wrapping
  explicitly. Deadline resolution is a separate transaction, where scheduling remains open
- **When HIP-1195 Hooks reach the public network, this limitation is removable on Hedera**
  without changing `quorum` itself. That is a property of a coordination layer that does not
  depend on how holds are implemented
