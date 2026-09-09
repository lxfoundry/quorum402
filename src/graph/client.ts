/**
 * The subgraph, asked questions the contract cannot answer.
 *
 * There is exactly one fact this index holds that consensus state does not expose: **which
 * deposit a Hedera transaction id belongs to**. `recordDeposit` hashes the id into its
 * double-spend guard and keeps only the hash, emitting the id itself with `DepositRecorded` and
 * `LateDeposit`. So a payer holding a transaction id and a server holding a contract have no way
 * to meet without the log, and §8 says so outright.
 *
 * That is the whole of this client's authority, and it is deliberately narrow. It resolves an id
 * to a **position**; `payer` and `counted` - the two facts entitlement actually turns on - are
 * read back from the contract at that position by the caller. An index that lags shows up as a
 * seat that is not redeemable yet. An index that is wrong can, at worst, point at the wrong row
 * of a real pool, and the row still comes from consensus.
 *
 * The index also lags, always, by design: it is built from blocks that have already been
 * indexed. A redemption seconds after the payment is the ordinary case, so `depositFor` reports
 * "not indexed yet" as its own answer rather than as absence.
 */

import { POOL_STATES } from "../pool/client.js";
import type { PoolState } from "../pool/client.js";

/**
 * What the index can say about one settled payment. A position, and how far it has read.
 *
 * Only the position: the log also records the payer and whether the deposit counted, and this
 * deliberately returns neither. Those two facts are what entitlement turns on, they are read
 * back from the contract at this position, and handing a caller an indexed copy of them would
 * put a second, weaker answer to the same question within reach.
 */
export interface DepositLookup {
  /** The index into the pool's deposit array. What `depositAt` takes. */
  depositId?: bigint;
  /**
   * The last block the index has ingested.
   *
   * Read in the same query as the deposit, because the case that needs it is the one where
   * there is no deposit - "not indexed yet" is the ordinary answer seconds after a payment,
   * and asking a second time to find out how far behind it is doubles the cost of the most
   * retried refusal on the path.
   */
  indexedBlock?: bigint;
}

/**
 * One pool as the index holds it.
 *
 * `state` is the pool's **stored** state and disagrees with the chain in exactly one window: a
 * pool past its deadline that nobody has stamped still reads `Open` here, because `PoolExpired`
 * is emitted by `expire`, `claimRefund` and `refundAll` and by nothing else. The schema says so
 * on the field itself. Read it against `deadline`, never alone.
 */
export interface IndexedPool {
  poolId: string;
  state: PoolState;
  seats: number;
  threshold: number;
  /** Unix seconds. */
  deadline: number;
  unitTinybars: bigint;
  resourceUrl: string;
}

/** One settled payment as the index holds it, with the pool it landed in. */
export interface IndexedDeposit {
  depositId: bigint;
  /** The Hedera transaction id it settled under - the only place this survives. */
  transaction: string;
  tinybars: bigint;
  /** Whether it took a seat. False means it settled late: refundable at once, entitling nothing. */
  counted: boolean;
  refunded: boolean;
  /**
   * Seats the pool held once this deposit had been applied - so, for a counted deposit, the seat
   * number this payment took. For a late one it is the count *unchanged*, which is what being
   * late means. Read it against `counted`.
   */
  seatsAfter: number;
  pool: IndexedPool;
}

export interface IndexedDeposits {
  deposits: IndexedDeposit[];
  /** The last block the index has ingested - how far behind the chain this answer is. */
  indexedBlock?: bigint;
}

/** The JSON as GraphQL sends it: every number a string, because they are all big integers. */
interface RawIndexedDeposit {
  depositId: string;
  hederaTxId: string;
  tinybars: string;
  counted: boolean;
  refunded: boolean;
  seatsAfter: number;
  pool: {
    poolId: string;
    state: string;
    seats: number;
    threshold: number;
    deadline: string;
    unitTinybars: string;
    resourceUrl: string;
  };
}

function toIndexedDeposit(raw: RawIndexedDeposit): IndexedDeposit {
  const state = raw.pool.state as PoolState;
  // A state this client does not know is a subgraph it does not know, and reporting `Open`
  // instead would be a plausible answer - the worst kind of wrong for a field that decides
  // whether a buyer is shown a Redeem button or a Refund one.
  if (!POOL_STATES.includes(state)) {
    throw new Error(`index reports unknown pool state "${raw.pool.state}" for pool ${raw.pool.poolId}`);
  }
  return {
    depositId: BigInt(raw.depositId),
    transaction: raw.hederaTxId,
    tinybars: BigInt(raw.tinybars),
    counted: raw.counted,
    refunded: raw.refunded,
    seatsAfter: raw.seatsAfter,
    pool: {
      poolId: raw.pool.poolId,
      state,
      seats: raw.pool.seats,
      threshold: raw.pool.threshold,
      deadline: Number(raw.pool.deadline),
      unitTinybars: BigInt(raw.pool.unitTinybars),
      resourceUrl: raw.pool.resourceUrl,
    },
  };
}

export interface GraphClientOptions {
  /** The subgraph's GraphQL endpoint. */
  url: string;
}

/** Bounded so a slow index cannot hold a request open indefinitely. */
const TIMEOUT_MS = 5_000;

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function blockOf(meta: { block?: { number?: number } } | undefined): bigint | undefined {
  const number = meta?.block?.number;
  return number === undefined ? undefined : BigInt(number);
}

export class GraphClient {
  private readonly url: string;

  constructor(options: GraphClientOptions) {
    this.url = options.url;
  }

  /**
   * Which deposit, if any, this transaction settled into this pool.
   *
   * An absent `depositId` means the index has no such row - either the payment never landed, or
   * it has not been indexed yet. The two are not distinguishable from here and the caller must
   * not treat either as proof that no payment was made. A lookup that could not be made at all
   * throws instead, because that is not an answer about the payment.
   */
  async depositFor(poolId: string, hederaTxId: string): Promise<DepositLookup> {
    // Filtered on both, not just the transaction id: the id is unique across the contract by
    // the replay guard, but querying it alone would let a wrong `poolId` in a receipt be
    // answered with a real deposit from another pool. Bounded at 2 so a duplicate is visible
    // rather than silently resolved by taking the first.
    const query = `
      query DepositFor($poolId: String!, $txId: String!) {
        deposits(
          where: { pool: $poolId, hederaTxId: $txId }
          first: 2
        ) {
          depositId
        }
        _meta { block { number } }
      }`;
    const { data, errorText } = await this.post<{
      deposits?: Array<{ depositId: string }> | null;
      _meta?: { block?: { number?: number } } | null;
    }>(query, { poolId, txId: hederaTxId });

    // `_meta` is advisory: it sharpens a "not indexed yet" refusal and decides nothing. GraphQL
    // resolves fields independently and answers 200 with the ones that worked, so an index that
    // places the deposit and fails to report its own head has still answered the question
    // entitlement turns on. Failing the whole lookup there would 503 a redemption whose seat is
    // sitting in `deposits` - a seat refused on a diagnostic.
    if (!data?.deposits) {
      throw new Error(`subgraph error: ${errorText ?? "no deposits in the response"}`);
    }
    const deposits = data.deposits;
    const indexedBlock = blockOf(data._meta ?? undefined);
    if (deposits.length > 1) {
      // The contract's replay guard is global, so this cannot happen against a sound index.
      // If it ever does, the index disagrees with consensus and guessing would be the wrong
      // response to that.
      throw new Error(`index reports ${deposits.length} deposits for ${hederaTxId}`);
    }
    const [deposit] = deposits;
    return deposit ? { depositId: BigInt(deposit.depositId), indexedBlock } : { indexedBlock };
  }

  /**
   * Has this transaction already been attributed anywhere?
   *
   * The replay guard the preflight (ADR 0006) wanted and could not have: the contract exposes
   * no getter over its hash set. Softer than the rest of that gate for the reason recorded
   * there - the index lags, so a `false` is not proof of absence - which is why it refuses a
   * payment only when the answer is a definite `true`.
   */
  async isRecorded(hederaTxId: string): Promise<boolean> {
    const query = `
      query IsRecorded($txId: String!) {
        deposits(where: { hederaTxId: $txId }, first: 1) { id }
      }`;
    const data = await this.request<{ deposits: Array<{ id: string }> }>(query, {
      txId: hederaTxId,
    });
    return data.deposits.length > 0;
  }

  /**
   * The settlement one payer's deposit in one pool was recorded under.
   *
   * A convenience for the demo CLI and **not** part of §8: a payer normally keeps the id their
   * own payment returned, and the protocol asks them to present it. It is here because the
   * index is the only place that id survives, so a buyer who lost it has exactly one way back
   * to their own seat.
   *
   * Takes the earliest, which for a counted deposit is the only one - a second payment from an
   * address that already holds a seat is late by construction.
   */
  async settlementFor(poolId: string, payerAddress: string): Promise<string | undefined> {
    const query = `
      query SettlementFor($poolId: String!, $payer: String!) {
        deposits(
          where: { pool: $poolId, payerAddress: $payer, counted: true }
          orderBy: depositId
          orderDirection: asc
          first: 1
        ) {
          hederaTxId
        }
      }`;
    const data = await this.request<{ deposits: Array<{ hederaTxId: string }> }>(query, {
      poolId,
      // The index stores addresses lowercase, and a checksummed one would silently match
      // nothing rather than failing.
      payer: payerAddress.toLowerCase(),
    });
    return data.deposits[0]?.hederaTxId;
  }

  /**
   * Every deposit this address has made, newest first, with the pool each one landed in.
   *
   * A convenience for the demo UI and **not** part of §8, like `settlementFor` above and for the
   * same reason: entitlement is decided by the coordinator reading `payer` and `counted` back off
   * the contract, and nothing here is a shortcut around that. This answers a different question -
   * *which pools should I show this buyer* - and the contract cannot answer it at all, because it
   * keeps no per-address list and forgets the transaction id entirely.
   *
   * Uncounted deposits are included. A payment that arrived too late took no seat and entitles
   * nothing, but it is refundable at once and the payer is precisely who needs to be told so;
   * filtering to `counted` would hide the money that most needs claiming.
   *
   * Bounded rather than paged. This exists to fill one screen.
   */
  async depositsFor(payerAddress: string, first = 25): Promise<IndexedDeposits> {
    const query = `
      query DepositsFor($payer: String!, $first: Int!) {
        deposits(
          where: { payerAddress: $payer }
          orderBy: recordedAt
          orderDirection: desc
          first: $first
        ) {
          depositId
          hederaTxId
          tinybars
          counted
          refunded
          seatsAfter
          pool {
            poolId
            state
            seats
            threshold
            deadline
            unitTinybars
            resourceUrl
          }
        }
        _meta { block { number } }
      }`;
    const data = await this.request<{
      deposits: RawIndexedDeposit[];
      _meta?: { block?: { number?: number } } | null;
    }>(query, {
      // Lowercase for the same reason `settlementFor` does it: the index stores addresses that
      // way, and a checksummed one matches nothing rather than failing.
      payer: payerAddress.toLowerCase(),
      first,
    });
    return {
      deposits: data.deposits.map(toIndexedDeposit),
      indexedBlock: blockOf(data._meta ?? undefined),
    };
  }

  /**
   * The answer as it arrived: whatever `data` came back, and whatever errors came with it.
   *
   * Kept separate because the two are not exclusive. A query asking two questions can have one
   * resolved and the other nulled with an entry in `errors`, and which half that is decides
   * whether the caller has an answer. `request` wants all of it; `depositFor` does not.
   */
  private async post<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data?: T; errorText?: string }> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (!res.ok) throw new Error(`subgraph returned ${res.status}`);
    const body = (await res.json()) as GraphResponse<T>;
    const errorText = body.errors?.length
      ? body.errors.map((e) => e.message).join("; ")
      : undefined;
    return { data: body.data, errorText };
  }

  /** Every field the query asked for, or nothing. */
  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // GraphQL answers 200 with an `errors` array, so the status code alone says nothing.
    const { data, errorText } = await this.post<T>(query, variables);
    if (errorText) throw new Error(`subgraph error: ${errorText}`);
    if (!data) throw new Error("subgraph returned no data");
    return data;
  }
}
