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

/** Answers every request with one canned GraphQL body, and records what was asked. */
function answering(body: unknown): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return state;
}

describe("resolving a settlement to a deposit", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports the position and how far the index has read", async () => {
    answering({ data: { deposits: [{ depositId: "2" }], _meta: { block: { number: 4242 } } } });

    const found = await new GraphClient({ url: URL }).depositFor("7", TX);

    assert.equal(found.depositId, 2n);
    assert.equal(found.indexedBlock, 4242n);
  });

  it("reports no row, with the lag that explains it", async () => {
    answering({ data: { deposits: [], _meta: { block: { number: 4242 } } } });

    const found = await new GraphClient({ url: URL }).depositFor("7", TX);

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

    const found = await new GraphClient({ url: URL }).depositFor("7", TX);

    assert.equal(found.depositId, 2n);
    assert.equal(found.indexedBlock, undefined);
  });

  it("reports no row when only the lag came back", async () => {
    answering({ data: { deposits: [], _meta: null }, errors: [{ message: "no block" }] });

    const found = await new GraphClient({ url: URL }).depositFor("7", TX);

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
      new GraphClient({ url: URL }).depositFor("7", TX),
      /statement timeout/,
      "the upstream reason should survive, so a 503 is diagnosable",
    );
  });

  it("refuses a response carrying no data at all", async () => {
    answering({ errors: [{ message: "connection refused" }] });

    await assert.rejects(new GraphClient({ url: URL }).depositFor("7", TX), /connection refused/);
  });

  it("refuses to guess when the index contradicts the replay guard", async () => {
    // Two rows for one transaction id cannot happen against a sound index: the contract's guard
    // is global. Taking the first would resolve a disagreement with consensus by picking a side.
    answering({ data: { deposits: [{ depositId: "2" }, { depositId: "5" }], _meta: null } });

    await assert.rejects(new GraphClient({ url: URL }).depositFor("7", TX), /2 deposits/);
  });

  it("asks once, because the lag rides on the deposit query", async () => {
    const state = answering({ data: { deposits: [], _meta: { block: { number: 4242 } } } });

    await new GraphClient({ url: URL }).depositFor("7", TX);

    assert.equal(state.calls, 1);
  });
});
