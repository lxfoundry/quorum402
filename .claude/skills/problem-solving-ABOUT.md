# Skills — Attribution & Local Modifications

21 skills are vendored here from three upstream repositories.

| Skills | Source | License |
|---|---|---|
| `when-stuck`, `inversion-exercise`, `meta-pattern-recognition`, `collision-zone-thinking`, `scale-game`, `simplification-cascades`, `root-cause-tracing` | [obra/superpowers-skills](https://github.com/obra/superpowers-skills) @ `cdcd624` (2025-10-14) | MIT, © 2025 Jesse Vincent |
| `writing-plans`, `brainstorming`, `subagent-driven-development`, `executing-plans`, `requesting-code-review`, `receiving-code-review`, `finishing-a-development-branch`, `test-driven-development`, `systematic-debugging`, `dispatching-parallel-agents`, `verification-before-completion`, `writing-skills`, `using-superpowers` | [obra/superpowers](https://github.com/obra/superpowers) @ `b36e082` (2026-08-12) | MIT, © 2025 Jesse Vincent |
| `feature-planning` | [mhattingpete/claude-skills-marketplace](https://github.com/mhattingpete/claude-skills-marketplace) (`engineering-workflow-plugin`) @ `b5b34bc` (2026-07-24) | Apache-2.0 |

Where a skill existed in both `obra` repos, the newer `obra/superpowers` copy was
taken. `root-cause-tracing` exists only in `superpowers-skills`, so it comes from
there — note that `systematic-debugging` also bundles its own
`root-cause-tracing.md` supporting doc, so that material appears twice.

## Problem-solving lineage

The six problem-solving skills (`when-stuck`, `inversion-exercise`,
`meta-pattern-recognition`, `collision-zone-thinking`, `scale-game`,
`simplification-cascades`) were derived upstream from agent patterns in the
[Amplifier](https://github.com/microsoft/amplifier) project
(commit `2adb63f858e7d760e188197c8e8d4c1ef721e2a6`, 2025-10-10):

- **From the `insight-synthesizer` agent:** `simplification-cascades`,
  `collision-zone-thinking`, `meta-pattern-recognition`, `inversion-exercise`,
  `scale-game`
- **Dispatch pattern:** `when-stuck` — maps stuck-symptoms to the right technique

## Local modifications

Vendored as plain project skills rather than as a plugin, which required these
edits. Upstream content is otherwise unchanged.

1. **Frontmatter `name:` normalised to the directory name.** The
   `superpowers-skills` originals use title case with spaces
   (`Collision-Zone Thinking`, `Root Cause Tracing`, `When Stuck -
   Problem-Solving Dispatch`); Claude Code requires kebab-case matching the
   skill directory, so they would otherwise fail to load.
2. **`when_to_use:` folded into `description:`.** `description` is the only
   field Claude Code reads for skill discovery, so the trigger text was
   appended to it rather than left in a field that is never consulted.
3. **`superpowers:<skill-name>` cross-references rewritten to bare names.**
   The plugin namespace does not resolve in a project install.
4. **`when-stuck` dispatch targets rewritten** from repo paths
   (`skills/problem-solving/scale-game`) to bare skill names.

## No worktrees (project decision)

This project does not use git worktrees. Skills that instructed the agent to
create one now say to create a dedicated branch instead:

- `executing-plans` (Step 1), `subagent-driven-development` (Setup),
  `writing-plans` (Context note) — worktree creation → dedicated branch
- `requesting-code-review/code-reviewer.md` — inspecting another revision now
  suggests `git archive` into a temp dir rather than `git worktree add`
- `using-git-worktrees` was **deliberately not installed**

`finishing-a-development-branch` retains its worktree *cleanup* logic. It
self-detects (`GIT_DIR == GIT_COMMON` → "normal repo, no worktree to clean
up"), so in this repo that path is inert — it never creates one.

Remaining `worktree` matches elsewhere are incidental: `WorktreeManager` is a
class name in unrelated example bug scenarios in `root-cause-tracing` /
`systematic-debugging`, and `using-superpowers/references/codex-tools.md` is a
Codex-CLI-only reference file that Claude Code never reads.

## Not installed

From the same upstream groups: `using-git-worktrees` (see above),
`preserving-productive-tensions` (architecture), `tracing-knowledge-lineages`
(research), `defense-in-depth`, `remembering-conversations`.

## Notes

- `using-superpowers` is designed to be force-loaded at conversation start by
  the upstream plugin's SessionStart hook. Since these are plain project skills
  with no plugin, that hook is reproduced locally:
  `.claude/hooks/session-start-superpowers.py`, wired up in
  `.claude/settings.json`. It reads the skill and emits it as
  `additionalContext` at every session start, and exits silently if the skill
  is ever removed. Its "Platform Adaptation" section lists
  Codex/Pi/Antigravity/Hermes reference files — none apply to Claude Code.
- `brainstorming`'s optional visual companion writes to `.superpowers/brainstorm/`
  in the project root. Add that to `.gitignore` before using it.
- `writing-plans` defaults to saving plans at `docs/superpowers/plans/`, and
  `brainstorming` to `docs/superpowers/specs/`. These are upstream defaults,
  left unchanged — see CLAUDE.md for this repo's `docs/` numbering convention.
