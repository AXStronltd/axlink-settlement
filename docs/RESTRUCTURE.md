# Restructure plan — `backend/` and `common/`

**Status: not started. Do not begin until PR #1 is merged.**

Moving `src/` rewrites the path of nearly every file in a 90-file pull request.
Done before the merge it turns a reviewable diff into an unreviewable one and
guarantees conflicts with anything still in flight. Nothing here is urgent.

---

## What this does, and what it deliberately does not

The target is the conventional `backend/ · frontend/ · common/` layout. Two
parts of it earn their keep; the rest would be directories invented to match a
template, which makes a codebase harder to read rather than easier.

**Worth doing**

| Change | Why |
|---|---|
| `src/` → `backend/src/` | Makes room for `common/` as a peer. On its own it is cosmetic. |
| Add `common/types/` | Fixes a real defect — see below. |

**Deliberately not doing**

| Proposed | Why not |
|---|---|
| `backend/config/` | Configuration is `.env` and `prisma.config.ts`. An empty directory. |
| `backend/src/models/` | `prisma/schema.prisma` is the model definition. A second location would compete with it. |
| `backend/tests/` | Tests live in `src/__tests__/`, beside the code. Moving them away from it is a downgrade. |
| `frontend/src/pages/` | Seven components and no router. Premature. |
| `frontend/src/store/` | No state library. `useState` is sufficient at this size. |
| `frontend/src/assets/` | No assets. |

### The defect `common/` fixes

`frontend/src/api.ts` declares **14 types by hand** — `Account`, `User`,
`Corridor`, the quote shape — that mirror backend types. Nothing checks they
still match. Rename a field in `src/core/` and the UI keeps compiling and
breaks at runtime, in the browser, on whatever screen happens to read it.

That is the only structural problem in the current layout. Everything else is
naming.

---

## Preconditions

- [ ] PR #1 merged to `main`
- [ ] No other branch open against `src/`
- [ ] `npm run test`, `npx tsc --noEmit` and the harness green on `main`

---

## Step 1 — move the backend

`git mv` the whole directory. Because everything inside moves together, **every
relative import between backend files stays correct**. Only references from
*outside* `src/` break, and there are exactly five.

```bash
mkdir -p backend
git mv src backend/src
git mv tsconfig.json backend/tsconfig.json
git mv vitest.config.ts backend/vitest.config.ts
```

Then update, in this order:

**1. `package.json`** — two scripts name the path:

```json
"dev":      "ts-node backend/src/index.ts",
"simulate": "ts-node backend/src/simulator/cli.ts",
```

**2. `tsconfig.json`** — `rootDir` and `include`:

```json
"rootDir": "./backend/src",
"include": ["backend/src/**/*", "common/**/*"],
```

**3. `vitest.config.ts`** — test discovery and coverage:

```ts
include: ['backend/src/__tests__/**/*.test.ts'],
coverage: {
  include: ['backend/src/core/**/*.ts', 'backend/src/providers/**/*.ts', 'backend/src/routes/**/*.ts'],
}
```

**4. `Dockerfile`** — line 26:

```dockerfile
COPY backend/src ./backend/src
COPY common ./common
```

**5. `.github/workflows/ci.yml`** — currently has no `src/` paths, so it should
need no change. Confirm rather than assume; a path filter added later would
silently stop running the backend job.

`prisma.config.ts`, `.dockerignore`, `docker-compose.yml` and `.do/app.yaml`
contain no `src/` references and need nothing.

### Verify

```bash
npx tsc --noEmit                    # 0 errors
npm run test                        # all tests pass
npm run dev                         # service boots
DATABASE_URL=…/axlink_harness SIMULATOR_ENABLED=true npm run simulate
docker build -t axlink-check .      # the image still builds
```

The harness matters most here: it is the only check that exercises the engine
end to end, so a broken import that typechecks but fails at runtime shows up
there and nowhere else.

---

## Step 2 — extract shared types

Separate commit. Reviewable on its own, and revertible without undoing step 1.

```
common/
└── types/
    ├── money.ts       Currency codes, Account, balances
    ├── user.ts        User, KYC status
    ├── quote.ts       Quote request/response, RFQ result, revenue model
    └── corridor.ts    Corridor, provider capability as the UI sees it
```

Take the definitions from `frontend/src/api.ts` — it already has them written
out — but make the **backend** the source of truth for each field, since that is
where they are produced. Then:

- `frontend/src/api.ts` imports from `common/types` instead of declaring
- backend routes import the same types for their response shapes
- both tsconfigs include `common/**/*`

Do not move business logic into `common/`. Types and pure helpers only:
anything importing Prisma or Express drags the backend into the frontend build.

### Verify

Rename a field in a backend type and confirm the **frontend** build fails. If it
still compiles, the types are not actually shared and the exercise achieved
nothing.

---

## Order and size

| Commit | Touches | Risk |
|---|---|---|
| 1. Move backend | ~90 files, 5 config edits | Low — mechanical, caught by tsc |
| 2. Extract types | ~10 files | Low — caught by tsc |

Two commits, both mechanical, neither changing behaviour. Keep them separate:
a move commit that also changes types is a commit nobody can review.

---

## Notes

**Coverage paths were stale and are now fixed.** `vitest.config.ts` pointed
coverage at `src/services/**`, a directory removed when the code moved to
`core/` and `providers/` three months ago — so `test:coverage` measured nothing
and reported nothing. It now covers `core/`, `providers/` and `routes/`, which
put the real figure at about 18% of statements. Worth knowing before anyone
quotes a coverage number.

**The database and Kafka topics were renamed separately.** They previously
carried the previous brand's naming; that was retired in its own commit. This
restructure does not touch either, and neither should be renamed as part of it.
