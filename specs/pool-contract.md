# The pool contract

The interface the reference implementation of `quorum` settles against, on Hedera, under the
`exact` binding.

**Written 2026-09-07, before the contract.** The decisions it implements are recorded in
[ADR 0001](adr/0001-what-quorum-binds-to.md) (why `exact`),
[ADR 0002](adr/0002-payment-attribution-on-hedera.md) (how a payment is attributed),
[ADR 0003](adr/0003-pool-authority-model.md) (who may do what) and
[ADR 0004](adr/0004-deposits-that-cannot-be-refused.md) (why nothing is rejected). This
document does not re-argue them; it says what the code must do.

---

## The shape, in one paragraph

One contract holds many pools. A pool is a threshold, a deadline, a unit price and a
recipient. Buyers pay the unit price over x402 to the contract's own Hedera account, and the
pool's coordinator records each settled payment. If enough **distinct** buyers pay before the
deadline, the funds go to the recipient. Otherwise every buyer gets their money back. Nobody
can do anything else with the funds, including the person who deployed the contract.

## Actors

| Actor | Calls the contract | Authority |
|---|---|---|
| **Offerer** | `createPool`; receives on release | None special — it is simply the named `recipient` |
| **Coordinator** (the resource server) | `recordDeposit` only | Per-pool. Cannot move funds, cannot change terms, cannot refund to itself |
| **Buyer** | **Nothing on the happy path.** `claimRefund` only if the pool fails | Itself only |
| **Facilitator** | Never | Off-contract: adds the fee-payer signature and submits the transfer |
| **Deployer** | — | **Does not exist as a role.** No owner, no pause, no upgrade |

The buyer touching nothing is not an accident of convenience — it is what
[ADR 0002](adr/0002-payment-attribution-on-hedera.md) forces, and it is the demo's point: a
buyer signs one x402 payment and does nothing else.

## Methods

```solidity
function createPool(
    address recipient,
    address coordinator,
    uint256 unitTinybars,
    uint32  threshold,
    uint64  deadline,
    string calldata resourceUrl
) external returns (uint256 poolId);

function recordDeposit(
    uint256 poolId,
    address payer,
    uint256 tinybars,
    string calldata hederaTxId
) external returns (uint256 depositId, bool counted);

function expire(uint256 poolId) external;
function release(uint256 poolId) external;
function claimRefund(uint256 poolId) external returns (uint256 tinybars);
function refundAll(uint256 poolId, uint256 maxDeposits) external returns (uint256 refunded);
function withdraw() external returns (uint256 tinybars);
```

| Method | Caller | Gate | Effect |
|---|---|---|---|
| `createPool` | anyone | `threshold > 0`, `unitTinybars > 0`, `deadline > block.timestamp`, non-zero addresses | Allocates `poolId`; terms are immutable thereafter |
| `recordDeposit` | **the pool's coordinator** | `msg.sender == pool.coordinator` | Attributes one settled payment. Never reverts for a buyer-side reason — [ADR 0004](adr/0004-deposits-that-cannot-be-refused.md) |
| `expire` | anyone | deadline passed; idempotent | Stamps `Expired`, emits the event. **Optional** — the refund paths do it themselves |
| `release` | anyone | pool is `Met` | Pays `recipient` the counted total, marks `Released` |
| `claimRefund` | **the payer** | has a refundable deposit | Expires the pool if due, then sweeps every refundable deposit the caller holds |
| `refundAll` | anyone | bounded by `maxDeposits` | Expires the pool if due, then pushes refunds for up to `maxDeposits` deposits |
| `withdraw` | anyone with credit | has credit | Escape hatch when a push transfer failed |

Views: `statusOf`, `poolOf`, `depositCount`, `depositAt`, `committedTinybars`,
`balanceTinybars`.

> `statusOf` reports the **effective** status: a pool whose deadline has passed reads as
> `Expired` even before anyone has stamped it. Stored state and effective status differ exactly
> in that window, and every method that acts on state resolves it first.

### Why `release` and `expire` are permissionless

Neither chooses anything. `release` can only pay the recipient the pool named at creation, and
only once the threshold is met; `expire` can only record a fact the clock already settled.
Gating them would add a party who can stall the outcome without adding a party who can change
it.

### Why `refundAll` is not a convenience

A buyer who spent their HBAR paying may not be able to afford the gas to claim it back.
`claimRefund` is the trust-minimal path and `refundAll` is the one that actually runs at a
failed deadline. It is bounded and resumable: call it repeatedly until `depositCount` is
exhausted.

## State

```
                       recordDeposit (seats == threshold)          release
    Open ────────────────────────────────────────────► Met ─────────────────► Released
      │
      │ deadline passed — stamped by expire(), claimRefund() or refundAll()
      ▼
   Expired  ──►  counted deposits become refundable
```

- `Met` is unreachable after the deadline: `recordDeposit` takes a seat only while
  `block.timestamp < deadline`
- `Expired` is unreachable after `Met`, for the same reason
- **Late deposits are refundable in every state**, including `Met` and `Released`

## Storage

```solidity
enum State { Open, Met, Expired, Released }

struct Pool {
    address recipient;
    address coordinator;
    uint256 unitTinybars;
    uint32  threshold;
    uint32  seats;          // counted deposits so far
    uint64  deadline;       // unix seconds
    State   state;
    string  resourceUrl;
}

struct Deposit {
    address payer;          // EVM address, so claimRefund has a msg.sender to match
    uint256 tinybars;
    bool    counted;        // false => late: no seat, refundable at once
    bool    refunded;
    string  hederaTxId;     // "0.0.x@seconds.nanos" — third-party verifiable on a mirror node
}
```

Plus, at contract level:

| | |
|---|---|
| `mapping(uint256 => Deposit[])` | deposits per pool — a list, because a payer may hold several late deposits |
| `mapping(uint256 => mapping(address => bool)) seatTaken` | one seat per payer |
| `mapping(bytes32 => bool) txIdSeen` | `keccak256(hederaTxId)`, **global**, so one payment cannot be recorded into two pools |
| `uint256 totalCommitted` | tinybars the contract owes to a payer or a recipient |
| `mapping(address => uint256) credit` | owed to someone whose push transfer failed |

`hederaTxId` is stored as a string rather than only hashed. It costs storage and it is the
whole verifiability argument: any reader can take it to a mirror node or HashScan and confirm
that this payer really transferred this amount to this contract.

## The solvency invariant

```
totalCommitted  <=  address(this).balance / TINYBAR_TO_WEIBAR
```

Checked before every attribution. `totalCommitted` rises in `recordDeposit` and falls **only
when HBAR actually leaves the contract** — a failed push moves the amount into `credit` and
leaves `totalCommitted` untouched, because the money is still owed.

| Method | `totalCommitted` |
|---|---|
| `recordDeposit` | `+ tinybars`, after checking the invariant still holds |
| `release` | `− seats × unitTinybars`, on a successful transfer |
| `claimRefund` / `refundAll` | `− deposit.tinybars` per successful transfer |
| `withdraw` | `− amount`, on a successful transfer |

Consequences worth stating in the README: a threshold cannot be crossed without real HBAR
having arrived, and no pool can be paid out of another pool's funds. The residual —
`balance − totalCommitted`, money that arrived and was never attributed — is unrecoverable by
anyone, which is [ADR 0003](adr/0003-pool-authority-model.md)'s deliberate cost of having no
owner.

## Events

Every state transition emits, so a subgraph reconstructs full pool state with no RPC reads.

```solidity
event PoolCreated(uint256 indexed poolId, address indexed coordinator, address indexed recipient,
                  uint256 unitTinybars, uint32 threshold, uint64 deadline, string resourceUrl);
event DepositRecorded(uint256 indexed poolId, address indexed payer, uint256 depositId,
                      uint256 tinybars, string hederaTxId, uint32 seatsAfter);
event LateDeposit(uint256 indexed poolId, address indexed payer, uint256 depositId,
                  uint256 tinybars, string hederaTxId, LateReason reason);
event ThresholdMet(uint256 indexed poolId, uint32 seats, uint64 at);
event PoolExpired(uint256 indexed poolId, uint64 at);
event Released(uint256 indexed poolId, address indexed recipient, uint256 tinybars);
event Refunded(uint256 indexed poolId, address indexed payer, uint256 depositId, uint256 tinybars);
event PayoutFailed(uint256 indexed poolId, address indexed to, uint256 tinybars);
event Withdrawn(address indexed to, uint256 tinybars);

enum LateReason { ThresholdMet, DeadlinePassed, SeatTaken, WrongAmount }
```

Two notes for the subgraph mappings:

- **`PoolExpired` usually arrives in the same transaction as the first `Refunded`**, ordered
  before it. A mapping that assumes expiry has a transaction of its own will mis-order state
- `LateDeposit` is the interesting entity, not a footnote. *A payment arrived and did not make
  it* is the event a pool page has to show, and `LateReason` says why

## The flow

```mermaid
sequenceDiagram
    actor O as Offerer
    actor B as Buyer (1..N)
    participant RS as Resource server<br/>(coordinator)
    participant F as Facilitator
    participant H as Hedera
    participant P as Pool contract
    participant G as Subgraph

    O->>P: createPool(recipient=O, coordinator=RS,<br/>unit, threshold=N, deadline)
    P-->>G: PoolCreated(poolId)

    loop each buyer, until threshold or deadline
        B->>RS: GET /resource/{poolId}
        RS-->>B: 402 + requirements{amount:unit,<br/>payTo: contract 0.0.x, extra.feePayer}
        B->>B: build TransferTransaction, sign — cannot submit
        B->>RS: retry with X-PAYMENT
        RS->>F: /verify, then /settle
        F->>H: add fee-payer signature, submit
        H-->>P: HBAR credited — no contract code runs
        F-->>RS: success + hederaTxId
        RS->>P: recordDeposit(poolId, payerEvm, unit, hederaTxId)
        Note over P: solvency, tx-id uniqueness,<br/>seat and deadline resolved here
        P-->>G: DepositRecorded — or LateDeposit
        RS-->>B: 200 + receipt; resource withheld until quorum
    end

    alt threshold reached before the deadline
        P-->>G: ThresholdMet
        RS->>P: release(poolId)
        P->>O: transfer seats x unit
        P-->>G: Released
        RS-->>B: resource unlocked, for all N
    else deadline passes first
        Note over P: no keeper, no cron —<br/>nothing needs to happen at the deadline
        opt anyone, any time
            RS->>P: expire(poolId)
            P-->>G: PoolExpired
        end
        B->>P: claimRefund(poolId)
        Note over P: expires the pool first if still Open
        P-->>G: PoolExpired (if not already stamped)
        P->>B: refund
        P-->>G: Refunded
        RS->>P: refundAll(poolId, max)
        P->>B: refund the rest
    end
```

`release`, `expire` and `refundAll` are drawn as the resource server's calls only because it is
the party watching. All three are permissionless.

## Hedera specifics the implementation must get right

| | |
|---|---|
| **Weibars are not tinybars** | Hedera's EVM denominates HBAR in weibars, at `1 tinybar = 1e10 weibar`, so `address(this).balance` and `call{value:}` are **not** in the units x402 quotes. Keep the entire ledger in tinybars — matching `PaymentRequirements.amount` — and convert at exactly two places: the solvency check and the payout. One named constant, `TINYBAR_TO_WEIBAR` |
| **Use `call`, not `transfer`** | The 2300-gas stipend is not a safe assumption here |
| **Never derive accounting from `balance`** | It includes unattributed funds. `balance` appears only as the ceiling in the invariant |
| **The recipient may be a long-zero address** | A Hedera account with an ED25519 key has no EVM alias; `0x00…0<num>` is its address and a valid value target |
| **`payTo` is the contract's Hedera id** | `0.0.x` form, as `PaymentRequirements.payTo` in [`src/x402/types.ts`](../src/x402/types.ts) expects |
| **No receiver signature** | Required by [ADR 0002](adr/0002-payment-attribution-on-hedera.md) — the transfer must land without the contract signing |
| **`receive() payable`** | Not needed for the x402 path, since a native transfer runs no code. Include it anyway so an EVM-side top-up is not silently rejected |

## What must be verified before the Solidity is written

Minutes each, and the first one can invalidate the design.

1. 🔴 **Will the facilitator accept a `payTo` that is a contract, not an account?** If Blocky402
   validates `payTo` as an account entity and rejects a contract id, then
   [ADR 0002](adr/0002-payment-attribution-on-hedera.md)'s Option A does not work and the
   attribution decision reopens. **Test this before anything else.**
2. Does a native `CryptoTransfer` credit a contract account on testnet, with no receiver
   signature and no code executed? Extend the preflight in [`scripts/check-env.ts`](../scripts/check-env.ts).
3. Confirm the weibar conversion empirically with one throwaway payout, before the refund
   arithmetic depends on it.
4. Does subgraph indexing reach Hedera testnet contracts, and through whose graph-node? The
   Graph integration rests on it.

## Scope, if the days run short

Per the scope table in [`CLAUDE.md`](../CLAUDE.md), cut in this order: `refundAll` and
`withdraw` first — they are convenience and an escape hatch. Then multi-pool. **The solvency
invariant and late-deposit handling are not cuttable**; they are the correctness story, and
without them the contract can lose a buyer's money.
