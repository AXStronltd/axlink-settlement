# How AxLink is built — working rules

*Owner instruction, 2026-11-06. **Codex was stopped after Step 1; from Step 2 Claude works alone.** The per-slice flow below still applies, with the review step done by a separate, fresh Claude reviewer that has not seen the slice being written (so the work is not grading itself). The protocol is kept so a second agent can be re-added without changing the flow.*

## Roles

| | Claude | Codex | Owner (Ahmed) |
|---|---|---|---|
| Builds | each slice of the approved milestone, on its own branch | fixes for its own findings (commits on the slice branch, or a PR targeting it) | — |
| Reviews | Codex's fix commits before they merge | every slice PR, independently, against the code (not the description) — **while Codex is stopped, a fresh Claude reviewer does this** | milestone reports |
| Merges to `main` | yes — only after CI is green, Codex has no open critical/high finding, and the owner has approved the milestone | never | — |
| Decides | technical approach within scope | severity of findings | scope, milestones, deployment |

## One slice, start to finish

1. **Branch** `step-<n>/<slice>` from `main`. Claude opens a PR early (draft) using the template; the description names the scope item it implements and the exact commands run.
2. **CI green** (`.github/workflows/ci.yml`: typecheck, vitest on PostgreSQL, harness, builds, site guard) before any review is requested.
3. **Review request**: Claude writes on the PR *"Codex: review requested at `<commit>`"*. Codex reviews **that commit**, and posts findings as PR review comments, each with a severity: `critical` (money can be lost or moved wrongly), `high` (security or isolation), `medium`, `low`, `info`. A finding names the file, the line and a reproduction or test.
4. **Fixes**: Claude fixes `critical`/`high` on the slice branch (failing test first, then the fix), replies on each finding with the commit that resolves it. Codex may instead push the fix itself; then Claude reviews that commit. Disagreements are settled by a test that demonstrates the behaviour, not by argument.
5. **Confirmation**: Codex writes *"No open critical/high at `<commit>`"*. Until that line exists, the PR does not merge.
6. **Owner approval**: the owner says go (on the PR or in chat). Claude fast-forwards or squash-merges to `main` and posts the resulting `main` hash on the PR, then closes it.
7. **Report**: milestone evidence goes to `docs/` (one file per milestone), and the owner's status doc is updated.

## Rules both agents keep

- Scope is `docs/SCOPE.md`. A slice outside it is refused, not negotiated on the PR.
- Layout is `docs/STRUCTURE.md`: `apps/` + `packages/`; reserved folders stay README-only until their milestone.
- Every message on a PR states the commit hash it refers to. "Tests pass" without a hash is not evidence.
- Tests run against an isolated, migrated PostgreSQL; stubbed providers prove logic, never live settlement. Say which is which.
- No deployment, no production data, no live financial transaction, by either agent, ever, without the owner's explicit instruction naming the action.
- No duplicate work: before starting a fix, check the PR for a commit or finding that already covers it. If both agents touched the same defect, the version with the test that fails before and passes after wins; the other is dropped.
- Small, reviewable commits with the standard trailer; one concern per commit.
- A reserved or frozen area (Leg B rails, cross-chain, Ethereum/Polygon) is not touched by either agent, even to "tidy".

## Ready-made lines

- Claude → Codex: `Codex: review requested at <hash>. Scope: <item>. Commands: <list>.`
- Codex → Claude: `Finding [<severity>] <file>:<line> — <what, with reproduction>.`
- Codex → all: `No open critical/high at <hash>.`
- Claude → all: `Merged to main at <hash>. PR closed.`
