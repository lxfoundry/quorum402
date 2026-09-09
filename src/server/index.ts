/**
 * The coordinator: an x402 resource server for quorum-gated resources.
 *
 * Implements `quorum-scheme.md` §6's lifecycle. The status codes are the specification's, and
 * the one that does not exist anywhere else in x402 is **202** - settled, and the resource is
 * still pending, because the crowd has not arrived yet. Every other flow either delivers or
 * fails; `conditional` needs a third answer.
 *
 * It holds no database. Which pool a URL is selling, what it costs, who has paid and whether
 * the threshold is met are all read from the chain, so a restart loses nothing but a cache.
 */
import { pathToFileURL } from "node:url";
import express from "express";
import type { Express, Request, Response } from "express";
import {
  AccountId,
  Client,
  ContractId,
  PrivateKey,
} from "@hiero-ledger/sdk";
import {
  BENCHMARKS,
  benchmarkFor,
  describe as describeBenchmark,
  licence,
  resourceUrlFor,
} from "../benchmark/catalogue.js";
import { caip2, loadConfig } from "../config.js";
import { balanceTinybars, evmAddressOf } from "../hedera/mirror.js";
import { PoolsClient } from "../pool/client.js";
import type { PoolState, PoolTerms } from "../pool/client.js";
import { readDeployment } from "../pool/deployment.js";
import { Facilitator } from "../x402/facilitator.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  QUORUM_RECEIPT_HEADER,
  encodeHeaderValue,
} from "../x402/http.js";
import type { Network, QuorumRequirements } from "../x402/types.js";
import { FailureReporter } from "./failures.js";
import { inspectBindingTransfer } from "./payer.js";
import { bindingRequestFor, validateQuorumPayload } from "./payment.js";
import { PoolRegistry } from "./pools.js";
import { preflight } from "./preflight.js";
import type { SolvencyReader } from "./preflight.js";
import { buildReceipt } from "./receipt.js";
import { settleAndRecord } from "./record.js";
import { bindingRequirements, paymentRequired, quorumRequirements } from "./requirements.js";

export interface ServerDeps {
  registry: PoolRegistry;
  pools: SolvencyReader &
    Pick<PoolsClient, "recordDeposit" | "revertReasonOf" | "poolOf" | "statusOf">;
  facilitator: Pick<Facilitator, "verify" | "settle" | "feePayerFor">;
  failures: FailureReporter;
  network: Network;
  /** The pool contract's Hedera account id - what a payment is addressed to. */
  payTo: string;
  contractId: string;
  publicBaseUrl: string;
  coordinatorAccountId: string;
  coordinatorAddress: string;
  evmAddressOf: (accountId: string) => Promise<string>;
  coordinatorBalanceTinybars: () => Promise<bigint>;
  /** Retry knobs, so a test does not wait out the backoff. */
  record?: { sleep?: (ms: number) => Promise<void>; attempts?: number; retryMs?: number };
}

export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, network: deps.network, contract: deps.contractId });
  });

  /** What is on offer, so a reader can find a resource without reading the source. */
  app.get("/", (_req, res) => {
    res.json({
      service: "quorum402",
      network: deps.network,
      contract: deps.contractId,
      benchmarks: BENCHMARKS.map((benchmark) => ({
        slug: benchmark.slug,
        url: resourceUrlFor(deps.publicBaseUrl, benchmark.slug),
        description: describeBenchmark(benchmark),
      })),
    });
  });

  app.get("/benchmark/:slug", (req, res) => {
    // Express 4 does not catch a rejection from an async handler. Unhandled, it leaves the
    // payer waiting on a response that never comes and takes the process down with it - so
    // every request in flight pays for one request's bad luck. A 500 is a worse answer than
    // the one `handle` meant to send, and a better one than none.
    handle(deps, req, res).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`GET ${req.originalUrl} failed: ${detail}`);
      // Past settlement `handle` has already set PAYMENT-RESPONSE, and sending it with the
      // 500 is deliberate: it carries the transaction id, which is the payer's evidence that
      // their money moved even though the receipt did not survive being built.
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(500).json({ error: "the coordinator could not serve this request", detail });
    });
  });

  return app;
}

async function handle(deps: ServerDeps, req: Request, res: Response): Promise<void> {
  const slug = req.params.slug ?? "";
  const benchmark = benchmarkFor(slug);
  if (!benchmark) {
    res.status(404).json({ error: `no such benchmark "${slug}"` });
    return;
  }
  const resourceUrl = resourceUrlFor(deps.publicBaseUrl, slug);

  // Redemption is §8 and is not built here yet. Saying so beats answering as though the header
  // had not been sent, which would hand back a 402 and read as "pay again".
  if (req.get(QUORUM_RECEIPT_HEADER)) {
    res.status(501).json({
      error: "redemption is not implemented on this build",
      detail: `${QUORUM_RECEIPT_HEADER} is quorum-scheme.md §8. Entitlement is derived from chain state, so a seat remains redeemable once it is.`,
    });
    return;
  }

  const selling = await deps.registry.sellingPoolFor(resourceUrl);
  const signature = req.get(PAYMENT_SIGNATURE_HEADER);

  // §6 row 1. A pool that exists but is closed is not an open pool naming this URL, so without
  // a payment in hand the answer is the same as if none had ever existed.
  if (!selling || (!selling.available && !signature)) {
    res.status(404).json({ error: `no open pool is selling ${resourceUrl}` });
    return;
  }

  const { terms } = selling;
  // Never hardcoded, and read per request rather than cached: it is the facilitator's to
  // rotate, and a stale one produces a payment that cannot settle.
  const feePayer = await deps.facilitator.feePayerFor(deps.network);
  const offer = {
    terms,
    network: deps.network,
    payTo: deps.payTo,
    feePayer,
    description: describeBenchmark(benchmark),
  };

  if (!signature) {
    res
      .status(402)
      .set(PAYMENT_REQUIRED_HEADER, encodeHeaderValue(paymentRequired(offer)))
      .json({
        error: "payment required",
        detail: describeBenchmark(benchmark),
        pool: poolSummary(terms, selling.state),
      });
    return;
  }

  const advertised: QuorumRequirements = quorumRequirements(offer);
  const validation = validateQuorumPayload({ header: signature, advertised });
  if (!validation.ok) {
    res.status(400).json({ error: "payment does not match the advertised terms", ...detail(validation) });
    return;
  }

  // §6 row 4, and §7 rule 2: the pool closed between the 402 and this payment. Caught here,
  // before anything irreversible, so the payer keeps their money.
  if (!selling.available) {
    res.status(402).json({
      error: "this pool is no longer selling",
      reason: selling.reason,
      pool: poolSummary(terms, selling.state),
    });
    return;
  }

  const transfer = inspectBindingTransfer({
    transactionBase64: validation.payload.payload.binding.transaction,
    payTo: deps.payTo,
    amount: terms.unitTinybars,
  });
  if (!transfer.ok) {
    res.status(400).json({ error: "the payment's transfer is not the one advertised", ...detail(transfer) });
    return;
  }

  // §7 rule 5, run early because `recordDeposit` needs the address and a payer it cannot
  // resolve is a deposit it could not attribute (ADR 0006).
  let payer: string;
  try {
    payer = await deps.evmAddressOf(transfer.transfer.payerAccountId);
  } catch (error) {
    res.status(402).json({
      error: "the paying account has no address this contract could refund",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const gate = await preflight(
    {
      contract: deps.pools,
      coordinatorAccountId: deps.coordinatorAccountId,
      coordinatorAddress: deps.coordinatorAddress,
      coordinatorBalanceTinybars: deps.coordinatorBalanceTinybars,
    },
    { availability: selling, hederaTxId: transfer.transfer.transactionId },
  );
  if (!gate.ok) {
    res.status(402).json({ error: "this payment cannot be settled right now", ...detail(gate) });
    return;
  }

  const binding = bindingRequirements(offer);
  const outcome = await settleAndRecord(
    {
      facilitator: deps.facilitator,
      pools: deps.pools,
      failures: deps.failures,
      ...deps.record,
    },
    {
      request: bindingRequestFor({
        payload: validation.payload,
        resource: validation.payload.resource,
        binding,
      }),
      requirements: binding,
      poolId: terms.poolId,
      payer,
      payerAccountId: transfer.transfer.payerAccountId,
      tinybars: transfer.transfer.tinybars,
      expectedTxId: transfer.transfer.transactionId,
    },
  );

  if (!outcome.settled) {
    // §6 row 5. Nothing moved, so this is still a payment challenge rather than a failure.
    res
      .status(402)
      .set(PAYMENT_RESPONSE_HEADER, encodeHeaderValue({ success: false, errorReason: outcome.reason }))
      .json({ error: "the payment was not settled", detail: outcome.reason });
    return;
  }

  // Past here the money has moved and the request does not fail - §7 rule 6.
  const [after, state] = await Promise.all([
    deps.pools.poolOf(terms.poolId),
    deps.pools.statusOf(terms.poolId),
  ]);
  const counted = outcome.attributed ? (outcome.deposit?.counted ?? null) : null;
  const receipt = buildReceipt({
    terms: after,
    state,
    seats: after.seats,
    payer,
    transaction: outcome.hederaTxId,
    attributed: outcome.attributed,
    counted,
    contractId: deps.contractId,
  });

  // The buyer's account is deliberately absent from PAYMENT-RESPONSE. In this binding `payer`
  // means the fee payer, and putting the buyer there would be a lie told in the protocol's own
  // vocabulary. Attribution lives in the receipt, where it is unambiguous.
  res.set(
    PAYMENT_RESPONSE_HEADER,
    encodeHeaderValue({ success: true, transaction: outcome.hederaTxId, network: deps.network }),
  );

  // §6 row 7: settled, and *this* payment met the threshold. The pool reaches `Met` exactly
  // when the last seat is taken, so a counted deposit into a now-met pool is the one that did
  // it. Delivery is on the threshold, never on the seller having been paid - §6.
  if (counted === true && after.seats >= after.threshold) {
    res.status(200).json({
      ...licence({
        benchmark,
        contributors: after.seats,
        minimumContributors: after.threshold,
        licensee: transfer.transfer.payerAccountId,
        poolId: after.poolId.toString(),
        settledUnder: outcome.hederaTxId,
      }),
      receipt,
    });
    return;
  }

  // §6 row 6, and the row that only exists because of `conditional`: the payment is real, the
  // resource is not owed yet, and may never be.
  res.status(202).json(receipt);
}

function poolSummary(terms: PoolTerms, state: PoolState) {
  return {
    poolId: terms.poolId.toString(),
    state,
    filled: terms.seats,
    threshold: terms.threshold,
    deadline: terms.deadline,
    unitTinybars: terms.unitTinybars.toString(),
  };
}

function detail(rejection: { reason: string; detail: string }) {
  return { reason: rejection.reason, detail: rejection.detail };
}

/** Build the real thing from configuration, and listen. */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const network = caip2(cfg.network);
  const deployment = readDeployment(network);
  if (!deployment) throw new Error(`no deployment recorded for ${network}. Run: npm run deploy`);

  const client = cfg.network === "testnet" ? Client.forTestnet() : Client.forMainnet();
  client.setOperator(
    AccountId.fromString(cfg.operatorId),
    PrivateKey.fromStringECDSA(cfg.operatorKey),
  );
  const pools = new PoolsClient(client, ContractId.fromString(deployment.contractId));
  const coordinatorAddress = await evmAddressOf(cfg.mirrorUrl, cfg.operatorId);

  const app = createApp({
    registry: new PoolRegistry(pools),
    pools,
    facilitator: new Facilitator(cfg.facilitatorUrl),
    failures: new FailureReporter({ webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() }),
    network,
    payTo: deployment.contractId,
    contractId: deployment.contractId,
    publicBaseUrl: cfg.publicBaseUrl,
    coordinatorAccountId: cfg.operatorId,
    coordinatorAddress,
    evmAddressOf: (accountId) => evmAddressOf(cfg.mirrorUrl, accountId),
    coordinatorBalanceTinybars: () => balanceTinybars(cfg.mirrorUrl, cfg.operatorId),
  });

  app.listen(cfg.port, () => {
    console.log(`\nquorum402 coordinator on ${network}\n`);
    console.log(`  listening    http://localhost:${cfg.port}`);
    console.log(`  public url   ${cfg.publicBaseUrl}`);
    console.log(`  contract     ${deployment.contractId}`);
    console.log(`  coordinator  ${cfg.operatorId}  ${coordinatorAddress}`);
    console.log(`  facilitator  ${cfg.facilitatorUrl}`);
    for (const benchmark of BENCHMARKS) {
      console.log(`  selling      ${resourceUrlFor(cfg.publicBaseUrl, benchmark.slug)}`);
    }
    console.log();
  });
}

// Only when run directly. Importing this module for `createApp` - which the tests do - must
// not start a listener.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
