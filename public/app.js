/**
 * The demo page.
 *
 * Plain JavaScript against `/demo/api`, deliberately: no framework, no bundler, nothing between
 * saving this file and reloading the tab. It renders state and posts actions, and it decides
 * nothing - which button a seat earns is `scripts/demo/seats.ts`'s answer, computed from the
 * contract's own refund rule and §8, and sent down with the row.
 *
 * Two clocks tick without asking the server anything: the deadline countdown, and the relative
 * age of a log line. Polling for those would cost a contract read per second.
 */

const POLL_MS = 4000;

let state = null;
let wallet = localStorage.getItem("quorum402.wallet") || "";
/**
 * How many waits the user is actually waiting on. Zero means the screen shows what was last
 * read and may be clicked.
 *
 * A counter rather than a flag because they nest: an action's own refresh runs inside the
 * action's wait, and the page must stay blocked across both.
 */
let waits = 0;
/**
 * Reads in flight, and the sequence number of the newest one issued.
 *
 * The background poll skips while anything is in flight - a poll that overtakes a slow one costs
 * the server the whole read set twice over, exactly when it is already behind. A refresh the
 * *user* asked for is never skipped: it is the thing they are waiting on. `latest` is what makes
 * that safe - an answer overtaken while in flight is discarded rather than rendered.
 */
let inFlight = 0;
let latest = 0;
/** The licence a redemption returned, kept per pool so it survives the next poll. */
const licences = new Map();

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------------------------ fetching

async function api(path, options) {
  const res = await fetch(`/demo/api/${path}`, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);
  return body;
}

async function post(path, payload) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function refresh() {
  inFlight += 1;
  const mine = ++latest;
  try {
    // Bounded, because `inFlight` only falls in `finally`: a request that never settles - a
    // stalled mirror-node connection rather than a refused one - would leave the count above
    // zero and the page would stop polling until it was reloaded. Only this read takes a
    // deadline. The action POSTs sign and settle real transactions, and are allowed to take as
    // long as they take.
    const answer = await api(`state${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ""}`, {
      signal: AbortSignal.timeout(POLL_MS * 3),
    });
    // Overtaken while in flight, so this describes a moment already redrawn - or, after a wallet
    // switch, a wallet the user has left. `render` reads the *current* wallet for the name and
    // balance but takes the seats from `state`, so rendering it would put one buyer's name above
    // another buyer's seat cards, with live buttons on rows that are not theirs.
    if (mine !== latest) return;
    state = answer;
    render();
  } catch (error) {
    console.error(error);
  } finally {
    inFlight -= 1;
  }
}

/**
 * Run something the user is waiting on, with the page saying so.
 *
 * One class on <body>; the `waiting` block in `index.html` has the rest and the reasoning. Not
 * wrapped around the background poll on purpose - that fires every four seconds, and a page
 * that dimmed each time would spend the demo strobing.
 */
async function waitFor(work) {
  waits += 1;
  document.body.classList.add("busy");
  try {
    return await work();
  } finally {
    waits -= 1;
    if (waits === 0) document.body.classList.remove("busy");
  }
}

/**
 * Run an action, with the page blocked until its result is on screen.
 *
 * Every one of these signs and settles a real transaction, which takes seconds. Without this a
 * second click buys a second seat - and on an account that already holds one, that payment is
 * late by construction and has to be refunded rather than counted.
 *
 * The label is the one thing left per-button: `waitFor` says the page is busy, and this says
 * which of its buttons is the reason. Nothing here touches `disabled` - the guard above already
 * refuses a second action, and `body.busy` already refuses the click - so the buttons that are
 * disabled on their own merits stay that way.
 *
 * The refresh is inside the wait rather than after it, so the page unblocks when the screen
 * shows the result, not when the transaction returns.
 */
async function act(button, work) {
  if (waits) return;
  const wasLabel = button.textContent;
  button.textContent = "working…";
  await waitFor(async () => {
    try {
      await work();
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.textContent = wasLabel;
      await refresh();
    }
  });
}

// ----------------------------------------------------------------------------------- rendering

function render() {
  if (!state) return;
  // Returns the selection because it may also *change* it: a wallet that has gone away falls
  // back to the first one, and everything below reads the wallet that survived that.
  const me = renderWallets();
  const seller = me && me.role === "seller";

  $("left-title").textContent = seller ? "Services on offer" : "Services";
  $("right-title").textContent = seller ? "Sell" : `My seats${state.seats.length ? ` (${state.seats.length})` : ""}`;
  $("services").replaceChildren(...state.services.map((s) => serviceCard(s, seller)));
  setPanels($("right"), seller ? sellerPanels() : seatPanels());
  renderLog();
}

/**
 * Put `panels` in `host`, leaving a panel that is already first exactly where it is.
 *
 * `replaceChildren` is specified as remove-all-then-insert, so a node that is *already* a child
 * is detached and re-attached. That drops focus to `<body>` and closes an open `<select>` popup,
 * which on a four-second poll means a seller reading a dropdown has it shut under them. Caching
 * the form kept its *selections* across polls; leaving the node in place is the other half, and
 * without it the fix only looks like it worked. Nothing else on the page is cached, so nothing
 * else takes this branch.
 */
function setPanels(host, panels) {
  if (!panels.length || host.firstChild !== panels[0]) {
    host.replaceChildren(...panels);
    return;
  }
  while (host.childNodes.length > 1) host.lastChild.remove();
  for (const panel of panels.slice(1)) host.append(panel);
}

function renderWallets() {
  const select = $("wallet");
  if (select.options.length !== state.wallets.length) {
    select.replaceChildren(
      ...state.wallets.map((w) => new Option(`${w.label} — ${w.role}`, w.label)),
    );
    if (!state.wallets.some((w) => w.label === wallet)) wallet = state.wallets[0].label;
    select.value = wallet;
  }
  const me = state.wallets.find((w) => w.label === wallet);
  $("balance").textContent = me ? `${me.hbar} ℏ` : "—";
  $("account").textContent = me ? me.accountId : "";
  return me;
}

/** A service, showing the pool a payment would actually land in — or that there is none. */
function serviceCard(service, seller) {
  const card = el("div", "card");
  card.append(el("h3", null, title(service.slug)));
  card.append(el("div", "cut", `${service.cut.capability} · ${service.cut.tier} · ${service.cut.region}`));
  card.append(el("div", "why", service.description));

  const pool = service.pool;
  if (!pool) {
    card.append(el("div", "empty", "No pool is selling this yet — the seller opens one."));
    return card;
  }

  card.append(seatDots(pool.filled, pool.threshold));

  const facts = el("div", "facts");
  facts.append(pill(pool.state));
  facts.append(el("span", null, [el("b", null, `${pool.filled} of ${pool.threshold}`), " seats"]));
  facts.append(el("span", null, [el("b", null, `${pool.seatHbar} ℏ`), " per seat"]));
  facts.append(countdown(pool));
  card.append(facts);
  card.append(el("div", "note", `Pool ${pool.poolId} · all-or-nothing: if the deadline passes short, every payer is refunded.`));
  // Only when the card is showing a pool nobody can pay into. While one is selling, it is the
  // pool - there is nothing to disambiguate, and a count would be trivia beside a live button.
  if (!pool.available && service.poolCount > 1) {
    card.append(el("div", "note", `The newest of ${service.poolCount} pools opened for this service.`));
  }

  if (!seller) {
    const button = el("button", null, `Pay ${pool.seatHbar} ℏ for a seat`);
    button.disabled = !pool.available;
    if (!pool.available) button.textContent = closedBecause(pool.reason);
    button.onclick = () =>
      act(button, async () => {
        const result = await post("buy", { wallet, slug: service.slug });
        if (result.status !== 200 && result.status !== 202) {
          window.alert(`${result.status}: ${detail(result.body)}`);
        }
      });
    card.append(button);
  }
  return card;
}

function closedBecause(reason) {
  if (reason === "closing") return "Closing — too near the deadline to settle";
  if (reason === "deadline-passed") return "Deadline passed";
  return "Not selling";
}

// ---------------------------------------------------------------------------------- buyer view

/** One panel per seat this wallet holds. A buyer can hold several at once, in different states. */
function seatPanels() {
  const panels = state.seats.length
    ? state.seats.map(seatCard)
    : [el("div", "empty", "No seats yet. Pay into a pool on the left, and it appears here.")];
  // Why the list can look short. These are this address's real deposits into pools that name
  // another coordinator - an `npm run e2e` run on an ephemeral port, almost always - and this
  // one cannot redeem them. Better said than silently filtered.
  //
  // Deposits rather than seats, because a refunded one gave its seat back and a late one never
  // took a seat at all - and `at least` when the index query hit its bound, since the number is
  // then a floor rather than a total. A note explaining a gap has to be exact about its own.
  if (state.seatsElsewhere) {
    panels.push(
      el(
        "div",
        "empty",
        `${state.seatsCapped ? "At least " : ""}${state.seatsElsewhere} more deposit(s) from this address are in pools another coordinator serves — this one cannot redeem them.`,
      ),
    );
  }
  return panels;
}

function seatCard(seat) {
  const card = el("div", "card");
  card.append(el("h3", null, `Pool ${seat.poolId} · ${title(seat.slug)}`));

  const facts = el("div", "facts");
  facts.append(pill(seat.state));
  facts.append(
    el("span", null, seat.seat === null ? "no seat — this payment settled late" : `seat ${seat.seat} of ${seat.threshold}`),
  );
  if (seat.state === "Open") facts.append(countdown(seat));
  card.append(facts);
  card.append(seatDots(seat.filled, seat.threshold, seat.seat));

  // Lazy expiry: worth showing rather than smoothing over. It is the one place the index and the
  // chain legitimately disagree, and the demo is about being able to check things. Only while
  // there is still something to claim - after a refund the pool has been stamped, and saying
  // otherwise would describe the state one action ago.
  if (seat.state === "Expired" && seat.storedState === "Open" && seat.action === "reclaim") {
    card.append(el("div", "note", "The deadline has passed. Nobody has stamped the pool yet — claiming refunds it and stamps it in one call."));
  }

  const receipt = el("div", "note");
  receipt.append("receipt · settled ");
  receipt.append(txLink(seat.transaction, seat.transactionUrl));
  card.append(receipt);

  card.append(
    seat.indexed
      ? el("div", "badge", "indexed by The Graph ✓")
      : el("div", "badge waiting", "waiting for The Graph to index this deposit…"),
  );

  if (seat.action === "redeem") {
    const button = el("button", null, "Redeem my seat");
    button.disabled = !seat.indexed;
    button.onclick = () =>
      act(button, async () => {
        const result = await post("redeem", { wallet, poolId: seat.poolId });
        if (result.status === 200) licences.set(seat.poolId, result.body);
        else window.alert(`${result.status}: ${detail(result.body)}`);
      });
    card.append(button);
    card.append(el("div", "note", "Signs the same settlement the payment returned — the seat is not bought again."));
  } else if (seat.action === "reclaim") {
    const button = el("button", null, `Claim my refund`);
    button.onclick = () =>
      act(button, async () => {
        const result = await post("refund", { wallet, poolId: seat.poolId });
        window.alert(`${result.hbar} ℏ returned.`);
      });
    card.append(button);
    card.append(el("div", "note", "Calls claimRefund on the contract from your own account. The coordinator is not involved."));
  } else if (seat.action === "wait") {
    card.append(el("div", "note", `Waiting for ${seat.threshold - seat.filled} more buyer(s).`));
  } else if (seat.refunded) {
    card.append(el("div", "note", "Refunded — this deposit has already been paid back."));
  }

  const licence = licences.get(seat.poolId);
  if (licence) card.append(licenceCard(licence));
  return card;
}

/** What a seat actually buys, once the crowd is complete. */
function licenceCard(licence) {
  const card = el("div", "card");
  card.style.marginTop = "12px";
  card.append(el("h3", null, licence.benchmark));
  const q = el("div", "quantiles");
  for (const [key, label] of [["p25", "25th pct"], ["p50", "median"], ["p75", "75th pct"]]) {
    const cell = el("div");
    cell.append(el("b", null, `${licence.unitPrice[key]}`));
    cell.append(el("span", null, `${label} · ${licence.unitPrice.currency}/${licence.unitPrice.per}`));
    q.append(cell);
  }
  card.append(q);
  card.append(
    el("div", "note", `${licence.contributors} contributors · minimum ${licence.minimumContributors} · licensed to ${licence.licensee}`),
  );
  card.append(el("div", "note", licence.note));
  return card;
}

// --------------------------------------------------------------------------------- seller view

/**
 * The seller's form, built once and kept.
 *
 * Everything else on this page is replaced on every poll, which is what a screen showing the
 * chain's current answer should do. It is the wrong treatment for four dropdowns holding a
 * choice the seller is part-way through making: rebuilt every four seconds, the selection was
 * back to the first option before they could reach the button.
 *
 * Safe to keep because all four option lists are server-side constants - `BENCHMARKS`,
 * `TTL_CHOICES`, `SEAT_HBAR_CHOICES` - so there is no state a later poll could carry that would
 * leave the form stale. It also survives a trip through a buyer's screen and back, because the
 * same node is re-appended rather than rebuilt.
 */
let sellForm = null;

function sellerPanels() {
  // The release cards are rebuilt, deliberately: unlike the form, they *are* pool state.
  const panels = [sellForm ?? buildSellForm()];
  const met = state.services.filter((s) => s.pool && s.pool.state === "Met");
  for (const service of met) panels.push(releaseCard(service));
  return panels;
}

function buildSellForm() {
  const card = el("div", "card");
  card.append(el("h3", null, "Open a pool"));
  card.append(el("div", "why", "Four choices, one click. Nothing about opening a pool goes through the coordinator — it finds out by reading the chain, like anyone else."));

  const service = dropdown("Service", state.services.map((s) => [s.slug, title(s.slug)]));
  const threshold = dropdown("Threshold", []);
  const price = dropdown("Seat price", state.choices.seatHbar.map((c) => [c.hbar, c.label]));
  const ttl = dropdown("Deadline", state.choices.ttl.map((c) => [c.seconds, c.label]));
  card.append(service.wrap, threshold.wrap, price.wrap, ttl.wrap);

  /**
   * The thresholds on offer are the *selected* service's, not the first service's.
   *
   * `minimumContributors` is declared per benchmark and is the floor the server refuses below -
   * published to fewer buyers than that, an aggregate discloses a contributor - so a form
   * offering another benchmark's floor can offer a threshold this one will not accept.
   *
   * Re-read on change rather than fixed when the form is built, because the form now outlives
   * the choice that built it. A threshold the newly chosen service also offers survives the
   * swap; one it does not falls back to that service's own floor.
   */
  const syncThresholds = () => {
    const chosen = state.services.find((s) => s.slug === service.select.value);
    const was = threshold.select.value;
    threshold.select.replaceChildren(
      ...chosen.thresholds.map((t) => new Option(`${t} distinct buyers`, t)),
    );
    if (chosen.thresholds.some((t) => String(t) === was)) threshold.select.value = was;
  };
  service.select.onchange = syncThresholds;
  syncThresholds();

  const button = el("button", null, "Open pool");
  button.onclick = () =>
    act(button, async () => {
      const opened = await post("pool", {
        slug: service.select.value,
        threshold: Number(threshold.select.value),
        seatHbar: price.select.value,
        ttlSeconds: Number(ttl.select.value),
      });
      window.alert(`Pool ${opened.poolId} is open.`);
    });
  card.append(button);

  sellForm = card;
  return card;
}

function releaseCard(service) {
  const card = el("div", "card");
  card.append(el("h3", null, `Pool ${service.pool.poolId} reached its threshold`));
  card.append(el("div", "why", `${service.pool.filled} of ${service.pool.threshold} seats taken. The money is owed to you.`));
  const button = el("button", null, "Release to the seller");
  button.onclick = () =>
    act(button, async () => {
      const done = await post("release", { poolId: service.pool.poolId });
      if (done.transactionUrl) window.open(done.transactionUrl, "_blank");
    });
  card.append(button);
  card.append(el("div", "note", "Permissionless — anyone could call this. The recipient and the amount were fixed when the pool opened."));
  return card;
}

function dropdown(label, options) {
  const wrap = el("div");
  wrap.append(el("label", null, label));
  const select = document.createElement("select");
  select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  wrap.append(select);
  return { wrap, select };
}

// -------------------------------------------------------------------------------------- footer

function renderLog() {
  $("log").replaceChildren(
    ...state.log.map((entry) => {
      const line = el("div");
      line.append(el("span", "t", `${time(entry.at)}  `));
      if (entry.direction === "out") {
        line.append(el("span", "out", `${entry.wallet} → ${entry.text}`));
      } else if (entry.direction === "chain") {
        line.append(el("span", "chain", `⛓ ${entry.wallet ? `${entry.wallet} ` : ""}${entry.text}`));
      } else {
        line.append(el("span", `in s${statusClass(entry.status)}`, `← ${entry.status}  ${entry.text}`));
      }
      return line;
    }),
  );
  $("log").scrollTop = $("log").scrollHeight;
}

function statusClass(status) {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 402) return "402";
  return "4xx";
}

// --------------------------------------------------------------------------------------- bits

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children != null) {
    for (const child of Array.isArray(children) ? children : [children]) node.append(child);
  }
  return node;
}

function pill(stateName) {
  return el("span", `pill ${stateName}`, stateName);
}

/**
 * The crowd, as one dot per seat: filled for the seats taken, ringed for the payer's own.
 *
 * On the card that names the pool, rather than in a strip along the bottom of the page. That
 * strip had to pick one pool out of several to be about, could not say which it had picked, and
 * offered no way to pick another - so its number was true of something the reader could not
 * identify. Here there is nothing to disambiguate: these are the seats of the pool written two
 * lines above them.
 *
 * It replaces a percentage bar, which was the wrong shape for the quantity. A threshold is a
 * count of *people* - three or four of them - and a bar that reads 75% invites the question the
 * whole primitive answers with a refund: whether nearly enough is enough.
 */
function seatDots(filled, threshold, mine) {
  const row = el("div", "seats");
  for (let seat = 1; seat <= threshold; seat++) {
    row.append(el("span", `dot${seat <= filled ? " taken" : ""}${seat === mine ? " mine" : ""}`));
  }
  return row;
}

/** Ticks locally. A countdown that polled would cost a contract read a second. */
function countdown(pool) {
  const node = el("span", "mono");
  const at = Date.now() + pool.secondsLeft * 1000;
  const tick = () => {
    if (!node.isConnected) return;
    const left = Math.max(0, Math.round((at - Date.now()) / 1000));
    node.textContent = left > 0 ? `closes in ${clock(left)}` : "deadline passed";
    if (left > 0) setTimeout(tick, 1000);
  };
  tick();
  return node;
}

function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Middle-truncated: a full transaction id is unreadable at 720p, and the link is the point. */
function txLink(transaction, url) {
  const text = transaction.length > 22 ? `${transaction.slice(0, 12)}…${transaction.slice(-6)}` : transaction;
  if (!url) return el("span", "mono", text);
  const link = el("a", "mono", `${text} ↗`);
  link.href = url;
  link.target = "_blank";
  link.title = transaction;
  return link;
}

function title(slug) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function time(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

function detail(body) {
  if (!body) return "";
  return [body.error, body.detail].filter(Boolean).join(" — ");
}

// ---------------------------------------------------------------------------------- start-up

$("wallet").onchange = (event) => {
  wallet = event.target.value;
  localStorage.setItem("quorum402.wallet", wallet);
  licences.clear();
  waitFor(refresh);
};

// The cold start is a wait like any other: two contract reads per benchmark, a mirror read and
// a subgraph read, none of them cached yet. <body> ships with the class so the cursor is right
// from the first paint; from here the counter owns it.
waitFor(refresh);
setInterval(() => {
  // Never poll over a wait: a refresh mid-payment would redraw the button being clicked, and one
  // mid-switch would flick the screen back to the wallet being left. Never over another read
  // either - that guard used to live inside `refresh`, where it also swallowed the refreshes the
  // user asked for and left the screen a wallet behind.
  if (!waits && !inFlight) refresh();
}, POLL_MS);
