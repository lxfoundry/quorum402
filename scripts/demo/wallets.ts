/**
 * The wallets the demo UI switches between, and what each of them has just paid for.
 *
 * 🔴 **A private key must never leave this process.** `.accounts.json` holds them, this module is
 * the only thing in the demo that reads one, and `DemoWallet` - the shape the browser is sent -
 * deliberately has no field for one. Adding a key to that interface would publish four funded
 * testnet accounts to anything that can reach the page, so the split between `DemoWallet` and
 * `signingWallet` is the point of this file rather than an implementation detail.
 *
 * The seat memory below is *not* a database, and the coordinator still has none. It holds what a
 * payer would keep for themselves - the pool and settlement their own payment just returned - so
 * the page can show a seat number in the second between the payment landing and The Graph
 * indexing it. Everything in it is re-derivable from the chain and the index, which is why losing
 * it on restart costs nothing.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import type { IndexedPool } from "../../src/graph/client.js";
import { loadAccounts } from "../accounts.js";

/** Which half of the demo a wallet drives. Derived from the label, not from the ledger. */
export type WalletRole = "seller" | "buyer";

/**
 * A wallet as the browser is told about it.
 *
 * Everything here is public: an account id and its address are on a block explorer already, and
 * the balance is a mirror-node read anyone can make.
 */
export interface DemoWallet {
  label: string;
  role: WalletRole;
  accountId: string;
  evmAddress: string;
}

/** The same wallet, plus the key. Never serialised, never leaves the server. */
export interface SigningWallet extends DemoWallet {
  key: PrivateKey;
}

export class Wallets {
  private readonly byLabel = new Map<string, { wallet: DemoWallet; privateKey: string }>();

  constructor(network: string) {
    for (const account of loadAccounts(network)) {
      this.byLabel.set(account.label, {
        privateKey: account.privateKey,
        wallet: {
          label: account.label,
          // The seller is a role in the demo, not a fact about the account - `open-pool` takes
          // any recipient. Deriving it from the label keeps the two apart.
          role: account.label.startsWith("seller") ? "seller" : "buyer",
          accountId: account.accountId,
          // Deliberately the address `.accounts.json` recorded, which is the long-zero form of
          // the account number rather than the one the key derives. `create-accounts` has the
          // story; using the other one strands a seat.
          evmAddress: account.evmAddress,
        },
      });
    }
    if (this.byLabel.size === 0) {
      throw new Error("no accounts in .accounts.json. Run: npm run accounts:create");
    }
  }

  /** Every wallet, in the order they were created. Safe to serialise. */
  all(): DemoWallet[] {
    return [...this.byLabel.values()].map((entry) => entry.wallet);
  }

  /** The public half of one wallet, or `undefined` if the label is not one of ours. */
  find(label: string): DemoWallet | undefined {
    return this.byLabel.get(label)?.wallet;
  }

  /**
   * The signing half - only for a caller about to build a transaction.
   *
   * Throws rather than returning `undefined` for an unknown label: every caller is acting on a
   * label the page took from a list this class produced, so a miss is a bug rather than a case
   * to handle, and a silent one would sign as nobody.
   */
  signing(label: string): SigningWallet {
    const entry = this.byLabel.get(label);
    if (!entry) {
      throw new Error(
        `no wallet labelled "${label}". Available: ${[...this.byLabel.keys()].join(", ")}`,
      );
    }
    return { ...entry.wallet, key: PrivateKey.fromStringECDSA(entry.privateKey) };
  }
}

/**
 * A seat this process has just watched someone buy.
 *
 * Exactly what a payer holds after a 202: which pool, and which settlement. §8 asks them to
 * present both, and the UI hands them straight back rather than looking them up again.
 */
export interface PaidSeat {
  wallet: string;
  /** The Hedera transaction id the payment settled under. */
  transaction: string;
  /** The seat this payment took, when it took one. Null when the coordinator could not say. */
  seat: number | null;
  counted: boolean | null;
  /**
   * The pool as it was when the payment landed.
   *
   * Carried whole, and in the shape the index returns, so a seat bought two seconds ago renders
   * through exactly the same path as one the index has caught up with - rather than the page
   * needing a second layout for the rows it has not heard back about yet.
   */
  pool: IndexedPool;
  /** Unix milliseconds, so the newest is showable first before the index has an opinion. */
  at: number;
}

/**
 * What each wallet has bought while this process has been up.
 *
 * Bounded per wallet, because it is a display cache and an unbounded one in a long demo session
 * is a leak that only shows up after the interesting part.
 */
export class SeatMemory {
  private readonly byWallet = new Map<string, PaidSeat[]>();

  constructor(private readonly keep = 12) {}

  remember(seat: PaidSeat): void {
    const seats = this.byWallet.get(seat.wallet) ?? [];
    // A retry of the same payment must not become a second seat on the screen.
    const already = seats.some(
      (s) => s.pool.poolId === seat.pool.poolId && s.transaction === seat.transaction,
    );
    if (already) return;
    seats.unshift(seat);
    this.byWallet.set(seat.wallet, seats.slice(0, this.keep));
  }

  /** Newest first. */
  forWallet(label: string): PaidSeat[] {
    return this.byWallet.get(label) ?? [];
  }
}
