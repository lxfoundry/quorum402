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
As of 2026-09-08 its schemes all describe **one payer settling one request**:

| Scheme | Semantics |
|---|---|
| `exact` | Buyer authorises the advertised amount |
| `upto` | Buyer authorises a ceiling; seller settles actual usage |
| `batch-settlement` | One buyer's repeated micropayments accumulate against a reusable channel |
| `auth-capture` | Buyer's funds are held, then captured or released at the seller's discretion |

None of them expresses **"I will pay if enough others do."** That is a different shape: many
distinct payers, one resource, an all-or-nothing outcome, and a refund path when the crowd does
not show up. `auth-capture` comes closest and still cannot — its release is the seller's choice,
not a fact about who else turned up. [The scheme spec §1](specs/quorum-scheme.md#1-what-x402-does-not-express-as-of-2026-09-08) makes that
comparison precisely.

`quorum402` proposes that missing shape as a scheme named **`quorum`**. What is built of it is
stated per hold binding in [§10](specs/quorum-scheme.md#10-hold-bindings).

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
- [ADR 0006 — Nothing settles until recording can succeed](specs/adr/0006-nothing-settles-until-recording-can-succeed.md)
  — what the server checks before it calls the irreversible step, why the solvency guard makes
  that affordable, and where a failed attribution gets written down

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
| **The Graph** | Pool state, and **one fact the chain cannot answer**. The transaction id a payment settled under is emitted and never stored, so redeeming a seat has to resolve it through the log — the index sits in the request path, not beside it | [`subgraph/src/mappings.ts`](subgraph/src/mappings.ts) rebuilds state from events · [`subgraph/schema.graphql`](subgraph/schema.graphql) is what that state looks like · [`src/graph/client.ts`](src/graph/client.ts) is what the coordinator asks · [`src/server/redeem.ts:176`](src/server/redeem.ts#L176) is where a redemption depends on the answer |

---

## Running it

TODO — prerequisites, install, configure, deploy to testnet, run the demo. Verified from a clean
clone, not from a developer's machine.

```bash
# TODO
```

## Verifying it end to end

`npm test` proves the parts: the contract's arithmetic on an in-process EVM, and the scheme's
status table over a real listener with the chain, the facilitator and the index all stubbed.
Nothing in it touches a network, and nothing in it makes several distinct buyers fill one pool.

`npm run e2e` does. It runs two scenarios against Hedera testnet, settled through Blocky402 and
read back through the live subgraph — the crowd that arrives, and the crowd that does not. Both
run by default, because a run that only ever proves the *all* half of an all-or-nothing
primitive has demonstrated the easy direction.

```bash
npm run e2e -- --check              # preflight only: config, reachability, balances. Spends nothing
npm run e2e                         # both scenarios, about three and a half minutes
npm run e2e -- --scenario met       # just the crowd that arrived, about 40 seconds
npm run e2e -- --scenario missed    # just the refund path
```

It needs `.env` filled in (including `SUBGRAPH_URL`) and a `.accounts.json` holding at least
four accounts — `npm run accounts:create -- 4`. The preflight checks every balance first and,
if one is short, prints the account id to paste into
[the faucet](https://portal.hedera.com/faucet) rather than failing partway through a run.

Both scenarios together cost about 0.3 HBAR at the default 0.1 HBAR seat, plus gas: the met run
pays three seats to the seller and keeps none of it back, and the missed run's two seats are
refunded in full. Use `--seat` to change the price; it is a property of the pool, written
on-chain at creation, so it changes what a run costs and nothing about what it proves.

### The crowd arrives

Three separate accounts buy seats through the coordinator, one redeems, and the seller is paid.

| | |
|---|---|
| **402 → 202 → 200** | the first two buyers settle and are told the resource is still pending; the third fills the pool and receives it |
| the licence | the resource served names this run's pool, not a previous one |
| the money in | the contract's balance rose by exactly three seats |
| the index | the subgraph placed the settlement, which is the only place a transaction id survives |
| redemption | a payer turns a settlement id and a private key back into the resource |
| **the impostor** | a second buyer presenting the first's settlement is refused **403** — a seat belongs to the payer, not to whoever holds the receipt |
| the money out | the recipient received exactly three seats, and the contract's commitments fell by the same |

### The crowd falls one seat short

Two of the three buyers pay, the deadline passes, and everybody gets their money back. One seat
short rather than empty, because all-or-nothing has to mean all-or-nothing and *close enough* is
where it would be tempting not to.

[§9](specs/quorum-scheme.md#9-reversal) puts reversal deliberately outside HTTP, and both of the
paths it names run here — they protect different people. A payer who can afford the gas pulls
their own money back and needs nobody. A payer who cannot has it pushed to them by a bystander
who gains nothing by doing it. Neither goes near the coordinator, which is the point: the party
whose failure a payer most needs protection from is the one that failed to sell them the thing.

| | |
|---|---|
| **402 → 202, twice** | both buyers settle for real and are told the resource is still pending |
| one seat short | the pool reads back **two of three seats taken** — two payments that took no seat would leave it just as `Open`, and the whole scenario rests on the difference |
| lazy expiry | past its deadline the pool reads `Expired` with nothing having stamped it — the clock decides, not a keeper |
| **the latecomer** | the third buyer is refused **404** before it builds a payment: the coordinator stops selling half a minute before it stops being able to deliver, so the money is never taken |
| **the expired seat** | the payer redeeming is refused **409 `pool-expired`** — and told the contract and method to reclaim at, which is the whole of what a coordinator owes a pool it could not fill |
| the pull | `claimRefund`, signed with the payer's own key, returns exactly one seat |
| the push | `refundAll` from a bystander returns the rest, and skips the deposit already claimed |
| **whole** | the pushed payer holds *exactly* what it held before it paid — refunded, having paid nothing for the privilege. The payer that claimed is down only its own gas |
| the contract | commitments fell by both seats, and its balance is back where it started — it kept none of it |

Each scenario opens its own pool on its own ephemeral port, so the resource URL it sells is one
no earlier pool can name. Two rows depend on that and would otherwise be quietly wrong: the
licence proves the resource served belongs to *this* pool, and the latecomer's 404 means "no
pool is selling this" rather than "some older pool answered instead". The rest of the isolation
is a design property rather than a measured one: concurrent runs should not interfere, and a run
that dies should leave behind only a pool that expires into refundable. Neither has been tested.

## Demo

TODO — video link.

---

## Repository layout

```
contracts/    the pool contract that holds a pool's funds, and its test support
src/
  x402/       the wire types, the Hedera `exact` payment path, the facilitator client
  pool/       the contract client, and the deployment record
  hedera/     the mirror node: an account's network address, and its balance
  server/     the coordinator - what a 402 offers, what it checks before settling, what it records
  graph/      the subgraph client: which deposit a settlement became
  buyer/      a buyer that answers a quorum 402 with no human in the loop
  benchmark/  the resource being sold, and why one buyer cannot buy it alone
scripts/      deployment, the demo, and checks against Hedera testnet that anyone can re-run
  e2e/        the end-to-end runs: a crowd fills one pool and the seller is paid, and a crowd
              that falls one seat short is refunded to the tinybar
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
