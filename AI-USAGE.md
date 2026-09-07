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
| TODO | TODO | TODO | TODO |

## 4. What was done without AI

TODO — design decisions, the scheme semantics, protocol reading, debugging judgement, and
anything else where the thinking was not delegated.

## 5. What AI got wrong

TODO — kept deliberately. A build with no entries here is not being honest about the tool.
