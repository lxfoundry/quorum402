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
| 2026-09-07 | Lint and CI (`.github/workflows/ci.yml`) | Wrote the ESLint and solhint configs and the workflow, and ran both linters over the tree to find what they flagged | Decided that warnings fail the run, and that the three the test fixtures raise are turned off at the line with a reason rather than repo-wide; kept the Solidity line-length limit off the contract |

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
