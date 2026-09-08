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
| 2026-09-08 | `specs/quorum-scheme.md` and ADR 0005 | Read the x402 v2 specification, its HTTP transport and the `exact` scheme documents, then drafted the scheme spec and the decision record against them | Set the design in a question-by-question session before a line was written: that a legacy `exact` client must still be able to pay, that entitlement is derived from chain state rather than held in a session, that pools are opened by the seller and never by the server, and that the scheme nests its hold binding rather than referencing it |

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
this file already records twice today: writing down a property the evidence had not been
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

It is the day's fourth instance of one shape: a claim written down, then built on, without the
evidence for it ever being fetched. The first three were prose overstating what the code did.
This one ran the other way - prose the code obeyed - and it is the more dangerous direction,
because the code cannot disagree with a premise it was derived from.

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

**2026-09-08 — a diagram written yesterday used the previous protocol version's header.** The
flow in `specs/pool-contract.md` had the buyer retrying with `X-PAYMENT`, which is x402 v1; v2
uses `PAYMENT-SIGNATURE`. The same diagram gave a settled-but-undelivered payment a 200. Both
were written from recall rather than from the transport document, and both were found by opening
it.

All three are the same shape as the four entries above them, and the shape is now worth naming
outright: **this tool states things about external specifications fluently and from memory, and
the fluency is uncorrelated with whether the document says it.** Every one was caught by fetching
the source; none was caught by thinking harder about it.

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
