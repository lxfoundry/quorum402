/**
 * The parts of the demo reset that can be wrong without the network saying so.
 *
 * Sweeping, retiring and creating all need Hedera, and `npm run demo:reset` reports on itself
 * loudly enough when they go wrong. Two things here do not: how an accounts file is superseded,
 * and how the flags are read. Both are quiet failures with expensive consequences.
 *
 * The archive name is the one that matters most. `.gitignore` covers `.accounts.json` and
 * `*.accounts.json`, and an archive that fell outside those patterns would be a file of private
 * keys sitting untracked-but-not-ignored in a public repository, one `git add -A` from being
 * published irreversibly. That is a property of a string this code builds, so it is asserted
 * here rather than trusted.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { archiveAccounts, readAccountsFile, writeAccounts } from "../scripts/accounts.js";
import { labelsFor, parseArgs, tookSeat } from "../scripts/demo-reset.js";
import type { GeneratedAccount } from "../scripts/create-accounts.js";

/** The patterns `.gitignore` uses for these files. An archive has to match one of them. */
function gitignored(filename: string): boolean {
  return filename === ".accounts.json" || filename.endsWith(".accounts.json");
}

const ACCOUNT: GeneratedAccount = {
  label: "buyer1",
  accountId: "0.0.1234",
  privateKey: "deadbeef",
  evmAddress: "0x00000000000000000000000000000000000004d2",
};

function inTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "quorum402-reset-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("superseding an accounts file", () => {
  it("renames it to something .gitignore already covers", () => {
    inTempDir((dir) => {
      const path = join(dir, ".accounts.json");
      writeAccounts([ACCOUNT], "testnet", path);

      const archive = archiveAccounts(path);

      assert.ok(archive, "expected an archive path");
      assert.ok(
        gitignored(basename(archive)),
        `archive ${basename(archive)} is not matched by .gitignore`,
      );
    });
  });

  it("keeps the keys, because a refund can only ever be claimed by the account that paid", () => {
    inTempDir((dir) => {
      const path = join(dir, ".accounts.json");
      writeAccounts([ACCOUNT], "testnet", path);

      const archive = archiveAccounts(path);

      assert.ok(archive);
      assert.equal(existsSync(path), false, "the original should have moved, not been copied");
      assert.deepEqual(readAccountsFile(archive).accounts, [ACCOUNT]);
    });
  });

  it("does not collide with an archive already beside it", () => {
    inTempDir((dir) => {
      // Frozen, so both archives genuinely share a second. Left to the real clock this passes
      // whenever the two calls happen to straddle a boundary, which is most of the time - a
      // test for same-second collisions that only sometimes produces one proves nothing.
      const sameSecond = { now: () => new Date("2026-09-11T08:16:51.000Z") };
      const path = join(dir, ".accounts.json");

      writeAccounts([ACCOUNT], "testnet", path);
      const first = archiveAccounts(path, sameSecond);
      assert.ok(first);

      // A second reset in the same second must not overwrite the first archive - that would
      // delete keys by the very act meant to preserve them.
      writeAccounts([{ ...ACCOUNT, accountId: "0.0.5678" }], "testnet", path);
      const second = archiveAccounts(path, sameSecond);

      assert.ok(second);
      assert.notEqual(first, second);
      assert.deepEqual(readAccountsFile(first).accounts, [ACCOUNT]);
      assert.deepEqual(readAccountsFile(second).accounts, [
        { ...ACCOUNT, accountId: "0.0.5678" },
      ]);
      assert.ok(gitignored(basename(second)), "the disambiguated name must stay ignored too");
    });
  });

  it("reports nothing to do when there is no file", () => {
    inTempDir((dir) => {
      assert.equal(archiveAccounts(join(dir, ".accounts.json")), undefined);
    });
  });

  it("writes what loadAccounts expects to read", () => {
    inTempDir((dir) => {
      const path = join(dir, ".accounts.json");
      writeAccounts([ACCOUNT], "testnet", path);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        network: "testnet",
        accounts: [ACCOUNT],
      });
    });
  });

  it("refuses to read a file that is not there, rather than reporting no accounts", () => {
    inTempDir((dir) => {
      // An empty list would read as "nothing to recycle" and sweep nothing, silently.
      assert.throws(() => readAccountsFile(join(dir, "absent.accounts.json")), /not found/);
    });
  });
});

describe("reading the flags", () => {
  it("does nothing without --yes", () => {
    assert.equal(parseArgs([]).yes, false);
    assert.equal(parseArgs(["--yes"]).yes, true);
  });

  it("leaves a selling pool alone unless asked", () => {
    assert.equal(parseArgs([]).retire, false);
    assert.equal(parseArgs(["--retire"]).retire, true);
  });

  it("collects every --also-sweep, because a second working copy has accounts too", () => {
    const args = parseArgs(["--also-sweep", "../a/.accounts.json", "--also-sweep", "../b.json"]);
    assert.deepEqual(args.alsoSweep, ["../a/.accounts.json", "../b.json"]);
  });

  it("refuses --also-sweep with no path, rather than swallowing the next flag", () => {
    assert.throws(() => parseArgs(["--also-sweep", "--yes"]), /needs a path/);
    assert.throws(() => parseArgs(["--also-sweep"]), /needs a path/);
  });

  it("refuses a flag it does not know", () => {
    // The alternative is a typo that silently does the default thing - which here means
    // sweeping accounts the caller meant to spare.
    assert.throws(() => parseArgs(["--dry-run"]), /unknown flag/);
  });

  it("keeps a path that starts with a dash out of the flag namespace", () => {
    assert.deepEqual(parseArgs(["--also-sweep", "./-odd.accounts.json"]).alsoSweep, [
      "./-odd.accounts.json",
    ]);
  });

  it("refuses counts that are not counts", () => {
    assert.throws(() => parseArgs(["--buyers", "0"]), /positive/);
    assert.throws(() => parseArgs(["--buyers", "2.5"]), /whole number/);
    assert.throws(() => parseArgs(["--buyers", "99"]), /up to 10/);
    assert.throws(() => parseArgs(["--hbar-each", "-1"]), /positive/);
    assert.throws(() => parseArgs(["--hbar-each", "nope"]), /positive/);
  });
});

describe("reading whether a payment took a seat", () => {
  // The property `--retire` rests on. A payer already holding a seat in the pool is *not*
  // refused - `recordDeposit` never reverts for a buyer-side reason, so the money settles as a
  // late deposit and the coordinator answers 202 with a receipt saying `counted: false`. Read
  // as "202 means a seat", that spends a seat price, moves the seat count not at all, and
  // leaves the pool selling - which is the one outcome the flag exists to prevent.
  it("does not mistake a settled late deposit for a seat", () => {
    assert.equal(tookSeat({ status: 202, body: { counted: false, seat: null } }), false);
  });

  it("takes a counted 202 at its word", () => {
    assert.equal(tookSeat({ status: 202, body: { counted: true, seat: 2 } }), true);
  });

  it("reads a 200 without asking, because it is only answered for a counted payment", () => {
    // 200 carries the licence with the receipt *nested*, so there is no top-level `counted` to
    // read - and none is needed: the coordinator answers 200 only when this payment was counted
    // and met the threshold.
    assert.equal(tookSeat({ status: 200, body: { licence: {}, receipt: { counted: true } } }), true);
  });

  it("keeps unknown distinct from false", () => {
    // `counted: null` is the receipt's third answer: the attribution was recovered from the
    // replay guard, which proves the payment landed without saying which deposit it is.
    assert.equal(tookSeat({ status: 202, body: { counted: null } }), null);
    assert.equal(tookSeat({ status: 202, body: {} }), null);
    assert.equal(tookSeat({ status: 202, body: null }), null);
    assert.equal(tookSeat({ status: 202, body: "not json" }), null);
  });
});

describe("the cast the demo expects", () => {
  it("names four buyers and a seller by default", () => {
    assert.deepEqual(labelsFor(4), ["buyer1", "buyer2", "buyer3", "buyer4", "seller"]);
  });

  it("puts the seller last but identifies it by prefix, as wallets.ts does", () => {
    // `wallets.ts` derives the role from `label.startsWith("seller")`, so exactly one label
    // here may do that - a fifth buyer called "sellerish" would become a second seller.
    const labels = labelsFor(4);
    assert.equal(labels.filter((l) => l.startsWith("seller")).length, 1);
  });
});
