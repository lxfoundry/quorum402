/**
 * Who gets the resource, and who is told what instead.
 *
 * `quorum-scheme.md` §8 fixes the order of these checks and §6's table fixes what each outcome
 * answers. Both are asserted here, and the ordering assertions matter as much as the rulings: a
 * server that reached the right verdict by a different route would leak whether a pool, a
 * transaction or a seat exists to anyone who sends an unsigned request.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivateKey } from "@hiero-ledger/sdk";
import { MAX_VALIDITY_WINDOW_SECONDS, redeem, statusFor } from "../src/server/redeem.js";
import type { RedeemDeps } from "../src/server/redeem.js";
import type { MirrorAccount } from "../src/hedera/mirror.js";
import { canonicalRedemptionMessage } from "../src/x402/redemption.js";
import type { RedemptionReceipt } from "../src/x402/redemption.js";
import type { Deposit, PoolState, PoolTerms } from "../src/pool/client.js";

const NETWORK = "hedera:testnet";
const CONTRACT = "0.0.10409980";
const RESOURCE = "https://quorum402.example/benchmark/inference";
const NOW_SECONDS = 1_789_171_200;
const ACCOUNT = "0.0.10407151";
const PAYER = "0x00000000000000000000000000000000009eccef";

const terms: PoolTerms = {
  poolId: 7n,
  recipient: "0x0000000000000000000000000000000000000001",
  coordinator: "0x0000000000000000000000000000000000000002",
  unitTinybars: 100_000_000n,
  threshold: 3,
  seats: 3,
  deadline: NOW_SECONDS + 3600,
  state: "Met",
  resourceUrl: RESOURCE,
};

const counted: Deposit = { payer: PAYER, tinybars: 100_000_000n, counted: true, refunded: false };

/** An ECDSA key, because that is what `accounts:create` makes. ED25519 gets its own test. */
const ecdsa = PrivateKey.generateECDSA();
const ed25519 = PrivateKey.generateED25519();

function ledgerAccount(key: PrivateKey, address = PAYER): MirrorAccount {
  // Raw hex, which is what the mirror node reports: 32 bytes for ED25519, 33 compressed for
  // ECDSA. `toString()` is DER and would tell these two apart by the wrong number.
  const hex = key.publicKey.toStringRaw();
  return {
    evmAddress: address,
    key: { type: hex.length === 64 ? "ED25519" : "ECDSA_SECP256K1", hex },
  };
}

function sign(
  key: PrivateKey,
  overrides: Partial<RedemptionReceipt & { resource: string; contract: string; network: string }> = {},
): RedemptionReceipt {
  const receipt = {
    accountId: overrides.accountId ?? ACCOUNT,
    poolId: overrides.poolId ?? "7",
    transaction: overrides.transaction ?? "0.0.7162784@1788894730.022621899",
    validUntil: overrides.validUntil ?? NOW_SECONDS + 300,
  };
  const message = canonicalRedemptionMessage({
    ...receipt,
    network: overrides.network ?? NETWORK,
    contract: overrides.contract ?? CONTRACT,
    resource: overrides.resource ?? RESOURCE,
  });
  return {
    ...receipt,
    signature: Buffer.from(key.sign(message)).toString("base64"),
  };
}

function deps(overrides: Partial<RedeemDeps> = {}): RedeemDeps {
  return {
    network: NETWORK,
    contractId: CONTRACT,
    accountOf: async () => ledgerAccount(ecdsa),
    depositFor: async () => ({ depositId: 0n }),
    depositAt: async () => counted,
    now: () => NOW_SECONDS * 1000,
    ...overrides,
  };
}

async function attempt(
  overrides: Partial<RedeemDeps> = {},
  receipt: RedemptionReceipt = sign(ecdsa),
  state: PoolState = "Met",
  poolTerms: PoolTerms = terms,
) {
  return redeem(deps(overrides), { receipt, resourceUrl: RESOURCE, terms: poolTerms, state });
}

describe("redeeming a seat", () => {
  it("serves the resource to a counted payer of a met pool", async () => {
    const result = await attempt();

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.payer, PAYER);
    assert.equal(terms.seats, 3);
  });

  it("still serves it after the pool has released", async () => {
    // §8 step 5, and the coupling §6 forbids: paying the seller is a separate permissionless
    // action, and a payer whose access died the moment the payout landed would have bought a
    // seat that evaporates on someone else's transaction.
    const result = await attempt({}, sign(ecdsa), "Released");

    assert.equal(result.ok, true);
  });

  it("verifies an ED25519 account too", async () => {
    // §8 says "whatever its type", and a payer does not choose which types a scheme supports.
    const result = await attempt({ accountOf: async () => ledgerAccount(ed25519) }, sign(ed25519));

    assert.equal(result.ok, true);
  });
});

describe("proofs that do not stand up", () => {
  it("refuses a signature from the wrong key", async () => {
    const result = await attempt({}, sign(PrivateKey.generateECDSA()));

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "invalid-proof");
    assert.equal(!result.ok && statusFor(result), 401);
  });

  it("refuses a receipt signed for another resource, contract or network", async () => {
    // The replay argument in §8 rests on exactly this. Each of these is a signature that is
    // perfectly valid somewhere else.
    for (const overrides of [
      { resource: "https://quorum402.example/benchmark/other" },
      { contract: "0.0.99" },
      { network: "hedera:mainnet" },
    ]) {
      const result = await attempt({}, sign(ecdsa, overrides));

      assert.equal(result.ok, false, `${JSON.stringify(overrides)} was accepted`);
      assert.equal(!result.ok && result.reason, "invalid-proof");
    }
  });

  it("says nothing about which part of the signature failed", async () => {
    // Naming the mismatch would make this an oracle for what the server sells and where.
    const result = await attempt({}, sign(ecdsa, { contract: "0.0.99" }));

    assert.equal(!result.ok && result.detail, "signature does not verify");
  });

  it("refuses an expired receipt", async () => {
    const result = await attempt({}, sign(ecdsa, { validUntil: NOW_SECONDS - 60 }));

    assert.equal(!result.ok && result.reason, "expired-proof");
    assert.equal(!result.ok && statusFor(result), 401);
  });

  it("tolerates small clock skew, in the payer's favour only", async () => {
    const justPast = await attempt({}, sign(ecdsa, { validUntil: NOW_SECONDS - 5 }));

    assert.equal(justPast.ok, true);
  });

  it("refuses a receipt valid implausibly far ahead", async () => {
    // §8 rule 1. The window is the containment: inside it the receipt can be replayed by anyone
    // who sees it, so a receipt good for a year is a bearer key to the resource.
    const result = await attempt(
      {},
      sign(ecdsa, { validUntil: NOW_SECONDS + MAX_VALIDITY_WINDOW_SECONDS + 60 }),
    );

    assert.equal(!result.ok && result.reason, "expired-proof");
  });

  it("refuses a receipt naming a pool this resource is not sold by", async () => {
    const result = await attempt({}, sign(ecdsa, { poolId: "8" }));

    assert.equal(!result.ok && result.reason, "invalid-proof");
  });

  it("treats an unreadable account as a bad proof, not a server error", async () => {
    // A threshold-key account reaches here. It cannot sign this message, and that is the
    // payer's problem to see rather than a 500.
    const result = await attempt({
      accountOf: async () => {
        throw new Error("account 0.0.1 has key type ProtobufEncoded, which cannot sign");
      },
    });

    assert.equal(!result.ok && result.reason, "invalid-proof");
  });
});

describe("the checks run in §8's order", () => {
  it("verifies the signature before looking up anything", async () => {
    // The ordering is the privacy property: an unsigned request must not be able to learn
    // whether a transaction, a deposit or a seat exists.
    let looked = false;
    const result = await attempt(
      {
        depositFor: async () => {
          looked = true;
          return { depositId: 0n };
        },
      },
      sign(PrivateKey.generateECDSA()),
    );

    assert.equal(result.ok, false);
    assert.equal(looked, false, "looked up a deposit for an unverified receipt");
  });

  it("checks expiry before it touches the ledger", async () => {
    let asked = false;
    await attempt(
      {
        accountOf: async () => {
          asked = true;
          return ledgerAccount(ecdsa);
        },
      },
      sign(ecdsa, { validUntil: NOW_SECONDS - 3600 }),
    );

    assert.equal(asked, false, "resolved an account for an expired receipt");
  });

  it("reports a seatless deposit rather than the pool's fill", async () => {
    // Order matters to the payer here, not just to the server: a late payment will never become
    // a seat, so answering 202 "still filling" would be telling them to wait forever.
    const late: Deposit = { ...counted, counted: false };
    const result = await attempt({ depositAt: async () => late }, sign(ecdsa), "Open", {
      ...terms,
      seats: 1,
      state: "Open",
    });

    assert.equal(!result.ok && result.reason, "no-seat");
    assert.equal(!result.ok && statusFor(result), 409);
  });
});

describe("claims that are real but do not entitle", () => {
  it("refuses a deposit recorded against another address, and says so", async () => {
    // 403, not 401: the signature was good. Re-signing would teach the payer nothing, and 401
    // is an invitation to try a better credential that does not exist.
    const someoneElse: Deposit = { ...counted, payer: "0x000000000000000000000000000000000000dead" };
    const result = await attempt({ depositAt: async () => someoneElse });

    assert.equal(!result.ok && result.reason, "not-your-deposit");
    assert.equal(!result.ok && statusFor(result), 403);
  });

  it("does not care how an address is cased", async () => {
    const upper: Deposit = { ...counted, payer: PAYER.toUpperCase().replace("0X", "0x") };
    const result = await attempt({ depositAt: async () => upper });

    assert.equal(result.ok, true);
  });

  it("answers 202 with the fill while the pool is still open", async () => {
    const result = await attempt({}, sign(ecdsa), "Open", { ...terms, seats: 2, state: "Open" });

    assert.equal(!result.ok && result.reason, "still-filling");
    assert.equal(!result.ok && statusFor(result), 202);
    assert.equal(!result.ok && result.reason === "still-filling" && result.filled, 2);
  });

  it("points an expired pool's payer at the refund, not at a retry", async () => {
    const result = await attempt({}, sign(ecdsa), "Expired", { ...terms, seats: 2 });

    assert.equal(!result.ok && result.reason, "pool-expired");
    assert.equal(!result.ok && statusFor(result), 409);
    assert.equal(
      !result.ok && result.reason === "pool-expired" && result.reclaim.method,
      "claimRefund(uint256)",
    );
  });
});

describe("an index that is behind", () => {
  it("does not tell a payer their payment does not exist", async () => {
    // The ordinary case: a redemption seconds after the settlement that funded it. Absence in
    // the index is lag until proven otherwise, and 404 here names both causes.
    const result = await attempt({ depositFor: async () => ({}) });

    assert.equal(!result.ok && result.reason, "no-such-deposit");
    assert.equal(!result.ok && statusFor(result), 404);
    assert.match(!result.ok ? result.detail : "", /not indexed yet/);
  });

  it("reports how far the index has got, so the lag is diagnosable", async () => {
    // Carried on the same answer as the absence it explains, so the most retried refusal on
    // this path costs one round trip rather than two.
    const result = await attempt({ depositFor: async () => ({ indexedBlock: 4_242n }) });

    assert.equal(!result.ok && result.reason === "no-such-deposit" && result.indexedBlock, 4_242n);
  });

  it("still answers when the index cannot say where it has got to", async () => {
    // An index can answer the deposit question and not the `_meta` one. The refusal is about
    // the deposit, so it stands with the lag simply unreported.
    const result = await attempt({ depositFor: async () => ({ indexedBlock: undefined }) });

    assert.equal(!result.ok && result.reason, "no-such-deposit");
    assert.equal(!result.ok && result.reason === "no-such-deposit" && result.indexedBlock, undefined);
  });
});

describe("an index that is down", () => {
  it("does not report a missing seat because a read failed", async () => {
    // The distinction that matters: "no deposit" is a fact about the pool, and an unreachable
    // index is a fact about this server. Answering 404 would tell a payer holding a good seat
    // that their payment never happened.
    const result = await attempt({
      depositFor: async () => {
        throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:8000");
      },
    });

    assert.equal(!result.ok && result.reason, "index-unavailable");
    assert.equal(!result.ok && statusFor(result), 503);
  });

  it("keeps the upstream failure out of what the payer is told", async () => {
    const result = await attempt({
      depositFor: async () => {
        throw new Error("subgraph error: Store error: database unavailable at 10.0.0.4:5432");
      },
    });

    assert.equal(!result.ok && result.reason, "index-unavailable");
    // The payer gets what this server could not do; the log gets why.
    assert.equal(!result.ok ? result.detail : "", "the index could not be reached");
    assert.doesNotMatch(!result.ok ? result.detail : "", /10\.0\.0\.4/);
    assert.match(!result.ok && result.reason === "index-unavailable" ? result.cause : "", /database unavailable/);
  });

  it("answers the same way when the contract read is the one that fails", async () => {
    // Includes the index naming a row the contract does not have - a disagreement between the
    // index and consensus, which is still nothing the payer did.
    const result = await attempt({
      depositAt: async () => {
        throw new Error("execution reverted: NoSuchDeposit");
      },
    });

    assert.equal(!result.ok && result.reason, "index-unavailable");
    assert.equal(!result.ok && statusFor(result), 503);
  });

  it("still refuses a bad proof rather than blaming the index", async () => {
    // §8's order holds under failure too: nothing reaches the index until the signature has
    // verified, so a forged receipt gets 401 on a server whose index is down.
    const result = await attempt(
      {
        depositFor: async () => {
          throw new Error("fetch failed");
        },
      },
      sign(PrivateKey.generateECDSA()),
    );

    assert.equal(!result.ok && result.reason, "invalid-proof");
    assert.equal(!result.ok && statusFor(result), 401);
  });
});
