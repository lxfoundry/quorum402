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

## Deployed services

| Service | What it serves | Endpoint |
|---|---|---|
| Subgraph | Pool state, indexed off Hedera testnet | <https://quorum402-subgraph.fly.dev/subgraphs/name/quorum402> |

Live, and answerable without a wallet or a clone:

```bash
curl -s https://quorum402-subgraph.fly.dev/subgraphs/name/quorum402   -H 'content-type: application/json'   -d '{"query":"{ _meta { block { number } hasIndexingErrors } pools { id state seats threshold releasedTinybars deposits { hederaTxId tinybars counted refunded } } }"}'
```

The `hederaTxId` in that response is the x402 settlement the deposit was recorded against.
Paste it into [HashScan](https://hashscan.io/testnet) and the payment is there — the index
and the ledger are the same events, read twice.

The graph-node behind it is **self-hosted, because there is no alternative**: Hedera is not on
[The Graph's supported networks](https://thegraph.com/docs/en/supported-networks/), and
Hedera's own hosted service is unavailable. [subgraph/README.md](subgraph/README.md) has the
detail, and [subgraph/fly/](subgraph/fly/) is the deployment.

## Partner integrations

Each row points at the **exact files and lines** implementing the integration, so it can be
verified without reading the whole tree.

| Partner | What we use it for | Where in this repo |
|---|---|---|
| **Hedera** | Settlement. A pool's funds are held by the contract's own Hedera account, credited by a native `CryptoTransfer` that runs no code and cannot be refused, and paid out in tinybars | [`QuorumPools.sol:226`](contracts/QuorumPools.sol#L226) records a settled payment · [`:300`](contracts/QuorumPools.sol#L300) releases · [`:336`](contracts/QuorumPools.sol#L336) refunds · [`:553`](contracts/QuorumPools.sol#L553) is the one place value moves · [`src/x402/hedera-exact.ts`](src/x402/hedera-exact.ts) builds the payment, [`facilitator.ts`](src/x402/facilitator.ts) settles it |
| **The Graph** | Pool state. Who paid into which pool, whether it reached quorum in time, and where the money went — none of which the contract keeps, all of which it emits | [`subgraph/src/mappings.ts`](subgraph/src/mappings.ts) rebuilds state from events · [`subgraph/schema.graphql`](subgraph/schema.graphql) is what that state looks like · [`subgraph/subgraph.template.yaml`](subgraph/subgraph.template.yaml) binds it to the contract |

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
src/          the x402 wire types, the Hedera `exact` payment path, the deployment record
scripts/      deployment, and checks against Hedera testnet that anyone can re-run
deployments/  what is deployed where, and the hash that proves it is this code
subgraph/     the subgraph, and the graph-node that has to run it - see subgraph/README.md
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
