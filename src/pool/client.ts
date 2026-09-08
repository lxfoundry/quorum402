/**
 * Calling the pool contract from Hedera's own API, rather than through a JSON-RPC relay.
 *
 * The contract is reached with `ContractExecuteTransaction` for the same reason it is
 * deployed with the SDK (see `scripts/deploy.ts`): everything else in this project speaks
 * Hedera entity ids, and a relay would be a second way of talking to the same contract with
 * its own account model and its own failures.
 *
 * Only what the coordinator and a demo need is here. Refunds are a payer's business and go
 * through the payer's own key, so they are not on this client.
 */
import {
  ContractCallQuery,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  Long,
} from "@hiero-ledger/sdk";
import type {
  Client,
  ContractFunctionResult,
  ContractId,
  TransactionRecord,
} from "@hiero-ledger/sdk";

/** Mirrors `QuorumPools.State`. Index is the on-chain enum value. */
export const POOL_STATES = ["Open", "Met", "Expired", "Released"] as const;
export type PoolState = (typeof POOL_STATES)[number];

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
