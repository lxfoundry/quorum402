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

/** What the index knows about one settled payment. Positions, not entitlements. */
export interface IndexedDeposit {
  /** The index into the pool's deposit array. What `depositAt` takes. */
  depositId: bigint;
  /** The address the log recorded. Cross-checked against the contract, never trusted alone. */
  payerAddress: string;
  counted: boolean;
}

export interface GraphClientOptions {
  /** The subgraph's GraphQL endpoint. */
  url: string;
  /** Bounded so a slow index cannot hold a request open indefinitely. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

interface GraphResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class GraphClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GraphClientOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Which deposit, if any, this transaction settled into this pool.
   *
   * `undefined` means the index has no such row - either the payment never landed, or it has
   * not been indexed yet. The two are not distinguishable from here and the caller must not
   * treat either as proof that no payment was made.
   */
  async depositFor(poolId: string, hederaTxId: string): Promise<IndexedDeposit | undefined> {
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
          payerAddress
          counted
        }
      }`;
    const data = await this.request<{
      deposits: Array<{ depositId: string; payerAddress: string; counted: boolean }>;
    }>(query, { poolId, txId: hederaTxId });

    if (data.deposits.length === 0) return undefined;
    if (data.deposits.length > 1) {
      // The contract's replay guard is global, so this cannot happen against a sound index.
      // If it ever does, the index disagrees with consensus and guessing would be the wrong
      // response to that.
      throw new Error(`index reports ${data.deposits.length} deposits for ${hederaTxId}`);
    }
    const [deposit] = data.deposits;
    if (!deposit) return undefined;
    return {
      depositId: BigInt(deposit.depositId),
      payerAddress: deposit.payerAddress,
      counted: deposit.counted,
    };
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

  /** The last block the index has ingested. Reported with a refusal, so lag is diagnosable. */
  async indexedBlock(): Promise<bigint | undefined> {
    const data = await this.request<{ _meta?: { block?: { number?: number } } }>(
      `query { _meta { block { number } } }`,
      {},
    );
    const number = data._meta?.block?.number;
    return number === undefined ? undefined : BigInt(number);
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if (!res.ok) throw new Error(`subgraph returned ${res.status}`);
    const body = (await res.json()) as GraphResponse<T>;
    // GraphQL answers 200 with an `errors` array, so the status code alone says nothing.
    if (body.errors?.length) {
      throw new Error(`subgraph error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new Error("subgraph returned no data");
    return body.data;
  }
}
