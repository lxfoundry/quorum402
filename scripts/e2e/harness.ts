/**
 * The scaffolding an end-to-end run needs and the unit suite deliberately does not.
 *
 * `test/server-lifecycle.ts` drives the same server over a real listener with every dependency
 * below HTTP stubbed, which is the right shape for asking "does the status table hold". This
 * asks a different question - does the whole thing work against Hedera testnet, the Blocky402
 * facilitator and the live subgraph - so nothing here is stubbed and everything here waits.
 *
 * Waiting is most of the difference. A unit test knows the answer the moment it asks; a run
 * against three networks with independent lag has to poll, and has to say what it is waiting
 * for while it does, or a stall looks identical to a hang.
 */
import type { AddressInfo } from "node:net";
import type { Benchmark } from "../../src/benchmark/catalogue.js";
import type { Config } from "../../src/config.js";
import { createApp } from "../../src/server/index.js";
import type { ServerDeps } from "../../src/server/index.js";
import type { GeneratedAccount } from "../create-accounts.js";

const TINYBARS_PER_HBAR = 100_000_000n;

/**
 * What every scenario needs to run: who is on the network, who is buying, and what a seat costs.
 *
 * Shared rather than declared per scenario, because the two runs sell the same resource to the
 * same cast and differ only in how many of them turn up. `ttlSeconds` is the exception worth
 * naming - it is a ceiling in the met run and the run's own length in the missed one, so each
 * scenario names its own default and `index.ts` chooses.
 */
export interface ScenarioParams {
  cfg: Config;
  benchmark: Benchmark;
  contractId: string;
  /** The pool's size. Whether they all pay is what separates the scenarios. */
  buyers: GeneratedAccount[];
  recipient: GeneratedAccount;
  seatPriceTinybars: bigint;
  ttlSeconds: number;
}

/**
 * Progress, and whether anything went wrong, in `check-payout.ts`'s idiom.
 *
 * Counts failures rather than throwing, for the reason that script gives: one bad assertion
 * partway through is worth knowing about alongside the ones after it, and a run that stops at
 * the first surprise reports one problem per invocation on a path where each invocation costs
 * real HBAR and several minutes.
 */
export class Reporter {
  #failures = 0;

  get failures(): number {
    return this.#failures;
  }

  /** A named stage. Blank line before, so the log reads as phases rather than a stream. */
  step(title: string): void {
    console.log(`\n${title}`);
  }

  ok(message: string): void {
    console.log(`  ok    ${message}`);
  }

  bad(message: string): void {
    this.#failures++;
    console.log(`  FAIL  ${message}`);
  }

  info(message: string): void {
    console.log(`        ${message}`);
  }

  /** Assert, and keep going. Returns the verdict so a caller can branch on it. */
  expect(condition: boolean, pass: string, fail: string): boolean {
    if (condition) this.ok(pass);
    else this.bad(fail);
    return condition;
  }
}

/** Tinybars as HBAR, for humans. Exact - no float goes near it. */
export function hbar(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const absolute = negative ? -tinybars : tinybars;
  const whole = absolute / TINYBARS_PER_HBAR;
  const frac = (absolute % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""} HBAR`;
}

/** A coordinator listening on a port nothing else owns. */
export interface Coordinator {
  /** Where it answers, and - because a pool stores its resource URL - who it answers for. */
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Start the real coordinator on an ephemeral port.
 *
 * The port is load-bearing rather than a convenience. A pool records its `resourceUrl` at
 * creation and `PoolRegistry.sellingPoolFor` hands a URL to the *earliest pool still selling
 * on it*, so a run that reused a fixed base URL could have its buyers captured by an Open pool
 * left behind by an earlier run that died before releasing. A fresh port is a fresh URL, which
 * no previous pool can name - so each run gets a pool of its own by construction rather than
 * by remembering to clean up. It also means a run never collides with a `npm run server`.
 *
 * `deps.publicBaseUrl` is filled in after the bind, which needs one word of justification:
 * `createApp` closes over this object and reads the field per request, and no request can
 * happen until this function has returned the URL to make one against. So there is no window
 * in which the server could answer with the placeholder - the ordering is causal, not lucky.
 */
export async function startCoordinator(deps: ServerDeps): Promise<Coordinator> {
  const server = createApp(deps).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  deps.publicBaseUrl = baseUrl;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface AwaitOptions {
  attempts?: number;
  intervalMs?: number;
}

/**
 * One look at the index: what was found, and how far it has read.
 *
 * Both come back together because the index returns them together - the case that needs the
 * head is the one where there is nothing found, so asking separately would double the cost of
 * exactly the poll that repeats.
 */
export interface Look<T> {
  value?: T;
  /** Progress to report while waiting, so a stall is diagnosable rather than silent. */
  progress?: string;
}

/**
 * Poll until something the index has not seen yet shows up.
 *
 * The counterpart to `awaitBalance` for the subgraph, and it lives here rather than in
 * `src/graph/client.ts` on purpose: the coordinator never waits on the index - `redeem.ts`
 * answers 404 with the indexed block attached and lets the payer retry - and giving the
 * production client a blocking helper would invite exactly the coupling §8 avoids.
 *
 * Returns `undefined` when it gives up, so the caller reports the timeout in its own terms.
 */
export async function awaitIndexed<T>(
  report: Reporter,
  what: string,
  read: () => Promise<Look<T>>,
  options: AwaitOptions = {},
): Promise<T | undefined> {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 3_000;
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A read that throws is the index being unreachable, which is worth saying out loud and
    // is not worth giving up over - graph-node restarts, and the next poll may well succeed.
    let look: Look<T> = {};
    try {
      look = await read();
    } catch (error) {
      report.info(`${what}: index unreachable (${(error as Error).message})`);
    }
    // Compared against `undefined` rather than tested for truth: a deposit id is a position,
    // and the first position in a pool is 0.
    if (look.value !== undefined) {
      report.ok(`${what} after ${elapsed()}s`);
      return look.value;
    }
    // Every fourth attempt, so a two-minute wait is a handful of lines and not forty.
    if (attempt % 4 === 0) {
      report.info(
        `waiting for ${what} - ${elapsed()}s` + (look.progress ? `, ${look.progress}` : ""),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}
