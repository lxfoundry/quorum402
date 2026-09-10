# AI usage

Required disclosure under ETHGlobal's AI policy. This file is written **as the work
happens**, not reconstructed before submission.

> **Attribution Required** — document where and how AI tools were used.
> **Meaningful Contribution** — AI assists the development process; it does not create the
> entire project.
> **Spec-Driven Development** — teams using spec-driven workflows must include all spec
> files, prompts, and planning artifacts.

---

## 1. Tools used

| Tool | Model | Used for |
|---|---|---|
| Claude Code | Claude Opus 5 | Implementation, refactoring, test scaffolding, documentation |

## 2. Skills and prompts

The reusable instruction sets driving the AI workflow are committed in
[`.claude/skills/`](.claude/skills/) rather than kept private — they are prompts, and the
policy asks for prompts.

They are the [Superpowers](https://github.com/obra/superpowers) skill library by Jesse
Vincent (`obra`), MIT-licensed, used as a general-purpose public library. They are not
specific to this project and encode no part of its design. Provenance and licence:
[`.claude/skills/VENDORED.md`](.claude/skills/VENDORED.md).

Task-specific prompts and planning artifacts are dated in [`specs/`](specs/).

## 3. Where AI was used, by area

Filled in daily. Each entry says what was generated, what was rewritten by hand, and what
was rejected.

| Date | Area | AI contribution | Human contribution |
|---|---|---|---|
| 2026-09-07 | Preflight checks against Hedera testnet (`scripts/`) | Wrote the check scripts and the x402 `exact` wire types in `src/x402/` | Chose what had to be verified before any contract was written, and read the results |
| 2026-09-07 | ADRs 0001–0004 and `specs/pool-contract.md` | Drafted and edited the documents | Every decision they record — what `quorum` binds to, how a payment is attributed, who holds authority, why nothing is rejected |
| 2026-09-07 | `contracts/QuorumPools.sol` and its tests | Wrote the contract against the spec, and the test suite alongside it | Set the spec it was written against; directed the commit slicing so the history shows the work rather than the result |
| 2026-09-07 | Solidity toolchain | Verified Hedera's compiler target from Hedera's own docs rather than assuming it, and pinned `evmVersion: cancun` to match | Decided against the deployment half of the usual toolbox, since deployment goes through the Hedera SDK already in the tree |
| 2026-09-07 | Deployment to Hedera testnet (`scripts/deploy.ts`, `scripts/check-deployment.ts`, `src/pool/deployment.ts`) | Wrote the deploy script, the mirror-node verification and the committed deployment record | Decided the contract ships with no admin key, and that a deployment is verified from the ledger rather than from the receipt — a receipt only proves that *something* was created |
| 2026-09-07 | The first pooled payout on testnet (`scripts/check-payout.ts`, `src/pool/client.ts`) | Wrote the coordinator's client over the Hedera SDK and the end-to-end check | Insisted the unit question be settled against the network rather than against the repository's own constant — which is what found the defect below |
| 2026-09-07 | Lint and CI (`.github/workflows/ci.yml`) | Wrote the ESLint and solhint configs and the workflow, and ran both linters over the tree to find what they flagged | Decided that warnings fail the run, and that the three the test fixtures raise are turned off at the line with a reason rather than repo-wide; kept the Solidity line-length limit off the contract |
| 2026-09-08 | The subgraph (`subgraph/`) | Read both sides of the hosting question - The Graph's supported-networks list and Hedera's own docs - then wrote the schema, the mappings and the graph-node configuration, and ran it against testnet until it returned the real pools | Set the question the mappings had to answer: what does the contract deliberately not keep. Rejected the first schema for calling the account entity `Payer`, which is wrong for a recipient credited by a failed payout |
| 2026-09-08 | Hosting on Fly.io (`subgraph/fly/`) | Diagnosed the IPv4/IPv6 split and the Postgres collation and memory failures, and wrote the deployment configs and the split deploy path | Chose to self-host publicly rather than leave the index on a laptop, and refused the shortcut of publishing graph-node's unauthenticated admin port to make deployment easier |
| 2026-09-08 | `specs/quorum-scheme.md` and ADR 0005 | Read the x402 v2 specification, its HTTP transport and the `exact` scheme documents, then drafted the scheme spec and the decision record against them | Set the design in a question-by-question session before a line was written: that a legacy `exact` client must still be able to pay, that entitlement is derived from chain state rather than held in a session, that pools are opened by the seller and never by the server, and that the scheme nests its hold binding rather than referencing it |
| 2026-09-08 | ADR 0006 and the coordinator's payment leg (`src/server/`) | Found that the solvency guard's arithmetic cancels, so every `recordDeposit` precondition can be checked before the irreversible step; wrote the pool registry, the requirement builders, the payer derivation and the preflight gate, with tests at each boundary | Set the rule the design had to satisfy — that every condition for recording must hold *before* settle is relayed — and rejected the first design's post-settlement balance polling. Chose an HCS topic over a private failure store, on the grounds that the coordinator's own failures should not be the only events nobody else can audit |
| 2026-09-08 | The coordinator over HTTP (`src/server/index.ts`, `src/buyer/agent.ts`) | Wrote the §6 lifecycle, the receipt, the buyer that answers a 402 on its own, and tests driving every status-table row over a real listening server with the chain stubbed | Approved the testnet spend and set its bound. Called for a seller account distinct from the coordinator, which ADR 0003 assumes and a pool paying its own coordinator would not have shown |
| 2026-09-09 | Receipt redemption (`src/server/redeem.ts`, `src/x402/redemption.ts`, `src/graph/client.ts`) | Wrote §8's canonical message and its verifier, the subgraph client the lookup needs, and the buyer's redemption path; checked every GraphQL query against the live index before building on it | Required that the index resolve only a *position*, with `payer` and `counted` read back from the contract — an indexer must not be able to make a seat valid. Rejected folding two new refusals into §6's catch-all 401, since a payer can act on only one of the three |
| 2026-09-09 | The refund path, end to end (`scripts/e2e/quorum-missed.ts`, `src/pool/client.ts`) | Found that the contract's two refund methods had no caller anywhere above Solidity, added them to the pool client, and wrote the scenario that drives a pool past its deadline one seat short and refunds both payers on testnet | Chose to spend the remaining build time proving the failure path rather than finishing the README, on the grounds that a demo of an all-or-nothing primitive that only ever shows the *all* has shown the easy half. Called for both of §9's reversal paths in one run rather than the cheaper one, since they exist for different people |
| 2026-09-09 | The demo UI (`scripts/demo/`, `public/`, `src/hedera/explorer.ts`) | Checked the HashScan link format against the mirror node instead of assuming it, and found the existing one was built on the spelling the API rejects; wrote the control plane, the page, and the seat rules — copied from `_isRefundable` and §8 step 5 rather than reasoned about again — then drove both scenarios against testnet | Asked for a product a buyer could recognise rather than a control panel, and for no text entry anywhere in it. Refused to let the page imply a buyer can pick a pool, since nothing in the `quorum` exchange carries a pool id and every such button but one would be a lie. Ruled out hosting it, because the process holding the buyer keys is not one to publish |
| 2026-09-10 | The demo page's waits, and the seller's form (`public/`) | Traced a morning of failing Hedera calls to a system clock an hour behind real time, then fixed three things the page did badly once it worked again: nothing marked a wait, the four-second poll rebuilt the seller's half-made form from scratch, and the threshold list ignored which service was selected. Checked the result by loading the real `public/app.js` in a throwaway stubbed DOM and asserting the behaviour, rather than by watching the page | Reported the symptom precisely enough to be diagnosable - the error text, its ten-second cadence, and that it was new that morning. Chose how strong the wait treatment should be, and required it to cover actions and wallet switches rather than only the cold start |
| 2026-09-10 | Reading the demo page, and a fourth buyer (`public/`, `src/server/pools.ts`, `scripts/`) | Diagnosed three unrelated pool ids on one screen by querying the live subgraph for every pool the contract holds, rather than by reading the code - which is what found it, because `sellingPoolFor`'s fallback to the *earliest* matching pool reads as a defensible choice in isolation and only the real data shows it naming a pool released weeks earlier. Then moved seat occupancy onto the card that names the pool, gave the page a product identity, and checked the result by screenshotting the running page in headless Chrome at the video's 720p floor instead of reasoning about the CSS - which is how the sliced log line was found. Wrongly asserted in the plan that the new pool count was free, then found `scan` re-reads `poolCount` on every call and folded both answers into one registry method rather than pay twice | Reported that the page's pool numbering was unreadable, precisely enough to be checkable - which of the three ids appeared where. Chose to fix the crowd strip by deleting it and moving its meaning onto the pool card, over the alternative of a per-buyer subgraph query that would have made its dots true; held the line that the left column must not become a pool picker, since nothing in the `quorum` exchange carries a pool id, and required the page to disclose what it filters instead |
| 2026-09-10 | Review of the whole branch, and two fixes from it (`public/app.js`) | Reviewed the 25-commit branch in one pass against the specs, then verified both blocking findings against the tree before acting on either - the reports' anchors have been wrong before. Rebuilt the stubbed-DOM check the earlier session threw away, and confirmed each fix by reverting *it alone* and watching its own assertion fail | Asked for the review and chose its scope, twice: first the two blocking findings and the three stale comments, then - having seen them land - every remaining Minor as well, and finally the test file the reviewer had asked for. Nothing from the review was declined on grounds of taste; the one recommendation not acted on is written into the code that carries it |

## 4. What was done without AI

The design. Every ADR in `specs/adr/` records a decision that was made before anything was
generated, and the contract was written against a spec that already existed rather than
inferred by the model from a prompt.

Specifically not delegated: the choice to compose `quorum` over `exact` rather than
`auth-capture` or `escrow`; the trust boundary in ADR 0002, which accepts a real weakness
rather than hiding it; the ownerless authority model; and the decision that a deposit is
never rejected, which is the one that shapes most of the contract.

Also not delegated: reading the x402 Hedera binding and Hedera's own documentation closely
enough to know which parts of the design were in question, and deciding that the
`payTo`-as-a-contract question had to be settled on testnet before a line of Solidity was
worth writing.

## 5. What AI got wrong

Kept deliberately. A build with no entries here is not being honest about the tool.

**2026-09-07 — reached for a compiler flag instead of better code.** The first
`recordDeposit` did not compile: stack too deep. The suggested remedy in the error, and the
model's first instinct, is `viaIR: true` — which would have changed codegen on the contract
holding the money in exchange for keeping one long function. The function was restructured
instead. The lesson is that a compiler error offering a flag is not a recommendation.

**2026-09-07 — wrote a test against an API that does not exist.** Two `refundAll` tests
called `read.refundAll.staticCall(...)`, which is ethers' shape, not viem's. The tests failed
on their own mistake rather than on the contract. Worth recording because it is the failure
mode that matters in a test suite: a test that fails for the wrong reason is noise, and one
that *passes* for the wrong reason is worse.

**2026-09-07 — the spec had two slips that only writing the code found.** `PoolCreated`
declared `unitTinybars` as `uint256` while storage and every other event used `uint64`, and
`poolCount` was missing from the views although pool ids are allocated sequentially and
nothing could enumerate them without it. Both were written by AI and reviewed by a human, and
neither was caught until the contract was built against them. Writing the spec first is still
worth it; believing a spec is correct because it is written down is not.

**2026-09-07 — the spec claimed an authority the code did not have.** The Actors table said a
coordinator "cannot refund to itself". It can: record a deposit naming yourself as payer for
an amount that is not the unit price, and it is late on arrival, refundable at once, and
yours to claim. The underlying integrity claim survives — the solvency gate bounds it to
unattributed HBAR — and ADR 0003 had already described the race in full. Only the one-line
summary overstated it, which is the dangerous place for an overstatement: a reader can
disprove it in one call, faster than they can find the ADR that qualifies it.

**2026-09-07 — the spec undersold its own tests, and the undersell was also AI-written.**
Preflight item 3 said the local tests "would pass just as well with the wrong constant,
because they use the same one on both sides". They would not. `test/helpers.ts` defines
`TINYBAR_TO_WEIBAR` independently of the contract's, and two assertions cross the two, so a
wrong constant *in the contract* fails the suite. What the tests genuinely cannot check is
whether Hedera's real ratio is 1e10. Both directions of this matter: a spec that overstates
its guarantees misleads a reader, and one that understates its tests wastes the time of
whoever reads it next deciding what to re-verify.

**2026-09-07 — picked the more careful-looking of two options and paid for it on the network.**
`ContractCreateFlow.setBytecode` accepts a string or a `Uint8Array`, and decoding the hex to
bytes first reads as the more rigorous choice. It is the wrong one: the flow uploads whatever
it is given into a Hedera file, and the node reads that file as *hex text*. The failure is
ERROR_DECODING_BYTESTRING, arriving after the file has been created, appended to and paid for,
with nothing local to catch it. A type signature that accepts both forms is not saying both
work.

**2026-09-07 — asserted a shape of the evidence that had never been looked at.** The deploy
script's check for "nobody owns this contract" was written as `admin_key == null`, and it
failed a deployment that was correct: Hedera does not record the absence of an admin key, it
records the contract as its own administrator. The verdict was wrong in the worse direction —
it called a good deployment bad, which is survivable — but the habit behind it is the same one
this file already records under 2026-09-07: writing down a property the evidence had not been
checked for. The fix names three cases and fails only on the one ADR 0003 cares about, an
admin key held *outside* the contract.

**2026-09-07 — the whole contract was written to a unit that Hedera does not use, and 60
tests agreed with it.** The spec said Hedera's EVM denominates value in 18-decimal weibars, so
`address(this).balance` and `call{value:}` were converted at `1 tinybar = 1e10 weibar`. They
are not: the EVM counts in tinybars, and weibars are what the JSON-RPC relay shows Ethereum
tooling. The consequence was total — no deposit could pass the solvency gate against a
contract holding less than 100,000 HBAR — and nothing local could see it, because the tests
define their own copy of the constant and cross it against the contract's. That comparison can
only ever show that this repository agrees with itself.

It is another instance of one shape: a claim written down, then built on, without the
evidence for it ever being fetched. The earlier entries that day were prose overstating what the
code did. This one ran the other way - prose the code obeyed - and it is the more dangerous
direction, because the code cannot disagree with a premise it was derived from.

What broke the loop was a check against something nobody here wrote: one real payment, on the
real network, and the contract's own reverts as the evidence. Worth noting that the check
first passed *vacuously* - it compared the contract's balance view against the mirror node's
before either had any money in it, `0 == 0` - and only failed two steps later, at the deposit.
A check that cannot fail is not a check, and it was AI-written, in the same file that found
the bug it was too weak to catch.

**2026-09-08 — recommended a design resting on a rule that is not in the specification.** Asked
whether an unmodified `exact` client should still be able to pay a quorum-gated resource, the
model recommended against a fallback entry, reasoning that a client safely ignores a scheme it
does not recognise. x402 v2 says no such thing: its only normative skip rule is written against
`paymentFlow`, and there is no equivalent for `scheme`. The recommendation was made from a
plausible mental model of how clients behave, and the specification was read afterwards, at which
point the option the human had already chosen turned out to be the better-founded one. The
correction is in [ADR 0005](specs/adr/0005-what-quorum-declares-on-the-wire.md), and it improved
the design: declaring a `paymentFlow` value invokes a rule that actually exists.

**2026-09-08 — wrote a MUST rule that would have broken every refund in the system.** The draft
said the resource server must take the paying account from the facilitator's settlement response,
"never from the payload" — sound-looking security advice, and wrong on this network. The Hedera
binding defines `SettlementResponse.payer` as *"the Hedera account ID of the fee payer that
sponsored the transaction"*: the facilitator, not the buyer. A server built to that rule would
have recorded every deposit in every pool against the facilitator's account. Nothing would have
appeared to fail — payments settle, deposits record, thresholds cross — and every refund would
have been unreachable, with the money already gone. It was caught by reading the binding document
while specifying the redemption path, not by reasoning about the rule.

The single-payer script never had to confront this, because it already knew who the buyer was.
The rule now derives the payer from the signed transfer itself.

**2026-09-08 — a diagram written 2026-09-07 used the previous protocol version's header.** The
flow in `specs/pool-contract.md` had the buyer retrying with `X-PAYMENT`, which is x402 v1; v2
uses `PAYMENT-SIGNATURE`. The same diagram gave a settled-but-undelivered payment a 200. Both
were written from recall rather than from the transport document, and both were found by opening
it.

**2026-09-08 — invented a fact about the ecosystem while fixing a different problem.** A cleanup
review correctly found that §10.3 of the scheme spec justified the `escrow` binding's absence less
well than §10.2 justified `auth-capture`'s — it described what `escrow` was without ever saying
why it was unbuilt, leaving "they ran out of time" as the only available inference. Filling that
gap, the model wrote that `escrow` has "no facilitator serving it". It has one: Boson Protocol's
x402B serves the scheme on Base. Nothing was checked; a reason that sounded right was supplied for
a gap that was real.

Two things make it worth keeping. The correction is *stronger* than the invention — the honest
reason is that the format is unmerged and its facilitator settles on Base rather than Hedera,
which is the same feasibility wall `auth-capture` hits from the other side. And it needed a
disclosure the invention did not: that facilitator is the proposal author's own, so a reader told
only that "a facilitator serves `escrow`" would take it for independent uptake. Caught by the
human, who wrote the facilitator.

**2026-09-08 — had the fact in hand, deployed anyway, and let the failure re-teach it.**
Before the first Fly deploy, graph-node's listening sockets were inspected in the local
container and found to be IPv4-only, with `/proc/net/tcp6` empty. That is the entire
explanation for why `fly proxy` to the admin port would later fail against an IPv6-only
private network — and it was read, noted, and then not carried into the deployment plan. The
symptom arrived twenty minutes later as a connection reset with no explanation attached to it,
and the same check had to be run a second time, on the Fly machine, to reach the conclusion
that was already available. Reading evidence is not the same as acting on it.

**2026-09-08 — took a tool's default for a decision.** `fly postgres create --vm-size
shared-cpu-1x` was run without a memory flag, which is 256MB. graph-node's migrations get
about forty entries into the list and the connection dies; the error is `server closed the
connection unexpectedly`, which reads like a network fault and is an out-of-memory kill. Not
choosing a size is still choosing one, and the size that came back was too small for the only
thing the database was for.

The 2026-09-08 entries fall into two shapes, and both are worth naming.

Four of them repeat the shape the earlier ones had: **this tool states things about external
specifications fluently and from memory, and the fluency is uncorrelated with whether the
document says it.** The missing skip rule, the settlement payer, the v1 header and the `escrow`
facilitator were each asserted before the source was opened, and each was caught by opening it —
none by thinking harder about it.

The two deployment entries run the other way, and cost more. Neither was a claim about a
document: one was a fact already gathered and then not carried into the plan, the other a
decision never recognised as one. There was no source to fetch, because neither was a question
anyone had thought to ask — so both surfaced as a live deployment failing, and both times the
error named a symptom rather than the cause. Reading cures the first shape. The second is only
cured by treating a deployment as somewhere choices get made rather than defaults accepted.

**2026-09-08 — designed a wait for a latency that was not in the path.** The first plan for
recording a settled payment blocked on the mirror node until the contract's balance reflected
the transfer, then called `recordDeposit`. That was built on an assumption rather than a
reading: `PoolsClient` goes through `ContractCallQuery` and `ContractExecuteTransaction`, which
are consensus-node operations against current state, so nothing in the recording path consults
the mirror node at all. The polling in `check-payout.ts` is a *verification* that the network
agrees the money moved, and it had been mistaken for a precondition because it sits between the
two calls in that script. The correction came from a human asking why the check was not simply
done before settling, and the answer turned out to be that it could be — see ADR 0006, where
the solvency guard's arithmetic cancels. A design that paces itself against an API nothing in
the path queries is slower for no reason and degrades worst exactly when it is needed most.

**2026-09-08 — a test suite that passed and hung.** Every assertion in `payer-derivation.ts`
passed in 86ms, and the file was reported as failing after 90 seconds. `Client.forTestnet()`
opens network channels when it is constructed, and nothing there submits anything, so the
channels were never closed and the runner had no way to exit. The output said `pass 7` and
`fail 1` about the same file at once. Worth recording because the two halves of that are read
by different parts of the eye: the ticks look like success, and the thing that actually failed
was infrastructure the tests never mentioned.

**2026-09-08 — the SDK would have decoded a pool wrongly and not said so.** `poolOf` returns a
struct containing a `string`, so the return data is a tuple holding a dynamic tuple. Read with
the SDK's positional getters — the obvious approach, and the one used everywhere else in that
client — every word sits one offset further along than its index suggests, and `getString`
resolves its offset against the wrong base. It does not throw. It hands back a plausible pool
with the fields shifted, which would have been read as terms and used to price a 402. A runtime
dependency on viem was the cheaper side of that trade.

**2026-09-08 — feature work committed onto a branch that was already a pull request.** The ADR
branch had been pushed and opened as a PR; the next commit went on top of it rather than onto a
new branch, which would have put unrelated server code inside a decision record's review. It
was caught before pushing, so the fix needed no history rewriting — but the reason it was
available is luck of timing, not process. Branching is the step that is easiest to skip when
the work feels continuous, and it is exactly then that it matters.

**2026-09-08 — wrote the mirror-lag mistake into a script hours after writing the ADR against
it.** ADR 0006 says, at length, that mirror ingestion lags consensus and that the recording path
must not pace itself against it. The release script written the same evening then read the
contract's balance from the mirror node immediately after the payout and printed
`300000000 -> 300000000` — the pre-transfer figure, which reads exactly like a payout that did
not happen. The money had moved; five seconds later the same query showed the contract at zero
and the seller up by three HBAR. `check-payout.ts` had already solved this with a polling helper,
which the new script did not use because nothing pointed at it. Knowing a fact well enough to
write it down twice is not the same as applying it, and the failure mode of that gap is a script
that reports the opposite of what happened.

**2026-09-09 — wrote an address down, never asked the network for it, and left it beside the
keys.** `create-accounts.ts` recorded each buyer's `evmAddress` as `key.publicKey.toEvmAddress()`
— correct arithmetic on the key, and not the address the account has. The same script creates
those accounts with `setKeyWithoutAlias`, so they carry no EVM alias and the network gives them
the long-zero form of their number instead. Both facts were written by this tool, two dozen lines
apart, and neither was checked against the other.

Nothing read the field, so nothing failed. The cost was paid elsewhere: it is the value sitting
next to the private keys, so it is what a human compares a subgraph against, and the subgraph —
which had the right address, from the mirror node, all along — was the thing suspected. Two days
later it took a mirror-node query and a key derivation to establish that the file was wrong and
the index was not.

The same session found `specs/pool-contract.md` explaining long-zero addresses as a consequence
of ED25519 keys. That is a plausible sentence and a false one — the condition is the missing
alias, and every buyer here is ECDSA — and it was written to the spec, believed, and never
contradicted by the code, because the code was reading the mirror node and not the spec.

Both are the shape this file already records for external specifications, turned inward: a fact
stated fluently from what the API *looks* like it means, and then not checked. An unused field
is the worst place for one, because nothing will ever disagree with it.

**2026-09-09 — reported a red test suite as green, having filtered the evidence.** The suite was
run as `npm test | grep -E "not ok|passing"`, which matched the passing line, missed the
`1 failing` line the runner prints beside it, and returned "171 passing" to a terminal where that
looked like a complete answer. The commit message built on it said "171 tests, up from 134". One
test was failing, and had been failing for the whole of that commit.

The defect it was hiding is nothing: an assertion used the benchmark's URL slug where the licence
carries the benchmark's id. Twenty seconds to fix. What is worth recording is the shape - a
verification step was run, its output was narrowed by a filter written at the same moment and for
the same convenience, and the narrowing was never treated as part of what had to be checked. A
grep over test output is a claim about which lines can carry bad news, and that claim was wrong
here without ever being examined.

It is the same failure as the mirror-lag script the day before, one level up. There the fact was
known and not applied; here the check was run and its result was not read. Both produce a report
that is confidently the opposite of the truth, and in both cases the tool that would have caught
it was already in hand and used partially.

**2026-09-09 — read a contract-wide figure as if it were one pool's, twice.** The end-to-end
run asserted that `committedTinybars()` returns to zero after a release. That assertion was
copied from `check-payout.ts`, where it is correct — but only because that script ran when the
contract had one pool in its whole life. Against a contract carrying eleven, earlier pools
still hold deposits and the figure is never zero. The fix was a delta, which was wrong the
same way one layer down: `_totalCommitted` rises as each deposit is recorded and falls when
the payout leaves, so a delta measured across the whole scenario nets to zero and asserts
nothing at all. It passed only once it bracketed the release alone.

Both errors are the same one. An assertion was carried over from a script whose assumptions
were not carried over with it, and the second attempt inherited the first's mental model
instead of going back to the contract. The contract was read only after the second failure,
and it answered the question in four lines.

**2026-09-09 — reported a test as run when the tool had not run it.** Verifying that a run
killed halfway leaves nothing behind for the next one, the check was `timeout -s KILL 7`
around the runner. It exited 0 with a complete, successful run three times, and each was read
as "the kill left no orphan" rather than as what it was: `timeout` not killing anything in
this shell. Timing a plain run showed it takes 40 seconds, so a 7-second limit could not have
let it finish. The orphan-resilience claim was never tested; it holds by construction — each
run sells on an ephemeral port, so its resource URL is one no earlier pool can name — and that
is an argument, not a measurement. Recorded because the failure is self-flattering: a
verification step that cannot fail reads exactly like one that passed.

**2026-09-09 — a well-tested function nothing could call.** `claimRefund` and `refundAll` had
unit tests over the arithmetic, the expiry ordering, the already-refunded skip and a payer
contract that burns the gas it is sent. What they did not have was a caller. `PoolsClient`
exposed `createPool`, `recordDeposit` and `release` and stopped, under a header comment saying
refunds were "a payer's business and go through the payer's own key, so they are not on this
client" — which is true, and was quietly doing the work of a decision. Every layer above the
contract was therefore structurally incapable of reaching the half of the primitive the README
leads with: no script, no demo and no end-to-end run could refund anybody. The coverage
answered "is this function correct" completely, and nothing in the suite or the type system
asks "can anything reach it". A public interface that stops one method short of a claim the
project makes is not visible as an absence — it looks exactly like a finished interface.

The same day's second lesson is the one underneath it. `test/redemption.ts` already asserted the
409-with-reclaim ruling for an expired pool, over injected state; `test/refunds.ts` already
asserted the refund arithmetic, on an in-process EVM. Both passed, and neither had ever seen a
pool expire because a real clock passed a real deadline. The scenario written to close that gap
passed on its first run against testnet, which is worth recording precisely because it is not
evidence of much: every mechanism it drives was already exercised somewhere, and what was
missing was never a mechanism. It was the choreography, and the choreography is the part a unit
test is defined not to have.

**2026-09-09 — built a module to stop dead links, then wrote one with it.** `src/hedera/explorer.ts`
exists because a HashScan link that goes nowhere looks like evidence and is not, and it refuses to
guess: an id it cannot parse yields `undefined` rather than a plausible URL. Six lines into using
it, the pool card passed a **pool id** to `hashscanContract`, producing
`hashscan.io/testnet/contract/2`. The guard could not catch it, because `2` is a perfectly
well-formed entity id — it was the wrong *kind* of well-formed. Found by reading the endpoint's
real output rather than by any check in the tree, which is the point: the module removed the class
of error where a string is malformed, and left untouched the class where it is fine and means
something else. A type would have caught this one and a regex never will.

**2026-09-09 — cached a state that had not settled yet.** The demo caches pool reads and treats
`Released` and `Expired` as terminal, since neither can change again. It judged that on `statusOf`,
which resolves lazy expiry live — so a pool past its deadline that nobody had stamped was frozen as
terminal at the moment it was first read, and the page went on reporting it unstamped after
`claimRefund` had stamped it. The error is precise and worth naming: the pool *was* expired, so the
cache was not wrong about the state. It was wrong about the state being **finished changing**,
because the thing still to happen was storage catching up with a fact already true. ADR 0004's
disagreement is documented in three places in this repository, and it was still read as one value
rather than two. Only running the refund scenario end to end surfaced it.

**2026-09-10 — explained a ten-second wait from the call graph, an hour after diagnosing its
actual cause.** The demo page took about ten seconds to show anything, and the plan written to fix
it opened by explaining why: `/demo/api/state` makes two contract queries per benchmark plus a
mirror read and a subgraph read, none of them cached on the first call. That is a correct reading
of the code and it was beside the point. The same session had, an hour earlier, found the
machine's clock an hour behind real time and shown that every Hedera query was failing precheck
with `TRANSACTION_EXPIRED`, regenerating the same stale transaction id and burning the SDK's full
retry budget before giving up. Measured once the clock was fixed, the endpoint answers in 0.4s for
a seller and 1.8s for a buyer. The ten seconds had already been fixed, and the explanation was of
something that had stopped happening.

The affordance was built anyway and is worth having — a sleeping Fly.io machine behind the index
can put the wait back, and a blank column is a bad first frame at any duration. But it rested on
an account of the latency that a single `curl` refuted, and the evidence against that account was
already in the conversation that produced it. Reading a call graph yields an explanation shaped
exactly like a measurement, which is what makes it easy to skip taking one.

## 6. Review, and what it caught

The contract was reviewed by a second Claude Code session given only the diff, the spec and
the ADRs — not the conversation that produced the code. It found no fund-safety defect: it
traced the solvency invariant, the reentrancy ordering and the state machine independently
and could not construct a double payment or a stranded pool.

What it did find was the gap between what the code guaranteed and what the spec said it
guaranteed, three times over — the coordinator claim and the test claim above, plus
`refundAll`, which the spec called "bounded and resumable" while it was bounded in refunds
made rather than gas spent, and so could be closed off entirely by a payer contract that
burns the gas it is sent. It also found that the reentrancy test proved the weaker half of
what its test double existed for: with one deposit, the reentrant claim always reverted
`NothingToRefund`, so the storage re-read that actually prevents double payment was never
exercised.

The pattern across all four is worth naming. None was a bug in the sense of a wrong line;
every one was a place where prose asserted a property the tests did not reach. That is the
specific failure mode of building against a spec you also wrote — and the reason the review
was given the spec and the ADRs rather than the session history.

The subgraph got the same treatment, reviewed against the spec and the PR rather than the
session that wrote it. Again no critical defect: event coverage, entity ids, the derived
manifest and the unpublished admin port on Fly all held up when checked rather than taken on
the branch's word.

Three of the four things it did find rhyme with the contract review, and one does not.

The rhyming ones: the pull request said "every contract state transition has a handler",
which is true of every *emitted* transition and false for the one that emits nothing — a pool
whose deadline passes reads `Open` here until somebody stamps it. And the mappings apply
`Released`/`Refunded` unconditionally, though both are emitted before the transfer is
attempted, so a rejected push is counted as money moved and money owed at once. Both are the
same failure as before: a claim stated more broadly than the thing it describes, in prose that
nothing could contradict.

The one that does not rhyme is more useful. This branch *added* a CI check — for manifest
drift, the risk it had just spent an afternoon thinking about — and did not notice that
nothing in CI compiled the mappings at all. `subgraph/` has its own toolchain and sits outside
the repo's lint and typecheck config, so it had been invisible to CI since the day it was
created. The attention went to the freshly-imagined risk and not to the one that was already
there, which is a bias worth naming because it will not announce itself: the check that gets
written is the one you were already thinking about.

A fourth was a plain inconsistency. `fly/graph-node.toml` refuses to publish graph-node's
unauthenticated admin port and explains why at length; `docker-compose.yml`, written the same
day, published it on every interface along with IPFS's RPC and postgres. The same question was
answered twice, correctly once, and nothing reconciled the two — one file's reasoning does not
propagate to another just because the same session wrote both.

The redemption branch was reviewed the same way, and this time the review was given the spec
*as it stood before the branch* alongside the branch's own additions to it, because the branch
amended §6 and §8 as well as implementing them. A reviewer handed only the current spec would
have checked the code against prose the code had just written, which is not a check.

Nothing critical again: the ordered checks, the two-hop deposit resolution, the ledger-address
comparison and the `Met`-or-`Released` rule all held when traced independently, and no way was
found to obtain a seat without a valid signature or to escalate through a hostile index.

What it found sorts into two kinds, and only one of them is the kind the earlier reviews found.

The familiar kind: §6.2's diagram listed a replay check among the pre-flight's conditions, and
that check was dead in production — `isRecorded` was written for it, tested through an injected
stub, and never wired to anything. Prose asserting a property nothing reached, for the third
review running. Drawing the band accurately then turned up two more of the same: two contract
reads the diagram showed happening that were in fact one read carried and examined twice.

The unfamiliar kind is worth more. Two defects were not in the diff at all but in what the diff
now interacted with. `evmAddressOf` had quietly acquired a signing-key requirement when
`accountOf` was added for §8, because it was rewritten to delegate to it — so a refactor made
for redemption changed who was allowed to *pay*, and stopped the coordinator booting on a
multi-key account, in a function neither path's author was looking at. And the subgraph became
a request-path dependency in this branch without any of its failure modes being handled: an
index outage answered 500 to buyers holding good seats, with the upstream error echoed back.

Both are the same shape, and it is not the spec-versus-code gap: it is a change whose blast
radius was larger than the thing being changed. Reviewing the diff catches the first kind
because the claim and the code are both in the diff. Catching the second needs someone to ask
what *else* now depends on the lines that moved — which is why the review was asked to read
full files rather than the diff alone.

The demo path had a third variant. `npm run redeem` resolved the pool as `poolsFor(url)[0]`,
the earliest pool ever opened for the resource, which is wrong as soon as a slug is demoed
twice — and it already was, live. It had also never set an operator on its Hedera client, so
the command failed before reaching its own logic. The second bug hid the first: a script that
cannot run cannot be observed picking the wrong pool. Both were found by running it against
testnet rather than by reading it, which is the only way either would have surfaced.

A second pass over the same branch asked four reviewers a different question — not "is this
correct" but "is this *well built*": one each on reuse, unnecessary complexity, wasted work, and
whether each fix sat at the right depth. They ran independently and did not see each other's
findings.

The overlap is the interesting part. Three of the four independently arrived at the same place
from different directions: the reuse reviewer found the refund selector and a base64 codec each
written twice more; the simplification reviewer found four configuration knobs nothing sets, an
index result with two fields nothing reads, and a dead client method; the altitude reviewer found
that the "a read that failed is not a fact about the receipt" rule had been applied to four reads
and missed the fifth. Different lenses, one underlying habit — **surface added in anticipation of
a caller that never arrived, and a rule stated in more places than it was applied**.

The efficiency reviewer found the sharpest single thing, and it was a comment that had become a
lie. `redeem.ts` said expiry was checked first "so a stale receipt costs two network reads less
than a fresh one" — and the wiring around it had since put three paid contract queries ahead of
the clock. The check was in the right order inside the function and the wrong order in the
system, which is a distinction no amount of reading that file would surface.

Worth naming: two of these findings were repairs to fixes made earlier the same day. Work done
under review pressure goes deep enough on the thing being pointed at and stops there — the 503
rule was applied to every read the reviewer had listed and to none it had not. That is not a
failure of care; it is what "address the feedback" tends to mean in practice, and it is a reason
to re-read a fix after the pressure is off.

A third pass asked the narrowest question yet, and it was the one the paragraph above had just
argued for: not "is this branch correct" but "are the *repairs* correct". The reviewer was given
the four commits the first two reviews produced, and the branch only as context.

It found a regression neither earlier pass could have caught, because it did not exist when they
ran. `depositFor` had returned `IndexedDeposit | undefined`; consolidating the lag into it made
it return an object that is always present, with the position as an optional field. The demo
script still tested the result for truthiness. That check is now always true, so `npm run redeem`
took the first pool it tried without asking the index anything — the newest pool naming the slug
— and the refusal below it became unreachable in the same stroke. The visible symptom is a payer
being told 404, that their settlement never happened or is not yet indexed, about a settlement
that happened and is indexed. It re-broke a bug fixed on this same branch nine commits earlier.

Three safety nets had the same hole. The deletion audit checked that removed things had no
callers, and this was not a deletion — it was a signature change, which needs the opposite
question asked. `tsc` sees nothing wrong with testing an object for truthiness, because there is
nothing wrong with it. The ESLint rule that catches exactly this, `no-unnecessary-condition`,
lives in the type-aware set this repo turns off for speed. And the one directory where all three
gaps overlap is `scripts/`, which has no tests at all.

The second finding is the same shape from the other side. Folding `_meta` into the deposit query
saved a round trip and silently spent a `.catch(() => undefined)` that had been protecting it —
the tolerance existed only because the call used to live somewhere else, and moving it did not
look like removing it. The result was that an index able to say exactly where a deposit sat would
answer 503 to a payer holding a good seat, because a diagnostic field beside the answer had
failed. GraphQL returns partial data with errors by design, so this is the ordinary case, not an
exotic one.

Underneath both: **the reviews found the code wrong, and the fixes for them were written against
the diff rather than against the callers.** A repair changes a signature far more often than it
changes a behaviour, and a signature change puts its consequences outside the diff by definition.
That is why the earlier passes kept finding blast-radius defects and this one did too — the
category never closed, it just moved to whatever had been edited most recently.

Worth recording separately: `src/graph/client.ts` had no tests. Every test in the suite stubbed
`depositFor` and checked what the server did with the result, so the response shape — the single
thing a subgraph is free to vary, and where both of these defects lived — had only ever been
exercised against testnet, on the path where nothing goes wrong. It has eight now, seven of them
about partial success.

The refund branch was reviewed before it merged, given the diff, the specs and the ADRs. Nothing
in the code was wrong. Three of the four findings were assertions that could not fail.

The run's headline claim is that the crowd fell one seat short, and the only thing it read to
support that was `statusOf` — which answers `Open` for a pool nobody was seated in exactly as
readily as for one holding two of three seats. The lazy-expiry assertion had the same shape from
the other end: `statusOf` resolves the deadline live, so it reads `Expired` whether or not
anything stamped the pool, and the assertion therefore held just as well against the eager keeper
ADR 0004 exists to argue against. And `refundAll`'s docstring told a caller to advance its window
against `depositCount`, which was on the contract and not on this client — an instruction
unfollowable from the language it was written for.

That last one is this branch's own bug, one level up. The branch exists because `claimRefund` and
`refundAll` were fully tested and had no caller; it then shipped a documented path with nothing
able to walk it. The lesson did not generalise one step beyond the case that taught it.

Four reviews running, the same category: prose asserting a property nothing reached. What is new
is where it landed. The earlier ones found it in specs describing contracts, where the prose and
the thing it describes are visibly different artifacts. This one found it in a test's own success
messages, which is the hardest place to see it, because a passing run reads as evidence — and a
passing run of an assertion that cannot fail reads identically.

The fourth finding was not that shape, and was the one with money behind it. The deadline wait
slept until the local clock passed the deadline and then one second more: the only assumption in
a harness that otherwise polls three networks for everything. A clock ahead of consensus by more
than that second does not produce a flaky assertion — the `claimRefund` after it reverts, the
revert throws, and the scenario unwinds before `refundAll` runs, leaving both deposits in the
contract with nothing left in the run to push them back out. The cost of the assumption was not
the assertion it broke but the four steps behind it that never got to run.

---

### A cleanup pass over the demo UI, 2026-09-09

The demo-UI branch was reviewed again after it merged, this time by four Claude Code agents run
in parallel and told explicitly *not* to look for bugs: one each for duplication, unnecessary
complexity, wasted work, and whether a fix sat at the right depth. They were given the diff and
the tree, not the conversation. What came out of it was a branch of small commits — and then a
second review, which found something the first one had introduced.

The finding worth recording is the one the code had already claimed was impossible. `poolSummary`
had been exported the week before, carrying a comment that it was exported *"because the demo UI
renders the same six facts and inventing a second shape for them would let the two drift"* — and
nothing ever imported it. The demo rebuilt all six fields by hand in the same branch. Three of
the four agents found it independently, which is the only reason it is here: it is invisible to
every tool in the repo, because an unused export and a hand-written object are both perfectly
legal. The comment was not aspirational when it was written; it was false when it was written.

That is the same category this file has been recording since the contract review — prose
asserting a property nothing reached — but a step worse than the earlier cases. Those were specs
describing a contract, two visibly separate artifacts. This was a doc comment on the function
itself, written in the commit that made it untrue, and it read as evidence that the sharing had
happened. A reader chasing "where does the page get its pool shape from" would have followed it
to a dead end and concluded the question was answered.

The other substantive finding was waste rather than wrongness, which is why nothing caught it
either. `PoolRegistry.scan()` advanced its cursor only after every read resolved, so two lookups
entering together both read forward from the same point and filed every pool id twice. Nothing
resolved to the wrong pool — the ordering survives duplication — so no test could have failed.
It only ever cost paid contract queries, permanently, and the page that asks about every
benchmark at once triggers it on the first poll. A test now pins it, and it was confirmed to fail
without the fix before being kept.

**What the reviewers got wrong.** Line numbers, routinely — one cited a symbol at line 458 of a
145-line file, and several anchors were off by enough that every finding had to be re-verified
against the file before it could be acted on. More instructive: one agent argued the pool cache's
three-second TTL "can never hit" because the page polls every four seconds. The arithmetic is
right and the conclusion is wrong — the cache exists to stop one poll reading the same pool once
per panel, not to serve the next poll — so the recommendation would have made a live demo staler
to fix a problem that was not there. Two agents, ranked high and independently, also proposed
preferring the chain's resolved state over the locally-derived one. That is a real inconsistency
and possibly worth doing, but it changes which clock decides that a pool has expired; it was
filed as a cleanup and it is not one.

**The cleanup that could have killed the demo.** One finding was that all six demo handlers ended
in `res.json(...)`, with `res` threaded through the route wrapper only to be called at the end.
That is a real duplication and the repair — let the wrapper own the write — is the obvious one. It
shipped in `50e36e1` with the write passed as `.then`'s first argument and the error handler as
its second, which makes the two siblings rather than putting the handler downstream of the write,
and drops the promise `.then` returns. A handler resolving with a `BigInt` — which any raw ledger
amount is — throws inside `res.json`, and that throw then had nowhere to go: no 500, no log line,
an unhandled rejection, and Node ends the process on those. The one failure the wrapper existed to
catch was the one it stopped catching.

Nothing in the repo noticed. Lint, `tsc` and the full suite passed, because the defect is a
dropped promise on a path no test drove. It was caught in review on the pull request, two commits
later, and fixed in `be96423`.

That is a sharper case than the rest of this section. The other entries are about proposed changes
that should not have been applied. This one *was* applied, and correctly identified — the
duplication was real — and the repair introduced a way to take the process down. The lesson is not
that the finding was wrong. It is that acting on a correct finding is itself a code change, and it
needs the same review as the code that prompted it.

**A correction to the record.** `be96423`'s message describes the bug as `res.json` having been
handed to `.then`'s *"second-chance slot"*. It was in the fulfilment slot; the defect was the
two-argument form, not which argument the write was. That commit is on a shared branch and its
prose is not worth rewriting history for — §3 keeps the history as it happened — so the correction
lives here. It belongs in this section on its own merits: this is the file that tracks comments
asserting what the code does not do, and the commit that fixed one had the same flaw.

The pattern across the four: agents told to find quality problems will find them, and the cost of
that is not false positives so much as **confidently-argued changes to intended behaviour,
presented in the same register as a dead-code removal.** Four of the fourteen findings applied
were skipped for exactly that reason and are written down in the pull request rather than
silently dropped. The reviews were worth running — three of them converged on the export nobody
used — but none of the fourteen was safe to apply on the strength of the report alone.

---

### The branch reviewed as a whole, 2026-09-10

The branch was reviewed once more before merging, by a single agent given the diff, the specs and
the constraints — not the conversation — and told where the seats had already been spent: the
first seventeen commits had had a Copilot pass, and the five findings the pull request had
declined were handed over with the reasoning, so the pass would not spend itself re-arguing them.
It returned no Critical findings, two Important, and eight Minor.

Both Important findings were **interactions between commits that were each correct alone**, which
is the class a per-commit review cannot see. The in-flight guard added in `77405aa` and the wallet
switch's `waitFor(refresh)` added in `fdacc1e` never appeared in the same diff. Together they
dropped a refresh the *user* had asked for, and the page then rendered one buyer's name and
balance above another buyer's seat cards with live buttons on rows that were not theirs. The
second was subtler: caching the seller's form fixed the reported symptom completely — selections
do survive — while leaving `replaceChildren` to detach and re-attach the cached node every four
seconds, which drops focus and closes an open dropdown. The bug reported was fixed; a bug nobody
had reported, with the same appearance on camera, was not.

Three of the Minor findings were sentences this branch had made false: a comment saying
`sellingPoolFor` returns "not the newest pool" two commits after it started doing exactly that, a
README naming a seat bar that had become dots, and a constant documented as what the page shows
when it is what the page holds. §5 has been recording that fault since the contract review. It is
worth noting that all three were *introduced by the fixes on this branch* rather than surviving
from earlier work — the edit that changes behaviour and the sentence describing it are the same
commit's responsibility, and three times here they parted company inside it.

**What made this round different from the four that preceded it.** The line numbers were accurate
and every finding survived checking, which is the opposite of the September 9 experience. The
plausible reason is scope: one agent over a whole branch with the declined findings in hand, rather
than four agents over one diff each with an instruction to find a category of problem. An agent
told to find duplication will return duplication whether or not any is worth acting on; an agent
asked whether a branch is ready to merge can answer that it nearly is.

**The harness that was thrown away, and thrown away again.** The reviewer's third Important
finding was that `public/app.js` carries the page's entire concurrency model and none of it is
reachable by `npm test` — and that the stubbed-DOM harness written on 2026-09-09 would have caught
both of the findings above, had it been kept. It was rebuilt to verify these two fixes: each was
reverted on its own and its own assertion was confirmed to fail, which is how the form was found
to be detached exactly twice by two polls. Then it was thrown away a second time, deliberately, as
a call about the hours left rather than about its value. It is the one recommendation from this
review that was understood, agreed with, and not acted on.

**The eight Minor findings, and the one that was filed too low.** All eight were acted on after
the two blocking ones. Six were what they looked like — a registry method handing out the array it
indexes with, a page that wrote failed polls to a console nobody has open, a `busy` class that only
a *working* script could remove, a service card drawing the crowd without marking the reader in it,
and two sentences describing the code beside them.

The seventh was not. `seatsElsewhere` was filed as wording: a count of deposits presented as a
count of seats, capped at the index query's default of 25 and so a floor rather than a total.
Reading the call site showed the same 25 governs `indexed`, which is what the *rendered* seat list
is built from — so an address holding more than 25 deposits does not merely get an understated
footnote, it gets a real seat in a pool this coordinator sells dropped from the page, while a note
underneath explains a gap the query itself created. Ephemeral-port deposits from repeated
`npm run e2e` runs are exactly what fills that window, on exactly the machine the demo is recorded
from. It is now bounded at 100, and saturation is reported rather than assumed away.

Worth recording because it runs the other way from everything else in this file. §5's pattern is
reviewers arguing confidently for changes that should not be made; this was a reviewer describing
a real defect in terms milder than it deserved, and only checking the finding against the code
rather than against the report turned up the rest of it. A report's severity is a claim like any
other in it.

**The harness, and what building it found.** It was rebuilt a third time for these fixes, and
then committed as `test/demo-page.ts` - eight tests, six of which fail against the branch as it
stood that morning. `public/app.js` had been unreachable from the suite: a browser file the other
tests cannot import and the type checker barely reads, holding the wait counter, the guard against
overlapping reads, the sequence number that orders their answers and the form kept across renders.
Every defect this round found lived there.

What is worth recording is that **writing the stub found a bug the review had not.** Modelling
`isConnected` honestly - true only while a node can be reached from `<body>` - made a countdown
render as an empty span in the harness. That is not a stub artifact. `countdown` ticks once before
returning its node, at which point the caller has not appended it, so `isConnected` is false for
every countdown ever built: the first tick painted nothing and scheduled nothing, and no later
tick existed to fix it. Every service card and every open seat card had carried a blank where the
deadline goes since the demo UI landed, and the README lists "the deadline counting down" among
what the page shows.

Nothing could have caught it. It is legal code, the element is genuinely in the DOM, lint and
`tsc` have no opinion, and the page looks complete unless you know a clock belongs in that row.
Four review agents, a Copilot pass and a whole-branch review all read past it; so did every person
who opened the page. It surfaced because a test had to answer a question none of them asked - what
is in that span - and answering it required modelling the one DOM property the code depends on.

That is the argument for the file, better than the one the reviewer made. A harness is usually
defended as a net under future changes. This one paid for itself while being written, by forcing
a claim about the rendered page to be stated precisely enough to be false.
