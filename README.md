# quorum402

[![CI](https://github.com/lxfoundry/quorum402/actions/workflows/ci.yml/badge.svg)](https://github.com/lxfoundry/quorum402/actions/workflows/ci.yml)

**An HTTP 402 challenge that a crowd can answer together.**

Funds are held, and the resource unlocks only if enough separate buyers pay before the
deadline. If the threshold is not reached, everyone is refunded.

Built from scratch for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026)
(Classic / "From Scratch" track).

> 🚧 **Status: day 1 of the build window.** Everything below marked `TODO` is a
> placeholder to be filled as the work lands — nothing here is claimed as working yet.

---

## The gap this fills

[x402](https://x402.org) turns HTTP `402 Payment Required` into a real payment handshake.
Its schemes today all describe **one payer settling one request**:

| Scheme | Semantics |
|---|---|
| `exact` | Buyer authorises the advertised amount |
| `upto` | Buyer authorises a ceiling; seller settles actual usage |
| `batch-settlement` | One buyer's repeated micropayments accumulate against a reusable channel |

None of them can express **"I will pay if enough others do."** That is a different shape:
many distinct payers, one resource, an all-or-nothing outcome, and a refund path when the
crowd does not show up.

`quorum402` proposes and implements that missing shape as a scheme named **`quorum`**.

The same mechanism covers minimum-participant offers (a trip that runs at 20 travellers),
tiered group buying (the price falls as the pool fills), and all-or-nothing crowdfunding.

---

## How it works

TODO — mechanism walkthrough, once the escrow and the payment path are wired.

## The `quorum` scheme

The scheme semantics and a reference implementation are specified in [`specs/`](specs/),
written alongside the code rather than after it.

Design decisions are recorded as they are made:

- [ADR 0001 — What `quorum` binds to](specs/adr/0001-what-quorum-binds-to.md) — why the
  reference implementation composes over `exact`, and why `auth-capture` and `escrow` are
  named as candidate hold bindings rather than built
- [ADR 0002 — Payment attribution on Hedera](specs/adr/0002-payment-attribution-on-hedera.md)
  — why a native Hedera transfer cannot carry a pool join, the options weighed, and the trust
  boundary this design accepts
- [ADR 0003 — Who may do what to a pool](specs/adr/0003-pool-authority-model.md) — why the
  contract is ownerless, why each pool names its own coordinator, and the solvency invariant
  that stops a threshold being crossed without real funds
- [ADR 0004 — Deposits that cannot be refused](specs/adr/0004-deposits-that-cannot-be-refused.md)
  — why the money moves before the contract hears about it, and why rejecting a payment would
  destroy it

The contract those decisions describe is specified in
[specs/pool-contract.md](specs/pool-contract.md), written before the code, and implemented in
[contracts/QuorumPools.sol](contracts/QuorumPools.sol).

TODO — the `quorum` scheme spec itself, as the implementation lands.

---

## Deployed contracts

| Contract | Network | Address | Explorer |
|---|---|---|---|
| TODO | Hedera Testnet | TODO | TODO |

## Partner integrations

Each row points at the **exact contract and lines** implementing the integration, so it can
be verified without reading the whole tree.

| Partner | What we use it for | Where in this repo |
|---|---|---|
| TODO | TODO | TODO |

---

## Running it

TODO — verified from a clean clone before submission. Prerequisites, install, configure,
deploy to testnet, run the demo.

```bash
# TODO
```

## Demo

TODO — video link.

---

## Repository layout

```
contracts/    the pool contract that holds a pool's funds, and its test support
src/          the x402 wire types and the Hedera `exact` payment path
scripts/      preflight checks against Hedera testnet, run before the design relied on them
test/         contract tests, run on a local EVM pinned to Hedera's target
specs/        scheme spec, prompts and planning artifacts, written during the build
AI-USAGE.md   where and how AI tooling was used, and what was done by hand
.claude/      Claude Code skills used during development (see AI-USAGE.md)
.github/      CI - builds, lints, type-checks and tests every pull request and main
```

## AI usage

This project was built with Claude Code. See [AI-USAGE.md](AI-USAGE.md) — required
disclosure under ETHGlobal's AI policy.

## Licence

[MIT](LICENSE).
