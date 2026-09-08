# quorum402

[![CI](https://github.com/lxfoundry/quorum402/actions/workflows/ci.yml/badge.svg)](https://github.com/lxfoundry/quorum402/actions/workflows/ci.yml)

**An HTTP 402 challenge that a crowd can answer together.**

Funds are held, and the resource unlocks only if enough separate buyers pay before the
deadline. If the threshold is not reached, everyone is refunded.

Built from scratch for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026)
(Classic / "From Scratch" track).

> 🚧 **Status: in active development.** Everything below marked `TODO` is a placeholder to be
> filled as the work lands — nothing marked that way is claimed as working.

---

## The gap this fills

[x402](https://x402.org) turns HTTP `402 Payment Required` into a real payment handshake.
Its schemes today all describe **one payer settling one request**:

| Scheme | Semantics |
|---|---|
| `exact` | Buyer authorises the advertised amount |
| `upto` | Buyer authorises a ceiling; seller settles actual usage |
| `batch-settlement` | One buyer's repeated micropayments accumulate against a reusable channel |
| `auth-capture` | Buyer's funds are held, then captured or released at the seller's discretion |

None of them expresses **"I will pay if enough others do."** That is a different shape: many
distinct payers, one resource, an all-or-nothing outcome, and a refund path when the crowd does
not show up. `auth-capture` comes closest and still cannot — its release is the seller's choice,
not a fact about who else turned up. [The scheme spec §1](specs/quorum-scheme.md) makes that
comparison precisely.

`quorum402` proposes that missing shape as a scheme named **`quorum`**. What is built of it is
stated per hold binding in [§10](specs/quorum-scheme.md).

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
- [ADR 0005 — What `quorum` declares on the wire](specs/adr/0005-what-quorum-declares-on-the-wire.md)
  — why the coordination is a scheme rather than a field, why it proposes a payment flow as well,
  and why a plain `exact` entry sits alongside it

The contract those decisions describe is specified in
[specs/pool-contract.md](specs/pool-contract.md), written before the code, and implemented in
[contracts/QuorumPools.sol](contracts/QuorumPools.sol).

The scheme itself is specified in [specs/quorum-scheme.md](specs/quorum-scheme.md): what x402 did
not express as of 2026-09-08 (§1), the `conditional` payment flow it proposes, the wire format,
the HTTP lifecycle, how entitlement is proven from chain state, and the three hold bindings — of
which one is built.

---

## Deployed contracts

| Contract | Network | Address | Explorer |
|---|---|---|---|
| [QuorumPools](contracts/QuorumPools.sol) | Hedera Testnet | `0.0.10409980` · `0x00000000000000000000000000000000009ed7fc` | [HashScan](https://hashscan.io/testnet/contract/0.0.10409980) |

The Hedera id is the one that matters: it is what a pool puts in the x402
`PaymentRequirements.payTo`, so a buyer's payment lands **in the contract** rather than in
anyone's custody.

The contract has **no external admin key** — it is its own administrator, which is what
Hedera records for a contract created without one, and it cannot be updated or deleted by
anybody. You do not have to take that on trust, or the address either:

```bash
npm run build && npm run check:deployment
```

reads the runtime bytecode back from the mirror node, hashes it against what this tree
compiles to, and checks who can change it. The deployment record it checks against is
[deployments/hedera-testnet.json](deployments/hedera-testnet.json).

And the contract does what this page says it does — also checkable, against the real network:

```bash
npm run check:payout
```

opens a pool for one buyer, settles a real x402 payment into the contract, records it,
crosses the threshold, releases, and confirms on the mirror node that the recipient was
credited to the tinybar. It needs a funded testnet operator and the buyer accounts
`npm run accounts:create` makes.

## Partner integrations

Each row points at the **exact contract and lines** implementing the integration, so it can
be verified without reading the whole tree.

| Partner | What we use it for | Where in this repo |
|---|---|---|
| TODO | TODO | TODO |

---

## Running it

TODO — prerequisites, install, configure, deploy to testnet, run the demo. Verified from a clean
clone, not from a developer's machine.

```bash
# TODO
```

## Demo

TODO — video link.

---

## Repository layout

```
contracts/    the pool contract that holds a pool's funds, and its test support
src/          the x402 wire types, the Hedera `exact` payment path, the deployment record
scripts/      deployment, and checks against Hedera testnet that anyone can re-run
deployments/  what is deployed where, and the hash that proves it is this code
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
