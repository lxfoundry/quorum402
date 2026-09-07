# specs/

The design record for `quorum402`, written as decisions are made rather than reconstructed
afterwards.

This directory is a **required deliverable**: ETHGlobal's AI policy obliges teams using
spec-driven workflows to ship all spec files, prompts and planning artifacts. It is also the
honest record of how the project was reasoned about — including options that were considered
and rejected, and limitations that were accepted deliberately.

## Layout

```
specs/
├── README.md          this file
└── adr/               architecture decision records, numbered and dated
```

## Architecture decision records

Each ADR captures one decision: the context that forced it, the options weighed, what was
chosen, and what it costs. They are **append-only in spirit** — a decision that turns out
wrong gets a new ADR that supersedes it, rather than a quiet edit.

| # | Decision | Date | Status |
|---|---|---|---|
| [0001](adr/0001-what-quorum-binds-to.md) | What `quorum` binds to | 2026-09-07 | Accepted |
| [0002](adr/0002-payment-attribution-on-hedera.md) | Payment attribution on Hedera | 2026-09-07 | Accepted |
| [0003](adr/0003-pool-authority-model.md) | Who may do what to a pool | 2026-09-07 | Accepted |

## Conventions

- **Absolute dates**, always (`2026-09-07`), never "today" or "last week"
- **Claims are sourced.** Where a decision rests on an external fact — a spec quote, a live
  API response, a HIP status — the ADR cites it and, where practical, shows the evidence
- **Rejected options are written down with the reason.** An ADR that lists only the chosen
  path hides the part that was actually hard
- **Limitations are named, not buried.** Where a design has a known weakness, the ADR says so
