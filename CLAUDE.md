# CLAUDE.md

Guidance for Claude Code working in this repository.

---

## What this is

**`quorum402`** — an HTTP 402 challenge that a crowd can answer together. Funds are held;
the resource unlocks only if enough separate buyers pay before the deadline; otherwise
everyone is refunded.

Built from scratch for **ETHOnline 2026**, Classic / "From Scratch" track. This repository
is **self-contained**: everything the project needs is here, and nothing outside it is a
dependency of the build.

**The primitive, stated without naming any integration:**

> An HTTP 402 challenge that a crowd can answer together — funds are held and the resource
> unlocks only if enough separate buyers pay before the deadline, otherwise everyone is
> refunded.

If a description of this project collapses into "it integrates X, Y and Z", the primitive
has been lost. Integrations serve the primitive; they are not the point of it.

| | |
|---|---|
| Settlement target | Hedera Testnet (`hedera:testnet`) |
| Proposed x402 scheme | **`quorum`** |

---

## 🔴 The rules that override everything

### 1. This repository is public, and stays public

**Never commit a secret.** Not a private key, mnemonic, seed phrase, API key, RPC URL with
an embedded token, or a funded account's credentials. A public repo cannot be un-published,
and rotating after the fact does not undo the disclosure.

- Secrets live in `.env`, which is gitignored. Commit `.env.example` with empty values
- Before any commit that adds a config, deploy script or test fixture, check it for
  literals that should be environment variables
- Testnet keys are still keys. Treat them the same way

### 2. Nothing in this repository predates the event

The Classic track requires that project code, designs and assets be created after the
hackathon starts. Everything here is written while it runs, in the open, in this repo.

**Research and reading done beforehand may inform what you write — it must never be pasted
in as though it were produced during the build.** Knowledge is fine; artifacts are not.
When in doubt, write it fresh rather than importing it.

Only genuinely public libraries and starter kits are exempt, and they must be attributed.

### 3. The commit history is a deliverable

ETHGlobal disqualifies submissions with *"large single commits or missing histories"*.

- **5–8 commits on a day of active work**, one logical change each
- Commit as the work happens. Never bank a day into one evening push
- Never squash, never force-push over the build history, never backdate
- Themed, scoped messages: `feat(escrow):`, `spec(quorum):`, `docs(readme):`, `test(pool):`

The history should show the thing being figured out, because it is.

#### How work reaches `main`

**Every change lands through a branch and a pull request. Nothing is committed to `main`
directly.**

```
git checkout -b <type>/<short-slug>     # feat/ fix/ docs/ spec/ chore/ test/
# ... commit as the work happens, 1 logical change per commit ...
git push -u origin <branch>
gh pr create --fill                     # then merge it
```

- **Branch names** are `<type>/<short-slug>`, matching the commit prefixes above:
  `feat/threshold-escrow`, `spec/quorum-semantics`, `fix/tinybar-precision`
- **One branch is one coherent piece of work**, not one day of it. If a branch has been open
  long enough to touch three unrelated things, it should have been three branches
- **The granularity rule still applies inside the branch.** A PR containing one enormous
  commit is the same defect as a single-commit day; the branch is where the small commits
  live, and the PR is how they arrive together
- **The PR body says what changed and why**, and links the ADR when a decision drives it.
  Self-merging is fine on a solo project - the PR is a record, not an approval ritual
- **Delete the branch after merge** (the repository does this automatically)

#### 🔴 Merge with a merge commit. Never squash

Squash-merging collapses a branch into a single commit and **destroys exactly the granularity
this project is judged on** - it converts five small, legible commits into one large one, which
is the shape ETHGlobal names when it disqualifies for *"large single commits"*.

Squash and rebase merging are **disabled on the repository**, so the button is not there to
press. The rule is written down anyway, because a settings change must not silently become a
policy change.

The same reasoning rules out force-pushing a shared branch and rewriting merged history. A
branch that is still unmerged and unshared may be tidied freely - that is what branches are
for.

### 4. `AI-USAGE.md` and `specs/` are required deliverables

ETHGlobal's AI policy obliges spec-driven teams to ship **all spec files, prompts and
planning artifacts**. This project is built with Claude Code, so that clause binds.

- `specs/` grows **alongside** the code — dated files, written before or with the work,
  never reconstructed afterwards
- `AI-USAGE.md` is updated **daily**, not at the end. It must record what AI got wrong as
  well as what it produced
- The scheme spec is itself a headline deliverable, not documentation overhead. Writing it
  well *is* the contribution

---

## The `quorum` scheme — what it binds to

**Decided 2026-09-07. Do not re-open it mid-build.**

`quorum` defines coordination over **N payers** — a threshold, a deadline, and a collective
capture-or-release — and is deliberately **orthogonal to how any individual hold is
implemented**. Three candidate bindings are named; exactly one is built.

| Binding | In this project | Upstream status |
|---|---|---|
| **`exact` + pool contract, on Hedera** | ✅ **Implemented and demonstrated** | Merged; 17 network bindings |
| **`auth-capture`** | One honest paragraph. **Not built** | Merged; **EVM-only** |
| **`escrow`** ([x402#2222](https://github.com/x402-foundation/x402/issues/2222)) | One honest paragraph. **Not built** | **Proposed, still open** |

`auth-capture` was not composed over directly because it has **no Hedera binding** — only an
EVM one — and the facilitator this project settles through does not serve it. That is a
feasibility decision, not a judgement on the design.

**Why both unbuilt bindings are named.** `auth-capture` and `escrow` are competing answers to
the same question: whether the hold mechanism belongs in the scheme, or behind a wire format
that leaves it implementation-defined. If `quorum` binds cleanly to both, it is orthogonal to
the axis the ecosystem is currently arguing about — it survives either outcome. One binding
alone would only be an illustration.

⚠️ **Hold the count at three.** Two unbuilt bindings is the argument; four would read as
having built none of them. Write a short, honest paragraph for each unbuilt binding — how
`quorum` would bind, and what is unproven. **Do not write a full binding spec for either.**

### 🔴 Required disclosure

**x402 issue #2222 (`scheme: "escrow"`) was authored by this project's author, on behalf of
Boson Protocol, and remains open.** It is public and attributable to the same GitHub account
that authors the commits here.

Wherever #2222 is cited — in `specs/`, in the README, in the video if it comes up — **state
that plainly, in one factual sentence.** For example:

> *`escrow` (x402-foundation/x402#2222) is a proposal authored by this project's author on
> behalf of Boson Protocol, and remains open. It is cited here as one of two candidate hold
> bindings, not as settled standard.*

Undisclosed, it is one click from discovery and reads as self-promotion dressed as neutral
analysis. Disclosed, it is a credential. There is no version of this where hiding it wins.

### ⚠️ Cite, never import

#2222 dates from 2026-05-07, and `bosonprotocol/x402-escrow-schema` and `bosonprotocol/x402B`
are pre-existing work. **Referencing a published public proposal is fine. Copying spec text or
contract code out of those repositories into this one is not** — it would be exactly the
prior-work import the Classic track prohibits. Read them if useful; write everything here
fresh.

---

## The README is how the project gets verified

Judges verify asynchronously by reading the README. It must, before submission:

- [ ] Describe the primitive in one sentence, before any integration is named
- [ ] List **deployed contract addresses** with explorer links
- [ ] Point at the **exact contracts and lines** implementing each integration
- [ ] Give setup instructions **verified from a clean clone** — not from your machine
- [ ] Link the demo video

An integration a reader cannot locate in the code counts as absent.

---

## Working rules

- **Solidity/TypeScript conventions follow whatever is already in the tree.** Match the
  surrounding code's naming, comment density and idiom rather than importing a house style
- **Tests are for the things that would be embarrassing to get wrong**: threshold
  arithmetic, the refund path, deadline boundaries, double-spend and replay. Not coverage
  for its own sake
- **Absolute dates** (`2026-09-07`), never "tomorrow" or "next week"
- **No project-specific content in `.claude/skills/`** — those are a general-purpose public
  library and stay that way. Project instructions belong in this file
- **A smaller thing that works beats a larger thing that does not.** Prefer deleting a
  feature to shipping one that does not work in the demo

## Claude Code skills

`.claude/skills/` holds the [Superpowers](https://github.com/obra/superpowers) library by
Jesse Vincent (`obra`), MIT-licensed. Provenance in `.claude/skills/VENDORED.md`.

They are **committed on purpose**: they are prompts, and ETHGlobal's AI policy asks for
prompts. `AI-USAGE.md` records their provenance.

Use them where they fit — `brainstorming` before designing, `test-driven-development` for
the escrow arithmetic, `systematic-debugging` when something is wrong and the cause is not
obvious. Do not modify them; project-specific guidance goes in this file instead.
