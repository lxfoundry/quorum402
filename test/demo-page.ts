/**
 * The demo page, driven in a stubbed DOM.
 *
 * `public/app.js` runs in a browser, so nothing else in this suite reaches it - and it is where
 * the page's whole concurrency model lives: the wait counter, the guard that stops two reads
 * overlapping, the sequence number that orders their answers, the seller's form kept across
 * renders. Those are behaviours over *repeated* renders, which is the kind that survives review
 * of any single diff and breaks where two separately-correct commits meet.
 *
 * So the real file is loaded here and driven: reads answer or fail on command, the poll fires by
 * hand, the wallet changes mid-read. What this can prove is that the logic is right. What it
 * cannot prove is that a browser agrees - `replaceChildren` detaching a node it already holds is
 * modelled here from the specification, not observed - so it stands beside opening the page
 * rather than instead of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SOURCE = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

type Child = StubNode | string | number;

/**
 * Enough of an element for `app.js`, and no more.
 *
 * `detaches` is why this is a class rather than a bag of objects: `replaceChildren` is specified
 * as remove-all-then-insert, so it detaches a node it was handed back. That is invisible in a
 * rendered page and it is what closes an open dropdown, so it is counted.
 */
class StubNode {
  readonly childNodes: StubNode[] = [];
  parentNode: StubNode | null = null;
  hidden = false;
  disabled = false;
  detaches = 0;
  scrollTop = 0;
  readonly scrollHeight = 0;
  onchange: ((event: { target: { value: string } }) => void) | null = null;
  onclick: (() => void) | null = null;

  private own = "";
  private selected: string | undefined;
  private classes = new Set<string>();

  constructor(readonly tagName: string) {}

  get firstChild(): StubNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): StubNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  /** `renderWallets` counts these to decide whether to rebuild the list. */
  get options(): StubNode[] {
    return this.childNodes;
  }

  /** True only while this node can be reached from `<body>`, as in a real document. */
  get isConnected(): boolean {
    let root = this.parentNode;
    if (!root) return this.tagName === "body";
    while (root.parentNode) root = root.parentNode;
    return root.tagName === "body";
  }

  get classList() {
    return {
      add: (name: string): void => void this.classes.add(name),
      remove: (name: string): void => void this.classes.delete(name),
      contains: (name: string): boolean => this.classes.has(name),
    };
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get textContent(): string {
    return this.own || this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.own = String(value);
    for (const child of [...this.childNodes]) this.detach(child);
  }

  get value(): string {
    return this.selected ?? this.firstChild?.value ?? "";
  }

  set value(next: string) {
    this.selected = String(next);
  }

  append(...children: Child[]): void {
    for (const child of children) this.attach(child);
  }

  replaceChildren(...children: Child[]): void {
    for (const child of [...this.childNodes]) this.detach(child);
    // A real <select> falls back to its first option when its options are replaced.
    this.selected = undefined;
    for (const child of children) this.attach(child);
  }

  remove(): void {
    this.parentNode?.detach(this);
  }

  private attach(child: Child): void {
    const node = child instanceof StubNode ? child : textNode(String(child));
    node.parentNode?.detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  private detach(child: StubNode): void {
    const at = this.childNodes.indexOf(child);
    if (at < 0) return;
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    child.detaches += 1;
  }
}

function textNode(value: string): StubNode {
  const node = new StubNode("#text");
  node.textContent = value;
  return node;
}

class StubOption extends StubNode {
  constructor(label: string, value: string) {
    super("option");
    this.textContent = label;
    this.value = value;
  }
}

/** One read of `/demo/api/state`, held open until the test says what becomes of it. */
interface Read {
  ok(payload: unknown): void;
  fail(): void;
}

interface Page {
  readonly requests: string[];
  readonly body: StubNode;
  byId(id: string): StubNode;
  /** The next read still in flight. */
  next(): Read;
  /** Fire the four-second poll by hand. */
  poll(): void;
  /** Change wallet, as the header's `<select>` does. */
  choose(label: string): void;
}

function loadPage(wallet = "buyer1"): Page {
  const ids = new Map<string, StubNode>();
  const body = new StubNode("body");
  // The two things index.html ships in its markup, and only those.
  body.className = "busy";
  const stale = new StubNode("div");
  stale.hidden = true;
  ids.set("stale", stale);

  const requests: string[] = [];
  const reads: Read[] = [];
  const stored = new Map<string, string>([["quorum402.wallet", wallet]]);
  let timer: (() => void) | undefined;

  const byId = (id: string): StubNode => {
    const found = ids.get(id);
    if (found) return found;
    const made = new StubNode("div");
    ids.set(id, made);
    return made;
  };

  const sandbox: Record<string, unknown> = {
    // The page logs a failed read before signalling it. Failures here are driven deliberately,
    // so the noise is not a result.
    console: { error: () => {} },
    document: {
      body,
      getElementById: byId,
      createElement: (tag: string) => new StubNode(tag),
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    window: { alert: () => {} },
    Option: StubOption,
    AbortSignal: { timeout: () => ({}) },
    setInterval: (fn: () => void) => {
      timer = fn;
      return 0;
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearInterval: () => {},
    fetch: (url: string) =>
      new Promise<unknown>((resolve, reject) => {
        requests.push(url);
        reads.push({
          ok: (payload) => resolve({ ok: true, json: () => Promise.resolve(payload) }),
          fail: () => reject(new Error("the coordinator is not answering")),
        });
      }),
    Map,
    Set,
    Date,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Error,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "public/app.js" });

  return {
    requests,
    body,
    byId,
    next: () => {
      const read = reads.shift();
      if (!read) throw new Error("no read was in flight");
      return read;
    },
    poll: () => {
      if (!timer) throw new Error("the page registered no poll");
      timer();
    },
    choose: (label) => {
      const select = byId("wallet");
      if (!select.onchange) throw new Error("the wallet select has no handler");
      select.onchange({ target: { value: label } });
    },
  };
}

/** Lets every promise the page is holding settle before the next assertion. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const WALLETS = [
  { label: "buyer1", role: "buyer", hbar: "20", accountId: "0.0.1001", accountUrl: "", evmAddress: "0x1" },
  { label: "buyer2", role: "buyer", hbar: "19", accountId: "0.0.1002", accountUrl: "", evmAddress: "0x2" },
  { label: "seller", role: "seller", hbar: "20", accountId: "0.0.1003", accountUrl: "", evmAddress: "0x3" },
];

function openPool(poolId: string) {
  return {
    poolId,
    state: "Open",
    filled: 2,
    threshold: 3,
    seatHbar: "1",
    unitTinybars: "100000000",
    available: true,
    reason: null,
    secondsLeft: 600,
  };
}

function service(slug: string, pool: ReturnType<typeof openPool> | null = null) {
  return {
    slug,
    description: "a benchmark",
    pool,
    poolCount: pool ? 1 : 0,
    thresholds: [3, 4],
    cut: { capability: "spend", tier: "eu", region: "eu" },
  };
}

function heldSeat(poolId: string, seat: number) {
  return {
    poolId,
    slug: "alpha",
    transaction: "0.0.1001@1788945000.000000000",
    transactionUrl: "",
    seat,
    counted: true,
    refunded: false,
    indexed: true,
    state: "Open",
    storedState: "Open",
    filled: 2,
    threshold: 3,
    secondsLeft: 600,
    action: "none",
  };
}

function stateFor(
  services: ReturnType<typeof service>[],
  seats: ReturnType<typeof heldSeat>[] = [],
) {
  return {
    network: "testnet",
    contract: "0.0.1",
    contractUrl: "",
    facilitator: "",
    subgraph: "",
    publicBaseUrl: "",
    wallets: WALLETS,
    choices: {
      ttl: [{ seconds: 600, label: "10 minutes" }],
      seatHbar: [{ hbar: "1", label: "1 ℏ" }],
    },
    services,
    seats,
    seatsElsewhere: 0,
    seatsCapped: false,
    log: [],
  };
}

/** A page that has completed its cold start and is showing `services`. */
async function showing(
  services: ReturnType<typeof service>[],
  seats: ReturnType<typeof heldSeat>[] = [],
) {
  const page = loadPage();
  page.next().ok(stateFor(services, seats));
  await settled();
  return page;
}

function cardIn(page: Page, id: string): StubNode {
  const card = page.byId(id).firstChild;
  if (!card) throw new Error(`nothing rendered into #${id}`);
  return card;
}

function childWithClass(node: StubNode, className: string): StubNode {
  const found = node.childNodes.find((child) => child.className === className);
  if (!found) throw new Error(`no .${className} under a ${node.tagName}`);
  return found;
}

describe("the demo page", () => {
  describe("reads in flight", () => {
    it("does not swallow a read the user asked for", () => {
      // The poll's guard and the wallet switch's own refresh arrived in separate commits. The
      // guard belongs to the poll; applied to every caller it drops the one read the user is
      // actually waiting on.
      const page = loadPage();
      assert.equal(page.requests.length, 1);
      assert.match(page.requests[0] ?? "", /wallet=buyer1/);

      page.choose("buyer2");

      assert.equal(page.requests.length, 2, "the switch issued no read of its own");
      assert.match(page.requests[1] ?? "", /wallet=buyer2/);
    });

    it("discards an answer overtaken while it was in flight", async () => {
      // `render` reads the *current* wallet for the name and balance and takes the seats from
      // `state`, so rendering a stale answer puts one buyer's identity above another's seats.
      const page = loadPage();
      const first = page.next();
      page.choose("buyer2");
      const second = page.next();

      first.ok(stateFor([service("alpha"), service("beta")]));
      await settled();
      assert.equal(page.byId("services").childNodes.length, 0, "the overtaken answer was rendered");

      second.ok(stateFor([service("alpha")]));
      await settled();
      assert.equal(page.byId("services").childNodes.length, 1);
      assert.equal(page.body.classList.contains("busy"), false, "the page stayed blocked");
    });
  });

  describe("the seller's form", () => {
    it("is not detached by a poll", async () => {
      // Keeping the node across renders preserves its selections. Leaving it *attached* is what
      // preserves focus and an open dropdown, which `replaceChildren` would take.
      const page = await showing([service("alpha")]);
      page.choose("seller");
      page.next().ok(stateFor([service("alpha")]));
      await settled();

      const form = cardIn(page, "right");
      const before = form.detaches;

      for (let poll = 0; poll < 2; poll++) {
        page.poll();
        page.next().ok(stateFor([service("alpha")]));
        await settled();
      }

      assert.equal(form.detaches, before, "a poll detached the seller's form");
      assert.equal(page.byId("right").firstChild, form);
    });

    it("comes back as the same node after a trip to a buyer's screen", async () => {
      const page = await showing([service("alpha")]);
      page.choose("seller");
      page.next().ok(stateFor([service("alpha")]));
      await settled();
      const form = cardIn(page, "right");

      page.choose("buyer1");
      page.next().ok(stateFor([service("alpha")]));
      await settled();
      page.choose("seller");
      page.next().ok(stateFor([service("alpha")]));
      await settled();

      assert.equal(page.byId("right").firstChild, form);
    });
  });

  describe("when the coordinator stops answering", () => {
    it("stays quiet after one unanswered read", async () => {
      // One failure is a blip the next poll recovers from. A strip that flickers on those trains
      // the reader to ignore it, which costs exactly the case it exists for.
      const page = await showing([service("alpha")]);

      page.poll();
      page.next().fail();
      await settled();

      assert.equal(page.byId("stale").hidden, true);
    });

    it("says so after two, and clears on the next read that answers", async () => {
      const page = await showing([service("alpha")]);

      for (let failure = 0; failure < 2; failure++) {
        page.poll();
        page.next().fail();
        await settled();
      }

      assert.equal(
        page.byId("stale").hidden,
        false,
        "two unanswered reads left the page looking live",
      );
      assert.match(page.byId("stale").textContent, /Not updating/);

      page.poll();
      page.next().ok(stateFor([service("alpha")]));
      await settled();

      assert.equal(page.byId("stale").hidden, true);
    });
  });

  describe("a service card", () => {
    it("rings the seat this buyer holds", async () => {
      const page = await showing([service("alpha", openPool("7"))], [heldSeat("7", 2)]);

      const dots = childWithClass(cardIn(page, "services"), "seats");

      assert.deepEqual(
        dots.childNodes.map((dot) => dot.className),
        ["dot taken", "dot taken mine", "dot"],
      );
    });

    it("paints its countdown when the card is built", async () => {
      // `countdown` ticks once before returning, at which point the caller has not appended the
      // node - so a first tick that waits for `isConnected` never paints and never schedules,
      // and the deadline the whole primitive turns on is a blank span.
      const page = await showing([service("alpha", openPool("7"))]);

      const facts = childWithClass(cardIn(page, "services"), "facts");
      const clock = childWithClass(facts, "mono");

      assert.match(clock.textContent, /^closes in \d+:\d{2}$/);
    });
  });
});
