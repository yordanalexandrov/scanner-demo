# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one glossary at the root, one decision log.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary.
- **`docs/decisions.md`** — the architecture decision records. This repo keeps every ADR in that one
  file, numbered `ADR-1`, `ADR-2`, … (no zero padding), rather than one file per decision under
  `docs/adr/`. Read the ADRs that touch the area you're about to work in.

`AGENTS.md` also lists the specification, the phase documents and the deployment-target notes under
_Read before changing anything_. Those are the project's own reading list and take precedence over
anything a skill infers from the code.

If `CONTEXT.md` doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest
creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates it lazily when terms actually get resolved.

## File structure

```
/
├── CONTEXT.md              ← domain glossary (created lazily)
├── AGENTS.md               ← agent instructions; CLAUDE.md is a symlink to it
├── docs/
│   ├── decisions.md        ← all ADRs, numbered ADR-NN
│   ├── phases/             ← one document per phase
│   └── scanner-demo-claude-code-prompt.md   ← the specification, source of truth
├── app/
├── server/
└── packages/shared/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly
avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-10 (never subtract a phone-measured value from a server-measured one) — but worth
> reopening because…_

Reference ADRs by their number, matching the convention `AGENTS.md` sets for comments and commit
messages.

## New decisions go in `docs/decisions.md`

When `/domain-modeling` records a decision, append it to `docs/decisions.md` with the next `ADR-<n>`
number and the same section shape the existing entries use. Do not start a `docs/adr/` directory —
two decision stores drift, and `AGENTS.md` and the phase documents already point at this one.
