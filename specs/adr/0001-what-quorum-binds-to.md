# ADR 0001 — What `quorum` binds to

- **Date:** 2026-09-07
- **Status:** Accepted
- **Supersedes:** —

## Context

`quorum` describes coordination over **N payers**: a threshold, a deadline, and a collective
outcome where funds are captured only if enough distinct payers commit before the deadline,
and released to everyone otherwise.

That coordination has to sit on top of *some* mechanism that holds an individual payer's
funds between commitment and outcome. x402 defines four schemes as of 2026-09-07:

| Scheme | Semantics | Network bindings |
|---|---|---|
| `exact` | Buyer authorises the advertised amount; one transfer | 17, including Hedera |
| `upto` | Buyer authorises a ceiling; seller settles actual usage | EVM, SVM |
| `batch-settlement` | One buyer's repeated micropayments against a reusable channel | EVM, SVM, Cloudflare |
| `auth-capture` | Hold, then `capture` / `void` / `refund` / `reclaim` against a deadline | **EVM only** |

`auth-capture` is the interesting one: in its default `escrow` payment flow, `authorize`
places a hold before the resource runs, and an `extra.captureDeadline` bounds how long the
hold can stand before the client may `reclaim`. That is per-payer hold-and-refund-on-a-
deadline — half of what `quorum` needs — already standardised.

There is also an open proposal, [`scheme: "escrow"`
(x402-foundation/x402#2222)](https://github.com/x402-foundation/x402/issues/2222), which
takes the opposite architectural position: standardise the **wire format** and leave the
escrow contract implementation-defined, so that no single implementation is privileged.

> **Disclosure.** Issue #2222 was authored by this project's author, on behalf of Boson
> Protocol, and remains open. It is referenced here as one of two candidate hold bindings,
> not as settled standard. Its content is cited; no text or code from
> `bosonprotocol/x402-escrow-schema` or `bosonprotocol/x402B` is reused in this project.

## Options

**Compose over `auth-capture`.** Let each payer's funds sit in a standard `auth-capture`
hold; `quorum` coordinates capture-all or void-all across N of them. Architecturally the
cleanest fit — the hold already exists, with the right lifecycle and the right deadline
semantics.

**Compose over `exact`.** Each payer makes a plain `exact` payment into a pool that enforces
the threshold. The hold is the pool, not the scheme.

**Compose over `escrow` (#2222).** Same shape as `auth-capture`, but against a wire format
rather than a canonical lifecycle.

## Decision

**Build `quorum` over `exact`, settling on Hedera. Specify the coordination semantics
abstractly, and name `auth-capture` and `escrow` as candidate hold bindings without building
either.**

| Binding | In this project | Upstream status |
|---|---|---|
| `exact` + pool contract, Hedera | **Implemented and demonstrated** | Merged; 17 bindings |
| `auth-capture` | One paragraph; how it would bind, what is unproven | Merged; **EVM-only** |
| `escrow` (#2222) | One paragraph, with the disclosure above | **Proposed, open** |

## Rationale

**`auth-capture` has no Hedera binding.** Its spec directory contains the scheme document and
an EVM binding, and nothing else. Composing over it on Hedera would mean writing and
implementing that binding first — a research-shaped task of unbounded size, ahead of any
working payment.

**The facilitator settles `exact` and nothing else.** Verified live on 2026-09-07 against the
Hedera testnet facilitator's capability endpoint, which returned HTTP 200 and:

```json
{"kinds":[
  {"x402Version":2,"scheme":"exact","network":"eip155:80002"},
  {"x402Version":2,"scheme":"exact","network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "extra":{"feePayer":"7B6Q2Mvc…"}},
  {"x402Version":2,"scheme":"exact","network":"hedera:testnet","extra":{"feePayer":"0.0.7162784"}}
]}
```

`exact` is the only scheme offered — on *every* network advertised, not just Hedera. This is
a feasibility decision, not a judgement on `auth-capture`'s design.

**Naming both unbuilt bindings is the argument, not padding.** `auth-capture` and `escrow`
are competing answers to the same question: whether the hold mechanism belongs *inside* the
scheme, or behind a wire format that leaves it implementation-defined. #2222 declines
explicitly to privilege any one implementation, naming `AuthCaptureEscrow` (PR #1425) among
others. If `quorum` binds cleanly to both sides of that argument, it is demonstrably
**orthogonal to the axis the ecosystem is currently contesting** — it survives either
outcome. A single binding would only illustrate; two competing ones make it structural.

There is a concrete technical fit as well: #2222's `nextActions` envelope — a server telling
a client what to do next without the client hard-coding state transitions — is close in shape
to what a `quorum` coordinator must express to N buyers ("threshold met, capture" versus
"deadline passed, reclaim").

## Consequences

- The `exact` binding cannot execute contract code at payment time on Hedera, so attribution
  needs a deliberate mechanism. That is [ADR 0002](0002-payment-attribution-on-hedera.md)
- The spec must argue `quorum`'s distinctness against `auth-capture` **by name**. The claim
  is *not* "x402 cannot hold funds and refund on a deadline" — as of `auth-capture`, it can.
  The claim is that x402 cannot express **coordination across payers**, where one payer's
  release is conditional on others showing up
- Exactly three bindings are named and one is built. Adding more would read as having built
  none of them; each unbuilt binding gets a short, honest paragraph and no more
