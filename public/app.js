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
let busy = false;
let polling = false;
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
  // One request at a time. A poll that overtakes a slow one costs the server the whole read set
  // twice over, exactly when it is already behind - and the answers could land out of order.
  if (polling) return;
  polling = true;
  try {
    // Bounded, because `polling` is only cleared in `finally`: a request that never settles -
    // a stalled mirror-node connection rather than a refused one - would leave the guard set
    // and the page would stop updating until it was reloaded. Only this poll takes a deadline.
    // The action POSTs sign and settle real transactions, and are allowed to take as long as
    // they take.
    state = await api(`state${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ""}`, {
      signal: AbortSignal.timeout(POLL_MS * 3),
    });
    render();
  } catch (error) {
    console.error(error);
  } finally {
    polling = false;
  }
}

/**
 * Run an action with its button disabled.
 *
 * Every one of these signs and settles a real transaction, which takes seconds. Without this a
 * second click buys a second seat - and on an account that already holds one, that payment is
 * late by construction and has to be refunded rather than counted.
 */
async function act(button, work) {
  if (busy) return;
  busy = true;
  const wasLabel = button.textContent;
  button.disabled = true;
  button.textContent = "working…";
  try {
    await work();
  } catch (error) {
    window.alert(error.message);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = wasLabel;
    await refresh();
  }
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
  $("right").replaceChildren(...(seller ? sellerPanels() : seatPanels()));
  renderCrowd();
  renderLog();
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

  const bar = el("div", "bar");
  const fill = el("span");
  fill.style.width = `${Math.min(100, (pool.filled / pool.threshold) * 100)}%`;
  bar.append(fill);
  card.append(bar);

  const facts = el("div", "facts");
  facts.append(pill(pool.state));
  facts.append(el("span", null, [el("b", null, `${pool.filled} of ${pool.threshold}`), " seats"]));
  facts.append(el("span", null, [el("b", null, `${pool.seatHbar} ℏ`), " per seat"]));
  facts.append(countdown(pool));
  card.append(facts);
  card.append(el("div", "note", `Pool ${pool.poolId} · all-or-nothing: if the deadline passes short, every payer is refunded.`));

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
  if (!state.seats.length) {
    return [el("div", "empty", "No seats yet. Pay into a pool on the left, and it appears here.")];
  }
  return state.seats.map(seatCard);
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

function sellerPanels() {
  const card = el("div", "card");
  card.append(el("h3", null, "Open a pool"));
  card.append(el("div", "why", "Four choices, one click. Nothing about opening a pool goes through the coordinator — it finds out by reading the chain, like anyone else."));

  const service = dropdown("Service", state.services.map((s) => [s.slug, title(s.slug)]));
  const first = state.services[0];
  const threshold = dropdown("Threshold", first.thresholds.map((t) => [t, `${t} distinct buyers`]));
  const price = dropdown("Seat price", state.choices.seatHbar.map((c) => [c.hbar, c.label]));
  const ttl = dropdown("Deadline", state.choices.ttl.map((c) => [c.seconds, c.label]));
  card.append(service.wrap, threshold.wrap, price.wrap, ttl.wrap);

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

  const panels = [card];
  const met = state.services.filter((s) => s.pool && s.pool.state === "Met");
  for (const service of met) panels.push(releaseCard(service));
  return panels;
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

function renderCrowd() {
  const buyers = state.wallets.filter((w) => w.role === "buyer");
  const pool = state.services.map((s) => s.pool).find((p) => p && p.state !== "Released");
  // `state.seats` is only ever the selected wallet's, so this is one boolean about one buyer -
  // the dot lights for whoever is being played, and the others stay dark.
  const iAmSeated = pool && state.seats.some((s) => s.seat !== null && s.poolId === pool.poolId);
  $("crowd").replaceChildren(
    ...buyers.map((buyer) => {
      const who = el("span", "who");
      const mine = buyer.label === wallet && iAmSeated;
      who.append(el("span", `dot${mine ? " seated" : ""}`));
      who.append(el("span", null, buyer.label));
      return who;
    }),
    el("span", "note", pool ? `pool ${pool.poolId} · ${pool.filled} of ${pool.threshold} seats taken` : "no pool open"),
  );
}

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
  refresh();
};

refresh();
setInterval(() => {
  // Never poll over an action: a refresh mid-payment would redraw the button being clicked.
  if (!busy) refresh();
}, POLL_MS);
