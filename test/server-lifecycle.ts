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
import { resourceUrlFor } from "../src/benchmark/catalogue.js";
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
import type { PoolState, PoolTerms } from "../src/pool/client.js";

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
}

function deps(stubs: Stubs = {}): ServerDeps & { logged: string[] } {
  const pool = stubs.pool ?? terms();
  const readBack = stubs.after ?? pool;
  const logged: string[] = [];
  const reader: PoolReader = {
    poolCount: async () => 1n,
    poolOf: async () => pool,
    statusOf: async () => stubs.state ?? "Open",
  };
  return {
    logged,
    registry: new PoolRegistry(reader),
    pools: {
      poolOf: async () => readBack,
      statusOf: async () => stubs.stateAfter ?? stubs.state ?? "Open",
      committedTinybars: async () => stubs.committed ?? 0n,
      balanceTinybars: async () => stubs.balance ?? 0n,
      revertReasonOf: async () => undefined,
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
    evmAddressOf: async () => BUYER_EVM,
    coordinatorBalanceTinybars: async () => stubs.coordinatorBalance ?? 10_000_000_000n,
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

  it("501s a redemption rather than answering as though it were a fresh payment", async () => {
    const res = await request(deps(), `/benchmark/${SLUG}`, {
      [QUORUM_RECEIPT_HEADER]: encodeHeaderValue({ poolId: "7" }),
    });

    assert.equal(res.status, 501);
  });

  it("lists what is for sale", async () => {
    const res = await request(deps(), "/");
    const benchmarks = res.body.benchmarks as { url: string }[];

    assert.equal(res.status, 200);
    assert.ok(benchmarks.some((b) => b.url === RESOURCE));
  });
});
