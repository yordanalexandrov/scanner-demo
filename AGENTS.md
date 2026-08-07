# AGENTS.md

Instructions for coding agents working in this repository. `CLAUDE.md` is a symlink to this file, so
there is one set of instructions rather than two that drift apart.

## What this repository is

`scanner-demo` is a **benchmark harness, not a product**. It measures, on real supermarket packaging:

1. how fast on-device EAN-13 barcode scanning is, and
2. how four expiry-date extraction methods compare in **accuracy, latency and cost** — ML Kit
   on-device, a self-hosted RapidOCR sidecar, Google Cloud Vision, and a VLM.

Every design decision serves _measurement and fair comparison_. When polish and comparability
conflict, comparability wins. Optimise for "I can trust these numbers", never for "this looks nice".

The practical consequence: a change that makes the app nicer but makes two methods measured
differently is a regression. Say so rather than shipping it.

## Non-negotiable constraints

These come from the specification and are not open for re-litigation. If a task appears to require
breaking one, stop and say so instead of working around it.

| Constraint                                                           | Note                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript only. No Python anywhere**                              | Including inside the OCR container, which is a pre-built black box used through configuration only                                                                                                            |
| **Android only**                                                     | No iOS code paths, no Swift, no iOS project configuration — but nothing hardcoded that makes adding iOS painful later. Platform-specific bits go behind normal `Platform` checks                              |
| **The app holds zero provider credentials**                          | GCV and the VLM are called only from the server, which reads keys from environment variables. The app carries one shared bearer token, which is bundled into the APK and deliberately not treated as a secret |
| **The deployment box is CPU-only**                                   | Never install CUDA builds. It also has 2 cores and ~2.2 GB RAM, shared with live production                                                                                                                   |
| **Durations use `now()`/`elapsed()` from `@scanner-demo/shared`**    | Never `Date.now()`. It is a wall clock: it jumps and can run backwards. It is fine for timestamps that get ordered, never for durations. ESLint enforces this                                                 |
| **Never subtract a phone-measured value from a server-measured one** | Two unrelated clocks. The one quantity spanning both is reported as a labelled estimate from two stored fields — ADR-10                                                                                       |
| **A null measurement is `null`, never `0`**                          | `null` means "not applicable on this path". A gallery import has no capture time; rendering that as `0 ms` corrupts every average                                                                             |
| **An unknown price is `null`, never `0`**                            | A cost that is not yet known must never be indistinguishable from a free one — ADR-11                                                                                                                         |
| **No frame processors or worklets**                                  | Use `react-native-vision-camera`'s built-in `useCodeScanner`                                                                                                                                                  |
| **Never convert camera frames to Bitmap**                            | Applies to every camera path, not one screen                                                                                                                                                                  |
| **All code, comments, commit messages and docs in English**          | The repository is public                                                                                                                                                                                      |

## Read before changing anything

The plan is written down. Read the relevant document rather than inferring intent from the code.

| Document                                  | What it is                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `docs/scanner-demo-claude-code-prompt.md` | The original specification. **Source of truth.**                            |
| `docs/phases/README.md`                   | Phase index, dependency graph, requirement coverage matrix                  |
| `docs/phases/NN-*.md`                     | One per phase: goal, scope, out of scope, deliverables, acceptance criteria |
| `docs/decisions.md`                       | Architecture decision records — every judgement call the spec left open     |
| `docs/deployment-target.md`               | The box this runs on, and what its constraints mean for the numbers         |

Two decisions depart from the written specification on purpose, and both say so in their ADR:
**ADR-15** (the app is the sole author of attempt rows; OCR endpoints are stateless) and **ADR-17**
(nginx + certbot instead of Caddy, because nginx already owns :443 on the box).

## How work is organised

Work proceeds **one phase at a time, and stops after each one for review**. That is a requirement of
the specification, not a suggestion. Do not start phase N+1 because phase N happened to go quickly.

For a phase:

1. Read `docs/phases/NN-*.md` in full, plus the ADRs it links under _Key decisions_.
2. Work on a branch named `feat/phase-NN-<slug>`.
3. Implement the **Scope** list. Respect **Out of scope** — those items belong to a named later phase
   and doing them early makes the review checkpoint meaningless.
4. Verify every item under **Acceptance criteria** by running it. They are written as commands and
   observations for exactly that reason. Report the output, not a claim about it.
5. Stop at the **Review checkpoint** and show what it asks for.

If a phase document turns out to be wrong or incomplete, say so and propose the change to the
document. Do not silently build something different from what it says.

## Layout

```
app/                  # React Native (Expo dev build, Android only)   — from phase 03
server/               # Fastify + TypeScript: image store, OCR engines — from phase 02
packages/shared/      # Types, zod schemas, date parser, timing, prices — used by BOTH sides
docs/
```

`packages/shared` is load-bearing, not decorative. The `OcrResponse` shape, the zod schemas and the
date parser exist **once** and are imported by both app and server, so on-device and server results
are parsed by literally the same code. Any accuracy difference between methods is therefore
attributable to the OCR, not to parsing. **Never duplicate a schema or a parsing rule into `app/` or
`server/`.** If both sides need it, it belongs in `packages/shared`.

Zod schemas are the source of truth for shape. TypeScript types are **inferred** from them with
`z.infer`, never hand-written alongside — two definitions drift, one cannot.

## Commands

```bash
pnpm install            # Node 22 (see .nvmrc), pnpm pinned via packageManager
pnpm -r build           # builds packages/shared to ESM + CJS + .d.ts (tsup)
pnpm -r lint            # eslint, flat config at the repository root
pnpm -r typecheck       # tsc --noEmit per package
pnpm -r test            # vitest
pnpm format             # prettier --write .
pnpm scan:secrets       # gitleaks over the working tree
```

`pnpm -r build` must run before typechecking `app/` or `server/`, because both resolve the shared
package through its `dist` output — ADR-14. CI orders it that way.

## Conventions

- **Strict TypeScript is set once**, in `tsconfig.base.json`. No package may relax it; a `"strict"`
  key in a package tsconfig is a defect, and phase 01's acceptance criteria grep for exactly that.
- **Comments explain why, not what.** The repository is full of decisions that look arbitrary until
  you know the reason — a `null` that must not become `0`, a subtraction that must not happen. Those
  earn a comment naming the ADR. Restating what the line does does not.
- **Reference ADRs by number** in comments and commit messages when the code encodes one.
- Commit messages: imperative mood, English, one phase per branch.

## Secrets

The repository is public and API keys compiled into an APK are extractable with `strings`.

- A `gitleaks` pre-commit hook and a CI job both fail on a staged credential. The hook requires
  `gitleaks` >= 8.19 on `PATH` and **fails when it is missing** rather than passing quietly.
- `.env` files are gitignored. `.env.example` files list every variable with a comment and **no
  values** — when a new variable is introduced, add it there in the same commit.
- Never commit a service-account JSON, an API key, or a token. If one is needed to test, put it in
  `.env` and reference it by variable name.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `yordanalexandrov/scanner-demo`, driven through the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root, ADRs in `docs/decisions.md`. See
`docs/agents/domain.md`.
