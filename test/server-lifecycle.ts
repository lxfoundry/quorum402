/**
 * `quorum-scheme.md` §6's status table, driven end to end over a real listening server.
 *
 * The table is the scheme's externally visible contract, and one row of it - **202** - exists
 * nowhere else in x402. Everything is stubbed below the HTTP layer: no chain, no facilitator,
 * no money. What is being tested is that the right answer comes out for each situation, and in
 * particular that nothing after settlement can produce a refusal.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { createApp } from "../src/server/index.js";
import type { ServerDeps } from "../src/server/index.js";
import { FailureReporter } from "../src/server/failures.js";
import { PoolRegistry } from "../src/server/pools.js";
import type { PoolReader } from "../src/server/pools.js";
import { quorumRequirements } from "../src/server/requirements.js";
import { benchmarkFor, resourceUrlFor } from "../src/benchmark/catalogue.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  QUORUM_RECEIPT_HEADER,
  decodeHeaderValue,
  encodeHeaderValue,
} from "../src/x402/http.js";
import { buildPartiallySignedTransfer } from "../src/x402/hedera-exact.js";
import type { PaymentRequired, QuorumPaymentPayload, SettlementResponse } from "../src/x402/types.js";
import { encodeRedemptionReceipt, signRedemptionReceipt } from "../src/x402/redemption.js";
import type { Deposit, PoolState, PoolTerms } from "../src/pool/client.js";

const BASE = "https://quorum402.example";
const SLUG = "agent-spend-eu";
const RESOURCE = resourceUrlFor(BASE, SLUG);
const CONTRACT = "0.0.10409980";
const FEE_PAYER = "0.0.7162784";
const BUYER = "0.0.1001";
const BUYER_EVM = "0x00000000000000000000000000000000000003e9";
const COORDINATOR = "0x0000000000000000000000000000000000000002";
const UNIT = 100_000_000n;

const client = Client.forTestnet();
after(() => client.close());

/** The buyer's key, used both to sign receipts and as what the ledger reports for them. */
const buyerKey = PrivateKey.generateECDSA();
const countedDeposit: Deposit = {
  payer: BUYER_EVM,
  tinybars: UNIT,
  counted: true,
  refunded: false,
};

function terms(over: Partial<PoolTerms> = {}): PoolTerms {
  return {
    poolId: 7n,
    recipient: "0x0000000000000000000000000000000000000001",
    coordinator: COORDINATOR,
    unitTinybars: UNIT,
    threshold: 3,
    seats: 1,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    state: "Open",
    resourceUrl: RESOURCE,
    ...over,
  };
}

interface Stubs {
  pool?: PoolTerms;
  /** The pool as read back *after* recording, when that differs. */
  after?: PoolTerms;
  /** What `statusOf` says *before* this payment. */
  state?: PoolState;
  /** What it says after. A pool reaches `Met` because of the payment being tested. */
  stateAfter?: PoolState;
  isValid?: boolean;
  settlement?: SettlementResponse;
  record?: ServerDeps["pools"]["recordDeposit"];
  committed?: bigint;
  balance?: bigint;
  coordinatorBalance?: bigint;
  /** The deposit the contract reports at the index the log gave. */
  deposit?: Deposit;
  /** Run as though the index has not reached the payment yet. */
  notIndexed?: boolean;
  /** Run with no index at all, as a deployment with `SUBGRAPH_URL` unset does. */
  noIndex?: boolean;
  /** An index that is wired but unreachable, as distinct from one that is behind. */
  indexThrows?: boolean;
  /** The contract read that answers for the row the index pointed at, failing. */
  depositAtThrows?: boolean;
  /** What the index says about a transaction having been attributed already. */
  alreadyRecorded?: boolean;
  /** The replay check itself failing, as distinct from answering `false`. */
  isRecordedThrows?: boolean;
  /** The ledger's answer about an account. Throws for a key that cannot sign. */
  accountOf?: ServerDeps["accountOf"];
}

function deps(stubs: Stubs = {}): ServerDeps & { logged: string[]; reads: string[] } {
  const pool = stubs.pool ?? terms();
  const readBack = stubs.after ?? pool;
  const logged: string[] = [];
  // The registry indexes pools by their position in the contract's append-only array, so the
  // stub has to put the pool under its own id rather than answering with it for every id.
  // Redemption looks a pool up *by the id in the receipt*, and a stub that ignores the id
  // would make that lookup untestable.
  const reads: string[] = [];
  const reader: PoolReader = {
    poolCount: async () => {
      reads.push("poolCount");
      return pool.poolId + 1n;
    },
    poolOf: async (poolId) => {
      reads.push("poolOf");
      return poolId === pool.poolId
        ? pool
        : terms({ poolId, resourceUrl: `${BASE}/benchmark/unrelated-${poolId}` });
    },
    statusOf: async () => {
      reads.push("statusOf");
      return stubs.state ?? "Open";
    },
  };
  return {
    logged,
    reads,
    registry: new PoolRegistry(reader),
    pools: {
      poolOf: async () => readBack,
      statusOf: async () => stubs.stateAfter ?? stubs.state ?? "Open",
      committedTinybars: async () => stubs.committed ?? 0n,
      balanceTinybars: async () => stubs.balance ?? 0n,
      revertReasonOf: async () => undefined,
      depositAt: async () => {
        if (stubs.depositAtThrows) throw new Error("execution reverted: NoSuchDeposit");
        return stubs.deposit ?? countedDeposit;
      },
      recordDeposit:
        stubs.record ??
        (async () => ({
          depositId: 1n,
          counted: true,
          transactionId: "0.0.1@1.0",
          gasUsed: 100n,
        })),
    },
    facilitator: {
      feePayerFor: async () => FEE_PAYER,
      verify: async () => ({ isValid: stubs.isValid ?? true, invalidReason: "declined" }),
      settle: async () => stubs.settlement ?? { success: true, transactionId: undefined },
    },
    failures: new FailureReporter({ write: (line) => logged.push(line) }),
    network: "hedera:testnet",
    payTo: CONTRACT,
    contractId: CONTRACT,
    publicBaseUrl: BASE,
    coordinatorAccountId: "0.0.10404217",
    coordinatorAddress: COORDINATOR,
    accountOf:
      stubs.accountOf ??
      (async () => ({
        evmAddress: BUYER_EVM,
        key: { type: "ECDSA_SECP256K1", hex: buyerKey.publicKey.toStringRaw() },
      })),
    coordinatorBalanceTinybars: async () => stubs.coordinatorBalance ?? 10_000_000_000n,
    index: stubs.noIndex
      ? undefined
      : {
          depositFor: async () => {
            if (stubs.indexThrows) {
              throw new Error("subgraph error: Store error: database unavailable at 10.0.0.4");
            }
            return stubs.notIndexed
              ? { indexedBlock: 4_242n }
              : { depositId: 0n, indexedBlock: 4_242n };
          },
          isRecorded: async () => {
            if (stubs.isRecordedThrows) throw new Error("subgraph returned 502");
            return stubs.alreadyRecorded ?? false;
          },
        },
    record: { sleep: async () => {}, attempts: 2 },
  };
}

/** Start the app on an ephemeral port, run one request, shut it down. */
async function request(
  d: ServerDeps,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const server = createApp(d).listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      headers: res.headers,
    };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** A receipt a buyer would actually present, signed with the key the ledger reports for them. */
function receipt(
  over: { poolId?: string; transaction?: string; validUntil?: number; resource?: string } = {},
): string {
  return encodeRedemptionReceipt(
    signRedemptionReceipt(buyerKey, {
      accountId: BUYER,
      poolId: over.poolId ?? "7",
      transaction: over.transaction ?? "0.0.7162784@1788894730.022621899",
      validUntil: over.validUntil ?? Math.floor(Date.now() / 1000) + 300,
      network: "hedera:testnet",
      contract: CONTRACT,
      resource: over.resource ?? RESOURCE,
    }),
  );
}

/** A payment a buyer would actually send, against the terms the server is advertising. */
async function payment(pool: PoolTerms = terms()): Promise<string> {
  const advertised = quorumRequirements({
    terms: pool,
    network: "hedera:testnet",
    payTo: CONTRACT,
    feePayer: FEE_PAYER,
  });
  const transaction = await buildPartiallySignedTransfer({
    client,
    payerId: BUYER,
    payerKey: PrivateKey.generateECDSA(),
    requirements: {
      scheme: "exact",
      network: "hedera:testnet",
      amount: pool.unitTinybars.toString(),
      asset: "0.0.0",
      payTo: CONTRACT,
      maxTimeoutSeconds: 120,
      extra: { feePayer: FEE_PAYER },
    },
  });
  const payload: QuorumPaymentPayload = {
    x402Version: 2,
    resource: { url: RESOURCE, description: "d", mimeType: "application/json" },
    accepted: advertised,
    payload: { poolId: pool.poolId.toString(), binding: { transaction } },
  };
  return encodeHeaderValue(payload);
}

describe("§6 lifecycle", () => {
  it("404s a URL no benchmark answers on", async () => {
    const res = await request(deps(), "/benchmark/not-a-benchmark");
    assert.equal(res.status, 404);
  });

  it("404s when no open pool is selling the resource", async () => {
    // Row 1. A pool that exists and is closed is not an open pool naming this URL, so without
    // a payment in hand the answer is the same as if none had ever existed.
    const res = await request(deps({ state: "Met" }), `/benchmark/${SLUG}`);
    assert.equal(res.status, 404);
  });

  it("402s an open pool, and offers both schemes in PAYMENT-REQUIRED", async () => {
    // Row 2. The header is the protocol surface; the body is a courtesy.
    const res = await request(deps(), `/benchmark/${SLUG}`);

    assert.equal(res.status, 402);
    const offered = decodeHeaderValue<PaymentRequired>(
      res.headers.get(PAYMENT_REQUIRED_HEADER) ?? undefined,
    );
    assert.equal(offered?.accepts.length, 2);
    assert.equal(offered?.accepts[0]?.scheme, "quorum");
    assert.equal(offered?.accepts[1]?.scheme, "exact");
    assert.equal(offered?.resource.url, RESOURCE);
    assert.match(offered?.error ?? "", /refunded/);
  });

  it("400s a payload that does not match the advertised terms", async () => {
    // Row 3.
    const res = await request(deps(), `/benchmark/${SLUG}`, {
      [PAYMENT_SIGNATURE_HEADER]: encodeHeaderValue({ x402Version: 2, nonsense: true }),
    });
    assert.equal(res.status, 400);
  });

  it("402s a payment for a pool that closed since the 402, without settling", async () => {
    // Row 4, and the reason §7 rule 2 exists: settling here would take the payer's money for a
    // seat that no longer exists. `closing` is the guard interval, so the pool is still Open.
    const closing = terms({ deadline: Math.floor(Date.now() / 1000) + 5 });
    let settled = false;
    const d = deps({ pool: closing });
    d.facilitator.settle = async () => {
      settled = true;
      return { success: true };
    };

    const res = await request(d, `/benchmark/${SLUG}`, {
      [PAYMENT_SIGNATURE_HEADER]: await payment(closing),
    });

    assert.equal(res.status, 402);
    assert.equal(res.body.reason, "closing");
    assert.equal(settled, false, "nothing irreversible ran");
  });

  it("402s when the pre-flight refuses, without settling", async () => {
    // The coordinator cannot pay to record what it is about to settle. ADR 0006.
    let settled = false;
    const d = deps({ coordinatorBalance: 1n });
    d.facilitator.settle = async () => {
      settled = true;
      return { success: true };
    };

    const res = await request(d, `/benchmark/${SLUG}`, { [PAYMENT_SIGNATURE_HEADER]: await payment() });

    assert.equal(res.status, 402);
    assert.equal(res.body.reason, "coordinator-underfunded");
    assert.equal(settled, false);
  });

  it("402s a payer whose key could never redeem the seat, without settling", async () => {
    // §11. A threshold key can sign a transfer and cannot sign a §8 redemption message, so the
    // seat this payment would buy could never be opened. Refusing costs the payer a round trip;
    // settling would cost them the money.
    let settled = false;
    const d = deps({ accountOf: async () => ({ evmAddress: BUYER_EVM }) });
    d.facilitator.settle = async () => {
      settled = true;
      return { success: true };
    };

    const res = await request(d, `/benchmark/${SLUG}`, { [PAYMENT_SIGNATURE_HEADER]: await payment() });

    assert.equal(res.status, 402);
    assert.match(String(res.body.error), /redeemable seat/);
    assert.equal(settled, false);
  });

  it("402s a settlement the index says was already attributed, without settling", async () => {
    // ADR 0006's replay check, which needs the log: the contract keeps its hash set private.
    let settled = false;
    const d = deps({ alreadyRecorded: true });
    d.facilitator.settle = async () => {
      settled = true;
      return { success: true };
    };

    const res = await request(d, `/benchmark/${SLUG}`, { [PAYMENT_SIGNATURE_HEADER]: await payment() });

    assert.equal(res.status, 402);
    assert.equal(res.body.reason, "duplicate-transaction");
    assert.equal(settled, false);
  });

  it("settles anyway when the replay check cannot be made", async () => {
    // The softest gate here, and the only one whose failure must not refuse: the index lags, so
    // it can never prove a payment is new. An outage that blocked good payments would trade a
    // guard the contract already enforces for the thing this scheme exists to do.
    let settled = false;
    const d = deps({ isRecordedThrows: true, after: terms({ seats: 2 }) });
    d.facilitator.settle = async () => {
      settled = true;
      return { success: true, transactionId: "0.0.1@2.0" };
    };

    const res = await request(d, `/benchmark/${SLUG}`, { [PAYMENT_SIGNATURE_HEADER]: await payment() });

    assert.equal(settled, true);
    assert.equal(res.status, 202);
  });

  it("402s with PAYMENT-RESPONSE when the facilitator declines", async () => {
    // Row 5. Nothing moved, so this is still a payment challenge.
    const res = await request(deps({ isValid: false }), `/benchmark/${SLUG}`, {
      [PAYMENT_SIGNATURE_HEADER]: await payment(),
    });

    assert.equal(res.status, 402);
    assert.ok(res.headers.get(PAYMENT_RESPONSE_HEADER));
  });

  it("202s a settled payment that did not fill the pool, with a receipt", async () => {
    // Row 6 - the row that only exists because of `conditional`. The payment is real, the
    // resource is not owed yet, and may never be.
    const res = await request(
      deps({ after: terms({ seats: 2 }) }),
      `/benchmark/${SLUG}`,
      { [PAYMENT_SIGNATURE_HEADER]: await payment() },
    );

    assert.equal(res.status, 202);
    assert.equal(res.body.attributed, true);
    assert.equal(res.body.counted, true);
    assert.equal(res.body.seat, 2);
    assert.equal(res.body.threshold, 3);
    assert.deepEqual(res.body.pool, { state: "Open", filled: 2 });
    // §9: both ways out are named, and neither needs this server to still be running.
    assert.deepEqual(
      (res.body.next as { action: string }[]).map((n) => n.action),
      ["redeem", "reclaim"],
    );
  });

  it("200s with the benchmark when this payment meets the threshold", async () => {
    // Row 7. Delivery is on the threshold and never on the seller having been paid.
    const res = await request(
      deps({ after: terms({ seats: 3, state: "Met" }), stateAfter: "Met" }),
      `/benchmark/${SLUG}`,
      { [PAYMENT_SIGNATURE_HEADER]: await payment() },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.contributors, 3);
    assert.equal(res.body.minimumContributors, 3);
    assert.equal(res.body.licensee, BUYER);
    assert.ok(res.headers.get(PAYMENT_RESPONSE_HEADER));
    assert.match(String(res.body.note), /no contribution channel/);
  });

  it("202s rather than failing when the money moved and the attribution did not", async () => {
    // §7 rule 6, which is the whole reason this row is not a 500: the payer's receipt is their
    // only evidence of a payment that really happened, and a 500 destroys it.
    const d = deps({
      record: async () => {
        throw new Error("INSUFFICIENT_PAYER_BALANCE");
      },
    });
    const res = await request(d, `/benchmark/${SLUG}`, { [PAYMENT_SIGNATURE_HEADER]: await payment() });

    assert.equal(res.status, 202);
    assert.equal(res.body.attributed, false);
    assert.equal(res.body.counted, null, "unknown, not false - it can still be replayed");
    assert.ok(res.body.transaction, "the payer keeps the transaction id");
    assert.equal(d.logged.length, 1, "and it is logged for the manual drain");
  });

  it("501s a redemption on a build with no index wired", async () => {
    // Honest rather than convenient: the transaction id is emitted and never stored, so with
    // no index there is nothing to resolve a receipt against. Answering 401 would tell a payer
    // holding a perfectly good proof that it is invalid.
    const res = await request(deps({ noIndex: true }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 501);
  });

  it("answers 500 rather than hanging when something under the route throws", async () => {
    // `handle` is async and the route cannot let it reject unheard: an unhandled rejection
    // leaves this fetch waiting on a socket nobody will ever write to, with the process on
    // its way down behind it. The facilitator is the first network call on the path, so it
    // is the likeliest thing to fail this way.
    const base = deps();
    const d: ServerDeps = {
      ...base,
      facilitator: {
        ...base.facilitator,
        feePayerFor: async () => {
          throw new Error("facilitator unreachable");
        },
      },
    };
    const res = await request(d, `/benchmark/${SLUG}`);

    assert.equal(res.status, 500);
    assert.match(String(res.body.detail), /facilitator unreachable/);
  });

  it("serves the resource to a seat holder once the pool is met", async () => {
    // §6's eighth row, and the payoff of the whole scheme: this buyer paid into a pool that
    // was still short, got a 202 and no resource, and comes back later holding nothing but a
    // signature over facts on chain.
    const met = terms({ seats: 3, state: "Met" });
    const res = await request(deps({ pool: met, state: "Met" }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 200);
    // The same document the paying path serves, licensed to the redeeming account and citing
    // the settlement it descends from. A seat is a seat however it is presented.
    // The benchmark's id, which is the slug plus the week it covers - a licence names the
    // edition that was bought, not the URL it was bought at.
    assert.equal(res.body.benchmark, benchmarkFor(SLUG)?.id);
    assert.equal(res.body.licensee, BUYER);
    assert.equal(res.body.settledUnder, "0.0.7162784@1788894730.022621899");
    assert.equal(res.body.contributors, 3);
  });

  it("still serves it after the pool has released", async () => {
    // Delivery is on the threshold, never on the seller having been paid. A payout is a
    // separate permissionless action and must not be able to close a buyer out.
    const released = terms({ seats: 3, state: "Released" });
    const res = await request(deps({ pool: released, state: "Released" }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 200);
  });

  it("answers 202 with the fill while the pool is still short", async () => {
    const res = await request(deps(), `/benchmark/${SLUG}`, { [QUORUM_RECEIPT_HEADER]: receipt() });

    assert.equal(res.status, 202);
    assert.equal((res.body.pool as { threshold: number }).threshold, 3);
  });

  it("sends a seatless payer to the refund rather than telling them to wait", async () => {
    const late: Deposit = { ...countedDeposit, counted: false };
    const res = await request(deps({ deposit: late }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 409);
    assert.equal((res.body.reclaim as { method: string }).method, "claimRefund(uint256)");
  });

  it("401s a receipt that is not a receipt", async () => {
    const res = await request(deps(), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: encodeHeaderValue({ poolId: "7" }),
    });

    assert.equal(res.status, 401);
  });

  it("401s a receipt for a pool that never sold this resource", async () => {
    const res = await request(deps(), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt({ poolId: "999" }),
    });

    assert.equal(res.status, 401);
  });

  it("refuses an out-of-date receipt without reading the chain at all", async () => {
    // §8 rule 1 is the only check that needs no network, and it is the cheapest request anyone
    // can send. Running it after the pool reads would charge three paid contract queries to
    // answer a receipt whose own clock already refuses it.
    const d = deps();
    const res = await request(d, `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt({ validUntil: Math.floor(Date.now() / 1000) - 600 }),
    });

    assert.equal(res.status, 401);
    assert.deepEqual(d.reads, []);
  });

  it("503s rather than 500s when the index cannot be reached", async () => {
    // A behind index and a down index are different answers. The first is 404 with the lag
    // reported; the second must not tell a seat holder their payment does not exist, and must
    // not fall through to the route's catch-all either.
    const res = await request(deps({ indexThrows: true }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.equal(res.body.error, "index-unavailable");
    // The upstream text stays in the log. It describes this server's plumbing, not the receipt.
    assert.doesNotMatch(JSON.stringify(res.body), /10\.0\.0\.4|Store error/);
  });

  it("503s when the contract cannot answer for the row the index found", async () => {
    const res = await request(deps({ depositAtThrows: true }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /NoSuchDeposit/);
  });

  it("404s a payment the index has not caught up with, and says how far it has got", async () => {
    // The ordinary case for a buyer redeeming seconds after the settlement that funded it.
    const res = await request(deps({ notIndexed: true }), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: receipt(),
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.indexedBlock, "4242");
    assert.match(String(res.body.detail), /not indexed yet/);
  });

  it("never answers a redemption with a 402", async () => {
    // The failure this whole path exists to prevent. A met pool has stopped selling, so a
    // receipt that fell through to the payment path would be answered "pay again" - to a
    // buyer who has already paid, for a pool that cannot take their money.
    const met = terms({ seats: 3, state: "Met" });
    for (const header of [receipt(), receipt({ poolId: "999" }), encodeHeaderValue({})]) {
      const res = await request(deps({ pool: met, state: "Met" }), `/benchmark/${SLUG}`, {
        [QUORUM_RECEIPT_HEADER]: header,
      });

      assert.notEqual(res.status, 402);
    }
  });

  it("lists what is for sale", async () => {
    const res = await request(deps(), "/");
    const benchmarks = res.body.benchmarks as { url: string }[];

    assert.equal(res.status, 200);
    assert.ok(benchmarks.some((b) => b.url === RESOURCE));
  });
});
