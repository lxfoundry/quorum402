/**
 * Where a payment that settled but could not be attributed gets written down.
 *
 * [ADR 0006](../../specs/adr/0006-nothing-settles-until-recording-can-succeed.md) §4. The
 * coordinator keeps no database, on purpose - `quorum-scheme.md` §8 derives entitlement from
 * chain state so a restart loses nothing - and a failure log is the one thing that wants to be
 * durable. Giving it a private store would put the system's only piece of invisible state
 * exactly where its failures are.
 *
 * The layer built here is the floor: one structured line, written synchronously, before
 * anything else is attempted. It cannot fail, which is why it goes first. The durable queue
 * chosen in ADR 0006 is an HCS topic, and it is **not built** - a Hedera transaction cannot be
 * the floor, because a coordinator that cannot pay to record a deposit cannot pay to record
 * that it could not. Every field a drain needs is here, so the queue can be added behind this
 * same call site without changing what is logged.
 */
import { writeSync } from "node:fs";

/** Everything `npm run record` needs to finish the job by hand. */
export interface FailedAttribution {
  poolId: string;
  /** The payer's EVM address - what `recordDeposit` takes and what `claimRefund` matches. */
  payer: string;
  /** The payer's Hedera account id, for a human reading the log. */
  payerAccountId: string;
  tinybars: string;
  hederaTxId: string;
  error: string;
}

export interface FailureReporterOptions {
  /**
   * Injectable so tests can read what was written. The default writes to fd 2 with
   * `writeSync`, not `process.stderr.write`, which is asynchronous when stderr is a pipe -
   * and a line that is still buffered when the process dies is a line that was never written.
   */
  write?: (line: string) => void;
  /** Fire-and-forget alert. Optional, and never allowed to throw into the request path. */
  webhookUrl?: string;
}

export class FailureReporter {
  private readonly write: (line: string) => void;

  constructor(private readonly options: FailureReporterOptions = {}) {
    this.write = options.write ?? ((line) => writeSync(2, line));
  }

  /**
   * Record a settled payment that could not be attributed.
   *
   * Returns nothing and throws nothing. It is called on a path that has already taken a
   * payer's money, where §7 rule 6 forbids failing the request, so a reporter that could throw
   * would be able to destroy the receipt that is the payer's only evidence.
   */
  attributionFailed(failure: FailedAttribution): void {
    const line = JSON.stringify({
      event: "attribution-failed",
      at: new Date().toISOString(),
      retry: `npm run record -- ${failure.poolId} ${failure.payer} ${failure.tinybars} ${failure.hederaTxId}`,
      ...failure,
    });
    try {
      this.write(line + "\n");
    } catch {
      // Nothing sensible is left to do. Losing the line is bad; failing the request after the
      // money moved is worse, and it is the payer rather than the operator who pays for it.
    }
    this.alert(line);
  }

  private alert(line: string): void {
    const url = this.options.webhookUrl;
    if (!url) return;
    // Deliberately not awaited. The payer is waiting on a response, and a slow webhook must
    // not be able to hold it up or to fail it.
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `quorum402 could not attribute a settled payment: ${line}` }),
    }).catch(() => {
      // An alert nobody receives is the second failure of a pair. The first is already logged.
    });
  }
}
