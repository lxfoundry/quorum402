/**
 * Calling the pool contract from Hedera's own API, rather than through a JSON-RPC relay.
 *
 * The contract is reached with `ContractExecuteTransaction` for the same reason it is
 * deployed with the SDK (see `scripts/deploy.ts`): everything else in this project speaks
 * Hedera entity ids, and a relay would be a second way of talking to the same contract with
 * its own account model and its own failures.
 *
 * Only what the coordinator and a demo need is here.
 *
 * That now includes the reversal paths, which are not the coordinator's - `quorum-scheme.md` §9
 * puts them deliberately outside it, so that getting your money back never depends on the
 * liveness of the party whose failure you most need protection from. They are on this client
 * because a demo has to be able to *show* that, and `claimRefund` shows it by being called
 * through a client whose operator is the payer rather than the coordinator.
 */
import {
  ContractCallQuery,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  Long,
  TransactionRecordQuery,
} from "@hiero-ledger/sdk";
import type {
  Client,
  ContractFunctionResult,
  ContractId,
  TransactionRecord,
} from "@hiero-ledger/sdk";
import { bytesToHex, decodeErrorResult, decodeFunctionResult } from "viem";
import type { Abi } from "viem";
import { readArtifact } from "./deployment.js";

/** Mirrors `QuorumPools.State`. Index is the on-chain enum value. */
export const POOL_STATES = ["Open", "Met", "Expired", "Released"] as const;
export type PoolState = (typeof POOL_STATES)[number];

/**
 * One pool's terms, as the contract stores them.
 *
 * `state` is the **stored** state, which is not always the effective one - a pool whose
 * deadline has passed reads `Open` until something stamps it (ADR 0004's lazy expiry). Ask
 * `statusOf` for the live answer; this is the terms, not the status.
 */
export interface PoolTerms {
  poolId: bigint;
  recipient: string;
  coordinator: string;
  unitTinybars: bigint;
  threshold: number;
  seats: number;
  /** Unix seconds. */
  deadline: number;
  state: PoolState;
  resourceUrl: string;
}

/** The shape `poolOf` returns once decoded, before it is narrowed into `PoolTerms`. */
interface RawPool {
  recipient: string;
  coordinator: string;
  unitTinybars: bigint;
  threshold: number;
  seats: number;
  deadline: bigint;
  state: number;
  resourceUrl: string;
}

/**
 * One recorded payment, as the contract holds it.
 *
 * Note what is *not* here: the Hedera transaction id it settled under. The contract hashes that
 * into its double-spend guard and keeps only the hash, so the id survives in the events alone -
 * which is why §8 needs an index to reach a deposit and cannot simply ask for one.
 */
export interface Deposit {
  /** The EVM address the payment was attributed to. What `claimRefund` matches on. */
  payer: string;
  tinybars: bigint;
  /** Whether it took a seat. False means it settled late: refundable at once, entitling nothing. */
  counted: boolean;
  refunded: boolean;
}

/** The shape `depositAt` returns once decoded. Same fields; `payer` is already a hex string. */

let abiCache: Abi | undefined;

/**
 * The compiled ABI, read once.
 *
 * Needed because `poolOf` returns a struct with a `string` in it, and the SDK's positional
 * getters cannot read that: the return data is a tuple holding a dynamic tuple, so every
 * word is one offset further along than its index suggests and `getString` resolves its
 * offset against the wrong base. Reading it wrong would not throw - it would hand back a
 * plausible pool with the fields shifted, which is the worst way for this to fail.
 */
function abi(): Abi {
  abiCache ??= readArtifact().abi as Abi;
  return abiCache;
}

/**
 * Gas limits, per call.
 *
 * Hedera refunds at most 20% of the limit, so an over-set limit is largely paid for - but an
 * INSUFFICIENT_GAS failure is paid for in full and lands nothing. These are sized a little
 * above what the calls use; every method here prints what it actually spent.
 */
const GAS = {
  createPool: 300_000,
  recordDeposit: 300_000,
  release: 200_000,
  // Both refund paths scan a deposit list and then transfer, and `_payout` forwards whatever
  // gas is left to the payer - so the floor is the scan and the ceiling is whoever is being
  // paid. These are sized for the plain accounts a pool of buyers actually holds. A payer
  // contract that burns gas in its `receive()` is what `refundAll`'s window exists to step
  // over, and stepping over it is the caller's move, not a larger number here.
  claimRefund: 300_000,
  // The one limit here that does not scale with what it is asked to do: `refundAll` takes a
  // caller-chosen window and this is flat. It is sized for the windows this project drives -
  // a pool's worth of deposits, single figures - where a refund costs tens of thousands of gas.
  // A caller passing a window in the hundreds has to raise it, and `maxDeposits` is precisely
  // what makes that the caller's problem to size rather than this constant's.
  refundAll: 500_000,
} as const;

/** Query payments are capped rather than left to the SDK default. Views cost cents. */
const MAX_QUERY_PAYMENT = new Hbar(1);
/** Enough for any call here, and under the ~21.47 HBAR ceiling the SDK mis-rejects. */
const MAX_TRANSACTION_FEE = new Hbar(20);

function long(value: bigint | number): Long {
  return Long.fromString(value.toString());
}

export interface CreatePoolParams {
  /** EVM address that receives the pool's total if the threshold is reached. */
  recipient: string;
  /** EVM address allowed to attribute payments to this pool - and allowed nothing else. */
  coordinator: string;
  unitTinybars: bigint;
  threshold: number;
  /** Unix seconds. */
  deadline: number;
  resourceUrl: string;
}

export interface CallResult {
  transactionId: string;
  gasUsed: bigint;
}

/** A completed call, with the result the record is required to carry. */
interface Call {
  record: TransactionRecord;
  result: ContractFunctionResult;
}

export class PoolsClient {
  constructor(
    private readonly client: Client,
    readonly contractId: ContractId,
  ) {}

  async createPool(params: CreatePoolParams): Promise<CallResult & { poolId: bigint }> {
    const args = new ContractFunctionParameters()
      .addAddress(params.recipient)
      .addAddress(params.coordinator)
      .addUint64(long(params.unitTinybars))
      .addUint32(params.threshold)
      .addUint64(long(params.deadline))
      .addString(params.resourceUrl);

    const call = await this.execute("createPool", GAS.createPool, args);
    return {
      ...summarise(call),
      poolId: BigInt(call.result.getUint256(0).toFixed()),
    };
  }

  /**
   * Attribute one settled x402 payment to a pool. `hederaTxId` is the settlement's own
   * transaction id, which the contract hashes to refuse the same payment twice.
   */
  async recordDeposit(params: {
    poolId: bigint;
    payer: string;
    tinybars: bigint;
    hederaTxId: string;
  }): Promise<CallResult & { depositId: bigint; counted: boolean }> {
    const args = new ContractFunctionParameters()
      .addUint256(long(params.poolId))
      .addAddress(params.payer)
      .addUint64(long(params.tinybars))
      .addString(params.hederaTxId);

    const call = await this.execute("recordDeposit", GAS.recordDeposit, args);
    return {
      ...summarise(call),
      depositId: BigInt(call.result.getUint256(0).toFixed()),
      counted: call.result.getBool(1),
    };
  }

  /** Permissionless: this client calls it, but so could anyone. */
  async release(poolId: bigint): Promise<CallResult> {
    const args = new ContractFunctionParameters().addUint256(long(poolId));
    return summarise(await this.execute("release", GAS.release, args));
  }

  /**
   * Take back every refundable deposit the operator of this client holds in a pool.
   *
   * The payer's own path, so **the client's operator is who gets paid** - not an argument,
   * because `msg.sender` is what the contract matches on and an address passed in here could
   * only ever disagree with the key that signed. Call it through a client whose operator is
   * the payer.
   *
   * Expires the pool on the way if the deadline has passed, so a refund never waits on anyone
   * having called `expire` - which is why that method is on the contract and not on this
   * client. Nothing needs to call it.
   *
   * Reverts `NothingToRefund` when the caller has no refundable deposit here: a pool that is
   * still open, a seat in a pool that met its threshold, or a deposit already refunded. The
   * revert is the answer, not a failure - `revertReasonOf` reads it back.
   */
  async claimRefund(poolId: bigint): Promise<CallResult & { tinybars: bigint }> {
    const args = new ContractFunctionParameters().addUint256(long(poolId));
    const call = await this.execute("claimRefund", GAS.claimRefund, args);
    return {
      ...summarise(call),
      tinybars: BigInt(call.result.getUint256(0).toFixed()),
    };
  }

  /**
   * Push refunds to the payers of deposits in `[startIndex, startIndex + maxDeposits)`.
   *
   * Permissionless, and the path that actually runs at a failed deadline: a buyer who spent
   * their HBAR on a seat may not hold the gas to claim it back, so somebody else pays for the
   * transaction and the money still goes only where the deposits say. The caller is not the
   * recipient of anything.
   *
   * Drive it by advancing `startIndex` a window at a time until it passes `depositCount`, not
   * by calling until it returns zero - the contract's own note on why. That instruction is
   * followable from here: `depositCount` is on this client for no other reason. Returns how
   * many deposits this call refunded, which on a window of already-refunded rows is
   * legitimately 0.
   */
  async refundAll(params: {
    poolId: bigint;
    startIndex: bigint;
    maxDeposits: bigint;
  }): Promise<CallResult & { refunded: bigint }> {
    const args = new ContractFunctionParameters()
      .addUint256(long(params.poolId))
      .addUint256(long(params.startIndex))
      .addUint256(long(params.maxDeposits));
    const call = await this.execute("refundAll", GAS.refundAll, args);
    return {
      ...summarise(call),
      refunded: BigInt(call.result.getUint256(0).toFixed()),
    };
  }

  async statusOf(poolId: bigint): Promise<PoolState> {
    const value = await this.query(
      "statusOf",
      new ContractFunctionParameters().addUint256(long(poolId)),
    );
    const state = POOL_STATES[value];
    // An enum value this client does not know is a contract it does not know. Reporting the
    // first state instead would be a plausible answer, which is the worst kind of wrong here.
    if (!state) throw new Error(`statusOf(${poolId}) returned unknown pool state ${value}`);
    return state;
  }

  /** How many pools exist. Pools are append-only, so this only ever grows. */
  async poolCount(): Promise<bigint> {
    return BigInt(
      (await this.queryUint256("poolCount", new ContractFunctionParameters())).toFixed(),
    );
  }

  /**
   * One pool's terms. Reverts `NoSuchPool` above `poolCount`, so callers bound the id first.
   */
  async poolOf(poolId: bigint): Promise<PoolTerms> {
    const args = new ContractFunctionParameters().addUint256(long(poolId));
    const data = await this.queryBytes("poolOf", args);
    const raw = decodeFunctionResult({
      abi: abi(),
      functionName: "poolOf",
      data,
    }) as unknown as RawPool;

    const state = POOL_STATES[raw.state];
    if (!state) throw new Error(`poolOf(${poolId}) returned unknown pool state ${raw.state}`);
    // `deadline` is a uint64 of unix seconds. It fits a JS number until the year 275760, and
    // every clock comparison downstream is against `Date.now()`, so it is narrowed once here
    // rather than at each of those call sites.
    return {
      poolId,
      recipient: raw.recipient,
      coordinator: raw.coordinator,
      unitTinybars: raw.unitTinybars,
      threshold: raw.threshold,
      seats: raw.seats,
      deadline: Number(raw.deadline),
      state,
      resourceUrl: raw.resourceUrl,
    };
  }

  /**
   * How many deposits a pool has recorded, counted and late alike.
   *
   * The bound `refundAll`'s window is driven against, and the only reason this is here - the
   * contract says to advance `startIndex` until it passes this number, and a caller that could
   * not read it had to call `depositAt` until it reverted instead. The index is no substitute:
   * the subgraph's `Pool` carries `seats`, which counts only the deposits that took one, and a
   * window sized from that would stop short of every late deposit - the rows that are
   * refundable in *every* state, and the ones most likely to be waiting.
   *
   * Reverts `NoSuchPool` above `poolCount`, so callers bound the id first.
   */
  async depositCount(poolId: bigint): Promise<bigint> {
    const args = new ContractFunctionParameters().addUint256(long(poolId));
    return BigInt((await this.queryUint256("depositCount", args)).toFixed());
  }

  /**
   * One deposit, by the index the log gave for it.
   *
   * §8 splits the lookup deliberately: the transaction id lives only in the events, so an index
   * resolves id to position - but `payer` and `counted`, the two facts entitlement turns on, are
   * read back from here. An indexer that lagged, or lied, can then at worst point at the wrong
   * row, and the row itself still comes from consensus state.
   *
   * Reverts `NoSuchDeposit` for an index the pool does not have. The caller does not bound the
   * index first on purpose: an index that names a row consensus lacks is an index disagreeing
   * with consensus, which is not an answer about the payer, and `redeem` reports it as a read
   * it could not make rather than as a missing seat.
   */
  async depositAt(poolId: bigint, depositId: bigint): Promise<Deposit> {
    const args = new ContractFunctionParameters()
      .addUint256(long(poolId))
      .addUint256(long(depositId));
    const data = await this.queryBytes("depositAt", args);
    // No conversion, unlike `poolOf`: every field of `depositAt` already decodes to the type
    // `Deposit` declares, so a field-by-field copy here would only mimic work it is not doing.
    return decodeFunctionResult({
      abi: abi(),
      functionName: "depositAt",
      data,
    }) as unknown as Deposit;
  }

  /** Tinybars this contract owes to payers and recipients. Never derived from its balance. */
  async committedTinybars(): Promise<bigint> {
    return BigInt(
      (await this.queryUint256("committedTinybars", new ContractFunctionParameters())).toFixed(),
    );
  }

  /** The contract's own view of its balance, in tinybars rather than weibars. */
  async balanceTinybars(): Promise<bigint> {
    return BigInt(
      (await this.queryUint256("balanceTinybars", new ContractFunctionParameters())).toFixed(),
    );
  }

  private async execute(fn: string, gas: number, args: ContractFunctionParameters): Promise<Call> {
    const response = await new ContractExecuteTransaction()
      .setContractId(this.contractId)
      .setGas(gas)
      .setMaxTransactionFee(MAX_TRANSACTION_FEE)
      .setFunction(fn, args)
      .execute(this.client);
    // The receipt would do for success, but the record carries the return value and the gas,
    // and a call whose return value nobody reads is a call nobody has checked.
    const record = await response.getRecord(this.client);
    const result = record.contractFunctionResult;
    // A record with no result means the call did not run as a contract call. Substituting a
    // default here would hand back a pool id of 0, or a deposit that took no seat, and the
    // next call would act on it as though it were an answer.
    if (!result) {
      throw new Error(`${fn} left no contract result on ${record.transactionId.toString()}`);
    }
    return { record, result };
  }

  private async query(fn: string, args: ContractFunctionParameters): Promise<number> {
    const result = await new ContractCallQuery()
      .setContractId(this.contractId)
      .setGas(50_000)
      .setMaxQueryPayment(MAX_QUERY_PAYMENT)
      .setFunction(fn, args)
      .execute(this.client);
    return result.getUint8(0);
  }

  /**
   * Which custom error a reverted call raised - `"Insolvent"`, `"DuplicateTransaction"`, and so on.
   *
   * A revert arrives as `CONTRACT_REVERT_EXECUTED`, which says only that the contract said no.
   * The reason is in the transaction record, and `getRecord` will not hand that over because it
   * validates the receipt status first - hence a second, non-validating query.
   *
   * Worth the extra round trip only because two of this contract's reverts mean opposite things
   * to a coordinator that has already settled a payment: `Insolvent` means try again, and
   * `DuplicateTransaction` means it already worked. Guessing between them either loses a
   * deposit or invents one.
   *
   * Returns `undefined` when the reason cannot be read. This runs on a path that is already
   * handling a failure, so it must not add one of its own.
   */
  async revertReasonOf(transactionId: string): Promise<string | undefined> {
    try {
      const record = await new TransactionRecordQuery()
        .setTransactionId(transactionId)
        .setValidateReceiptStatus(false)
        .setMaxQueryPayment(MAX_QUERY_PAYMENT)
        .execute(this.client);
      const errorMessage = record.contractFunctionResult?.errorMessage;
      if (!errorMessage) return undefined;
      const data = (errorMessage.startsWith("0x") ? errorMessage : `0x${errorMessage}`) as `0x${string}`;
      return decodeErrorResult({ abi: abi(), data }).errorName;
    } catch {
      return undefined;
    }
  }

  /** Raw return data, for anything the SDK's positional getters cannot decode - see `abi()`. */
  private async queryBytes(fn: string, args: ContractFunctionParameters): Promise<`0x${string}`> {
    const result = await new ContractCallQuery()
      .setContractId(this.contractId)
      .setGas(50_000)
      .setMaxQueryPayment(MAX_QUERY_PAYMENT)
      .setFunction(fn, args)
      .execute(this.client);
    return bytesToHex(result.asBytes());
  }

  private async queryUint256(fn: string, args: ContractFunctionParameters) {
    const result = await new ContractCallQuery()
      .setContractId(this.contractId)
      .setGas(50_000)
      .setMaxQueryPayment(MAX_QUERY_PAYMENT)
      .setFunction(fn, args)
      .execute(this.client);
    return result.getUint256(0);
  }
}

function summarise({ record, result }: Call): CallResult {
  return {
    transactionId: record.transactionId.toString(),
    gasUsed: BigInt(result.gasUsed.toString()),
  };
}
