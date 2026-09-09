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
