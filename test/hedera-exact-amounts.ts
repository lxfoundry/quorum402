/**
 * The tinybar/HBAR conversion, in both directions.
 *
 * A price is the one number in this project that must survive a round trip exactly. Both halves
 * live in `hedera-exact.ts` so that this file can hold them to each other - a formatter that
 * rounds, or a parser that accepts what the formatter cannot produce, would misprice a seat and
 * the contract would take the mispriced amount at face value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hbarToTinybars, tinybarsToHbar } from "../src/x402/hedera-exact.js";

describe("tinybars as HBAR", () => {
  it("trims trailing zeros without losing tinybar precision", () => {
    assert.equal(tinybarsToHbar(100_000_000n), "1");
    assert.equal(tinybarsToHbar(150_000_000n), "1.5");
    assert.equal(tinybarsToHbar(10_000_000n), "0.1");
    // One tinybar: the smallest unit there is, and the one a float would round away.
    assert.equal(tinybarsToHbar(1n), "0.00000001");
    assert.equal(tinybarsToHbar(0n), "0");
  });

  it("carries the sign on the front", () => {
    // `-1n / 100_000_000n` is `0n`, so a negative amount formatted by dividing out the whole
    // part loses its sign entirely and reads as a positive fraction. A refund delta is negative.
    assert.equal(tinybarsToHbar(-1n), "-0.00000001");
    assert.equal(tinybarsToHbar(-150_000_000n), "-1.5");
  });

  it("round-trips every amount the parser accepts", () => {
    for (const tinybars of [0n, 1n, 10_000_000n, 100_000_000n, 150_000_000n, 12_345_678_901n]) {
      assert.equal(hbarToTinybars(tinybarsToHbar(tinybars)), tinybars);
    }
  });
});
