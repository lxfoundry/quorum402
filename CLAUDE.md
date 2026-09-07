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
| Build window | **2026-09-07 → 2026-09-11**, Sep 12 in reserve |
| Feature freeze | **2026-09-11, midday** |
| Submission | **by end of 2026-09-12** — the deadline is Sep 13, 12:00 EDT, and we do not use it |
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

### 2. All work in this repository is done during the build window

The Classic track requires that project code, designs and assets be created after the
hackathon starts. Everything here is written in the window, in the open, in this repo.

**Research and reading done beforehand may inform what you write — it must never be pasted
in as though it were produced during the build.** Knowledge is fine; artifacts are not.
When in doubt, write it fresh rather than importing it.

Only genuinely public libraries and starter kits are exempt, and they must be attributed.

### 3. The commit history is a deliverable

ETHGlobal disqualifies submissions with *"large single commits or missing histories"*.

- **5–8 commits per build day**, one logical change each
- Commit as the work happens. Never bank a day into one evening push
- Never squash, never force-push over the build history, never backdate
- Themed, scoped messages: `feat(escrow):`, `spec(quorum):`, `docs(readme):`, `test(pool):`

The history should show the thing being figured out, because it is.

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
  for its own sake — there are five days
- **Absolute dates** (`2026-09-11`), never "tomorrow" or "next week"
- **No project-specific content in `.claude/skills/`** — those are a general-purpose public
  library and stay that way. Project instructions belong in this file
- Prefer deleting a feature to shipping one that does not work in the demo

## Scope discipline

Five build days, one reserve day, no slack behind it. When something overruns, cut scope
rather than the reserve:

| If this is at risk | Cut to this |
|---|---|
| Multi-payer flow not settling | A single-payer x402 flow that works end to end |
| Threshold settle-or-refund incomplete | Threshold logic without the scheme framing |
| Demo not reproducible unattended | Fewer buyers, shorter deadline |

A smaller thing that works beats a larger thing that does not. Do not start anything on
Sep 11 that cannot land by midday.

---

## Claude Code skills

`.claude/skills/` holds the [Superpowers](https://github.com/obra/superpowers) library by
Jesse Vincent (`obra`), MIT-licensed. Provenance in `.claude/skills/VENDORED.md`.

They are **committed on purpose**: they are prompts, and ETHGlobal's AI policy asks for
prompts. `AI-USAGE.md` records their provenance.

Use them where they fit — `brainstorming` before designing, `test-driven-development` for
the escrow arithmetic, `systematic-debugging` when something is wrong and the cause is not
obvious. Do not modify them; project-specific guidance goes in this file instead.
