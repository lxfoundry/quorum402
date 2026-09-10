/**
 * The subgraph client, against the answers a GraphQL server actually returns.
 *
 * Everything else in the suite stubs `depositFor` and tests what the server does with its
 * result. Nothing exercised the client itself, so the shape of the response it parses - the one
 * thing a subgraph is free to vary - was only ever checked against testnet, on the path where
 * nothing goes wrong.
 *
 * The case that matters is partial success. GraphQL resolves each field independently and
 * answers 200 with the ones that worked, so `errors` being non-empty does not mean the query
 * failed; it means some field did. `depositFor` asks two questions in one round trip and only
 * one of them decides anything.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GraphClient } from "../src/graph/client.js";

const URL = "https://example.invalid/subgraph";
const TX = "0.0.1001@1788945000.000000000";

const realFetch = globalThis.fetch;

/** The client under test. It holds nothing but the URL, so one serves every case. */
const client = new GraphClient({ url: URL });

interface Asked {
  calls: number;
  /** The variables of the most recent request, for the cases that pin what was sent. */
  variables?: Record<string, unknown>;
}

/** Answers every request with one canned GraphQL body, and records what was asked. */
function answering(body: unknown): Asked {
  const state: Asked = { calls: 0 };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    state.calls += 1;
    const sent = JSON.parse(init?.body ?? "{}") as { variables?: Record<string, unknown> };
    state.variables = sent.variables;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return state;
}

describe("resolving a settlement to a deposit", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports the position and how far the index has read", async () => {
    answering({ data: { deposits: [{ depositId: "2" }], _meta: { block: { number: 4242 } } } });

    const found = await client.depositFor("7", TX);

    assert.equal(found.depositId, 2n);
    assert.equal(found.indexedBlock, 4242n);
  });

  it("reports no row, with the lag that explains it", async () => {
    answering({ data: { deposits: [], _meta: { block: { number: 4242 } } } });

    const found = await client.depositFor("7", TX);

    assert.equal(found.depositId, undefined);
    assert.equal(found.indexedBlock, 4242n);
  });

  it("still resolves the seat when the index cannot report its own head", async () => {
    // The regression this test exists for: `_meta` was folded into the deposit query, and any
    // `errors` entry aborted the lookup - so an index that knew exactly where the deposit was
    // answered 503 to a payer holding a good seat, on a field that only annotates a refusal.
    answering({
      data: { deposits: [{ depositId: "2" }], _meta: null },
      errors: [{ message: "Failed to get block number" }],
    });

    const found = await client.depositFor("7", TX);

    assert.equal(found.depositId, 2n);
    assert.equal(found.indexedBlock, undefined);
  });

  it("reports no row when only the lag came back", async () => {
    answering({ data: { deposits: [], _meta: null }, errors: [{ message: "no block" }] });

    const found = await client.depositFor("7", TX);

    assert.equal(found.depositId, undefined);
    assert.equal(found.indexedBlock, undefined);
  });

  it("refuses to answer when the deposit question itself failed", async () => {
    // The half that is not advisory. An absent `deposits` is not "no such deposit" - the index
    // did not answer - and returning `{}` here would turn a broken index into a 404 telling a
    // payer their settlement never happened.
    answering({
      data: { deposits: null, _meta: { block: { number: 4242 } } },
      errors: [{ message: "store error: canceling statement due to statement timeout" }],
    });

    await assert.rejects(
      client.depositFor("7", TX),
      /statement timeout/,
      "the upstream reason should survive, so a 503 is diagnosable",
    );
  });

  it("refuses a response carrying no data at all", async () => {
    answering({ errors: [{ message: "connection refused" }] });

    await assert.rejects(client.depositFor("7", TX), /connection refused/);
  });

  it("refuses to guess when the index contradicts the replay guard", async () => {
    // Two rows for one transaction id cannot happen against a sound index: the contract's guard
    // is global. Taking the first would resolve a disagreement with consensus by picking a side.
    answering({ data: { deposits: [{ depositId: "2" }, { depositId: "5" }], _meta: null } });

    await assert.rejects(client.depositFor("7", TX), /2 deposits/);
  });

  it("asks once, because the lag rides on the deposit query", async () => {
    const state = answering({ data: { deposits: [], _meta: { block: { number: 4242 } } } });

    await client.depositFor("7", TX);

    assert.equal(state.calls, 1);
  });
});

/**
 * A buyer's own deposits - what the demo UI shows in "my seats".
 *
 * Not a §8 path: entitlement is still decided by the coordinator reading the contract. What these
 * pin is the decoding, because every number arrives as a string and a pool state arrives as text
 * that decides which button a payer is shown.
 */
describe("a buyer's deposits", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const DEPOSIT = {
    depositId: "1",
    hederaTxId: TX,
    tinybars: "10000000",
    counted: true,
    refunded: false,
    seatsAfter: 2,
    pool: {
      poolId: "7",
      state: "Open",
      seats: 2,
      threshold: 3,
      deadline: "1788945600",
      unitTinybars: "10000000",
      resourceUrl: "http://localhost:4021/benchmark/agent-spend-eu",
    },
  };

  it("decodes the deposit and the pool it landed in", async () => {
    answering({ data: { deposits: [DEPOSIT], _meta: { block: { number: 4242 } } } });

    const { deposits, indexedBlock } = await client.depositsFor("0xAb01");

    assert.equal(indexedBlock, 4242n);
    assert.equal(deposits.length, 1);
    const [deposit] = deposits;
    assert.equal(deposit?.depositId, 1n);
    assert.equal(deposit?.transaction, TX);
    assert.equal(deposit?.tinybars, 10_000_000n);
    assert.equal(deposit?.counted, true);
    assert.equal(deposit?.refunded, false);
    // The seat number, for a counted deposit. Read against `counted`, never alone.
    assert.equal(deposit?.seatsAfter, 2);
    assert.equal(deposit?.pool.poolId, "7");
    assert.equal(deposit?.pool.state, "Open");
    assert.equal(deposit?.pool.threshold, 3);
    assert.equal(deposit?.pool.deadline, 1_788_945_600);
    assert.equal(deposit?.pool.unitTinybars, 10_000_000n);
  });

  it("asks in the case the index stores addresses in", async () => {
    // A checksummed address matches nothing rather than failing, so the buyer would be shown an
    // empty seat list and no error - the same trap `settlementFor` lowercases against.
    const state = answering({ data: { deposits: [], _meta: null } });

    await client.depositsFor("0xAbCdEf0123456789");

    assert.equal(state.variables?.payer, "0xabcdef0123456789");
  });

  it("includes a payment that took no seat, because that is the refundable one", async () => {
    const late = { ...DEPOSIT, depositId: "2", counted: false, seatsAfter: 3 };
    answering({ data: { deposits: [late], _meta: null } });

    const { deposits } = await client.depositsFor("0xab");

    assert.equal(deposits.length, 1);
    assert.equal(deposits[0]?.counted, false);
  });

  it("refuses a pool state it does not know rather than defaulting to one", async () => {
    // Guessing here picks which button a payer is shown - Redeem or Claim refund - so a state
    // this client cannot read has to stop the render, not produce a plausible one.
    answering({
      data: { deposits: [{ ...DEPOSIT, pool: { ...DEPOSIT.pool, state: "Settled" } }], _meta: null },
    });

    await assert.rejects(
      client.depositsFor("0xab"),
      /unknown pool state "Settled"/,
    );
  });
});
