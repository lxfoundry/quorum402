# The quorum402 subgraph

Pool state, read back out of the log: who has paid into which HTTP 402 pool, whether it
reached its threshold before the deadline, and where the money went.

Indexes [`QuorumPools`](../contracts/QuorumPools.sol) at
[`0.0.10409980`](https://hashscan.io/testnet/contract/0.0.10409980) on Hedera testnet, from the
block it was deployed in.

## Why there is a docker-compose here

The Graph's decentralized network does not serve Hedera. It is absent from
[the supported networks list](https://thegraph.com/docs/en/supported-networks/), which means no
Subgraph Studio, no Substreams, no hosted anything — and Hedera says the same from its side:

> Although Hedera supports subgraphs, its hosted service is currently unavailable, so we'll
> need to set up and run a local graph node to deploy our subgraph.
>
> — [Hedera docs, *The Graph*](https://docs.hedera.com/evm/tools/other/the-graph)

So indexing this contract means running the indexer. [`docker-compose.yml`](docker-compose.yml)
is that indexer: stock `graphprotocol/graph-node:v0.35.1`, no fork and no patch, pointed at
Hedera's public JSON-RPC relay. What makes it work is the environment, and every value in it
is either load-bearing or a defence against something the relay does not do. They are
annotated in the file.

## What the mappings actually do

The contract stores only what it must **enforce** — a seat flag per payer, a deposit row, a
state — and emits everything else. That is not a gap this subgraph patches over; it is the
division of labour the contract was designed around, and the reason
[`specs/pool-contract.md`](../specs/pool-contract.md) says *"History lives in the events and
the subgraph."*

So [`src/mappings.ts`](src/mappings.ts) reconstructs, from events alone:

- **the participant list** — `Participation`, one row per distinct payer per pool. The contract
  keeps a `mapping(address => bool)` it can only answer one address at a time; a completed
  pool's roster is not readable from state at all
- **counted versus late payments** in one id space, because `Refunded` names a deposit id
  without saying which kind it was — so `counted` is recorded when the deposit is, not guessed
  at refund time
- **the Hedera transaction id** each payment settled under, which the contract hashes for its
  double-spend guard and never stores. This index is the only place it survives
- **running totals** per pool, per account and protocol-wide, including the tinybars stranded
  in `credit` by a rejected push transfer

Event handlers only, and not by preference: the Hedera relay implements neither `trace_filter`
nor `trace_block`, so graph-node call handlers cannot run against it.

## Run it

```bash
npm install
npm run up                       # graph-node, IPFS and postgres

# from the repo root, once - writes subgraph.yaml and abis/ from the deployment record
cd .. && npm run build && npm run subgraph:config && cd subgraph

npm run codegen
npm run create-local
npm run deploy-local
```

Then:

- **queries** — <http://localhost:8000/subgraphs/name/quorum402>
- **indexing status** — <http://localhost:8030/graphql>
- `npm run logs` to watch it, `npm run reset` to throw the database away and start over

Backfill is ~28,000 blocks and takes well under a minute, because `startBlock` is the
deployment block. Without it the subgraph would start at block 0 of a chain past 40,000,000,
and the relay serves logs 1,000 blocks at a time — that is not slow, it is arithmetically out
of reach.

A first query, once it has synced:

```graphql
{
  pools {
    id
    state
    threshold
    seats
    resourceUrl
    committedTinybars
    releasedTinybars
    participants { payer { id } seatTaken tinybarsPaid tinybarsRefunded }
    deposits { hederaTxId tinybars counted lateReason refunded }
  }
}
```

## Where it runs

A subgraph nobody can reach is a subgraph nobody can check, so the same graph-node runs on
Fly.io and answers publicly:

**<https://quorum402-subgraph.fly.dev/subgraphs/name/quorum402>**

Three apps, in [`fly/`](fly/), mirroring the three services in the compose file:

| App | What it is | Reachable from |
|---|---|---|
| `quorum402-subgraph` | graph-node — [`fly/graph-node.toml`](fly/graph-node.toml) | the internet, port 8000 only |
| `quorum402-ipfs` | kubo — [`fly/ipfs.toml`](fly/ipfs.toml) | the private network only |
| `quorum402-db` | Postgres | the private network only |

Redeploy the subgraph with:

```bash
./fly/deploy-subgraph.sh v0.0.5
```

Three things about that setup are worth knowing before you change any of it.

**The admin port is never published.** Port 8020 creates and deletes subgraphs and has no
authentication at all. Only 8000 is public.

**Postgres needs the C collation and more than 256MB.** graph-node's migrations die partway
through on a 256MB machine — the symptom is `server closed the connection unexpectedly` in the
middle of the migration list, which reads like a network fault and is not one. The database
also has to be created `LC_COLLATE 'C' LC_CTYPE 'C'` from `template0`, because Fly's default
is `en_US.utf8`:

```sql
CREATE DATABASE graph_node TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
```

**graph-node binds IPv4 and Fly's private network is IPv6.** Fly's public proxy bridges that,
which is why queries work. Nothing else does — `fly proxy` to port 8020 connects to the
machine and finds nothing listening — which is why the deploy is split in two and why
[`fly/admin-rpc.sh`](fly/admin-rpc.sh) exists. kubo is configured the other way, to listen on
IPv6, or graph-node could not reach it at all.

## If HTTPS fails from inside the container

Symptom, against a URL that works fine from your own shell:

```
certificate verify failed ... unable to get local issuer certificate
```

That is a TLS-inspecting antivirus or corporate proxy on your machine. It re-signs every
certificate with a private root the host trusts and the container has never heard of. It has
nothing to do with Hedera and does not happen on a server.
[`docker-compose.override.example.yml`](docker-compose.override.example.yml) has the fix.
