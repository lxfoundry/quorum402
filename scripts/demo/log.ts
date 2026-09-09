/**
 * The exchange, written down as it happens, so the demo shows a protocol rather than a checkout.
 *
 * Everything interesting about this project is in the status codes: a 402 that names a pool, a
 * **202** that exists nowhere else in x402 because `conditional` needs an answer meaning "paid,
 * and the resource may never be owed", and a 200 that arrives for one buyer at the moment the
 * crowd completes. A UI that showed only seats filling would hide all of it.
 *
 * A ring buffer, not a transcript. It is read by a page that renders the tail of it beside the
 * product, and a demo session that ran all afternoon should cost the same memory as one that just
 * started.
 */

/** Which side of the conversation a line is. Rendered as a marker, not as prose. */
export type LogDirection = "out" | "in" | "chain";

export interface LogEntry {
  /** Unix milliseconds. Formatted by the page, in the viewer's own timezone. */
  at: number;
  direction: LogDirection;
  /** Who acted. Absent for anything not attributable to one wallet. */
  wallet?: string;
  /** The HTTP status, where the line is a response. */
  status?: number;
  text: string;
}

/**
 * How many lines the page shows, and therefore how many are worth keeping.
 *
 * One number rather than two: a buffer that held more than the only reader ever asks for would
 * retain lines that can never be displayed, and invite the question which bound governs.
 */
const KEEP = 12;

export class ProtocolLog {
  private readonly entries: LogEntry[] = [];

  /** A request this demo made on a wallet's behalf. */
  request(wallet: string, text: string): void {
    this.push({ direction: "out", wallet, text });
  }

  /** What came back, and its status - the part worth reading. */
  response(status: number, text: string): void {
    this.push({ direction: "in", status, text });
  }

  /**
   * Something that happened on the ledger rather than over HTTP.
   *
   * Kept distinct from a response because it is the point of several of these lines: opening a
   * pool, releasing one and claiming a refund never touch the coordinator at all, and a log that
   * rendered them identically would suggest they did.
   */
  chain(text: string, wallet?: string): void {
    this.push({ direction: "chain", wallet, text });
  }

  /** Newest last, so the page reads downward like a terminal. */
  tail(): LogEntry[] {
    return [...this.entries];
  }

  private push(entry: Omit<LogEntry, "at">): void {
    this.entries.push({ at: Date.now(), ...entry });
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
  }
}
