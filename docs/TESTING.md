# Testing

How CLICS is tested, how to run it, and the roadmap for closing the remaining gaps. Every unit/route
suite is **hermetic** — Supabase and the Anthropic SDK are mocked at the module level — so CI runs the
whole set with no real secrets and no live infrastructure: backend (jest), audit-dashboard (jest +
React Testing Library), license-verifier (node --test), and all 8 rimpl suites (including the PII
boundary + adversarial-leak suites). The only tests that touch a live stack are the **live gates**
(smoke/e2e scripts) below.

## Run it

```bash
# from the repo root — every hermetic suite at once:
npm run test:all                          # backend + rimpl + license-verifier + audit-dashboard

# …or per layer:
cd backend          && npm test           # jest --runInBand (hermetic)
cd rimpl            && npm test           # all 8 suites, hermetic (test:ci is identical)
cd license-verifier && npm test           # node --test (hermetic)
cd audit-dashboard  && npm test           # jest + React Testing Library (jsdom)
cd audit-dashboard  && npx tsc --noEmit   # typecheck (blocking gate)
cd audit-dashboard  && npm run lint       # ESLint (blocking gate)
cd physician-ui     && for f in public/js/*.js; do node --check "$f"; done   # syntax
```

> One-command local stack: `npm run dev` at the repo root boots all four layers together (backend 3001,
> rimpl 3003, physician-ui 3000, dashboard 3002) via `concurrently` — see [CONTRIBUTING.md](../CONTRIBUTING.md).

CI (`.github/workflows/ci.yml`) runs the hermetic set on every push to `master` and every PR, on Node 22:
backend + license-verifier (`npm test`), rimpl (`npm run test:ci`, no env needed), audit-dashboard
(typecheck + jest + lint — **all three blocking**), and physician-ui JS syntax.

## Seamless cooperation between roles — the seam → test matrix

Each role-to-role handoff is proven by a hermetic, route-level suite (supertest on the real router with
the persistence layer mocked). The guard logic verified here is also enforced by DB backstops
(`audit_scores_guard` trigger, RLS) that only the live smoke exercises — see *Live gates*.

| Handoff / seam | Endpoint(s) | Test |
|---|---|---|
| Physician PLE lifecycle (create · rename/move · delete) | `POST/PATCH/DELETE /ples` | `backend/tests/ples-lifecycle.test.js` |
| `/end` CLE-gate transitions (T1/T2 → fail/flag/pass) | `POST /ples/:id/end` | `backend/tests/ple-end.test.js` |
| Folder CRUD + ownership | `/ples/folders` | `backend/tests/folders.test.js` |
| Admin → Auditor assignment (council, active, not-own, evaluated) | `POST /admin/ples/:id/assign` | `backend/tests/admin-assign.test.js` |
| Auditor blind-score · double-submit 409 · self/cross-council guards · ICC | `/auditor/*` | `backend/tests/auditor-scoring.test.js` |
| Role-access matrix · `can_audit` dual role · council scoping · deactivation | `requireRole`, `scopeToCouncil` | `backend/tests/council-isolation.test.js` |
| **End-to-end chain:** admin assign → auditor blind → score → AI reveal → ICC | admin + auditor routers | `backend/tests/role-chain.integration.test.js` |

The **blind-scoring invariant** (the auditor cannot see the AI score until they submit) is asserted
server-side in `auditor-scoring.test.js` and `role-chain.integration.test.js`.

## Front-end component tests (audit-dashboard)

`audit-dashboard/__tests__/` runs under jest + React Testing Library (jsdom), wired via `next/jest`
(SWC transform, CSS/font mocks, `@/` alias — see `jest.config.js`). Current coverage:

| Suite | Covers |
|---|---|
| `__tests__/lib-labels.test.ts` | the status/role label maps, the `can_audit` virtual-role encoding, PIS-7 weights (sum = 1.0), composite math, budget-meter thresholds, status-card reconciliation, the case categoriser — the single source of truth behind every status badge |
| `__tests__/DomainScorer.test.tsx` | the rubric-anchored PIS-7 scorer: 7 domains × 6 levels, the weight badges, **no silent 0** for unset domains, the exact (domain, level) reported on tap, the ≥4 evidence-note gate, and the disabled state |
| `__tests__/TranscriptView.test.tsx` | physician-vs-assistant rendering, Socratic-line stripping, the separate question line, the refs join (Markdown is mocked — react-markdown is ESM-only and a thin wrapper) |

## Writing a new cross-role test

Reuse the shared helpers (additive — the older suites still carry their own inline mocks):

- `backend/tests/helpers/supabase-mock.js` — `makeSupabaseMock()`: a table-aware recording builder.
  Set `m.state.caller` (the row `verifyJwt` sees) and `m.state.resolve(table, kind, ctx)` to return rows.
  `m.find(table, op)` / `m.all(table, op)` inspect the recorded queries (assert `.eq()` targeting + payloads).
- `backend/tests/helpers/roles.js` — `PHYSICIAN / SPECIAL / AUDITOR / ADMIN / SUPERADMIN` (+ `_B` council-B
  variants). Note: request bodies validated as UUIDs (e.g. `auditor_id`) need a real UUID, not a fixture id.

```js
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const { __mock: m } = require('../src/lib/supabase');
beforeEach(() => { m.reset(); m.state.caller = ADMIN; m.state.resolve = (t, k, ctx) => ...; });
```

## Live gates (against a running stack — they mutate the shared Supabase)

There is **no separate test database** — these scripts read/write the real Supabase project regardless of
which backend they target. Run them against demo accounts, ideally right after `db/reset-demo.js`.

- `scripts/smoke/role-chain-smoke.js` — superadmin → admin assign → auditor blind-score → ICC →
  de-identified export. The live counterpart of `role-chain.integration.test.js`. Env: `SMOKE_BASE`,
  `SMOKE_SUPER_PW`, `SMOKE_ADMIN_PW`, `SMOKE_AUD_EMAIL`, `SMOKE_AUD_PW`.
- `scripts/smoke/go-live-smoke.js` — consent gate → chat turn → CLE eval → de-identified export.
- `scripts/e2e/new-auth-e2e.js` — auth/invite lifecycle (dry-run unless `--confirm`).

## Roadmap

**Phase 1 — done (2026-06-15):** CI pipeline; shared test helpers; the six cross-role suites above
(+49 tests); fixed the license-verifier test runner (`node --test`).

**Phase 2 — done (2026-06-15):**
- **audit-dashboard component tests** — `jest + @testing-library/react` (jsdom, via `next/jest`):
  `DomainScorer`, `TranscriptView`, and the labels/badge single-source-of-truth (see the section above).
- **All 8 rimpl suites made hermetic** — `chat`/`rag-pii`/`evaluate-validation` now mock Supabase, so
  the `test:ci` carve-out is gone (`test:ci` == `test`) and they run in CI with no env.
- **One-command local stack** — `npm run dev` at the repo root boots all four layers via `concurrently`.
- **ESLint promoted to a blocking CI gate** — the 65 findings fixed: `no-explicit-any` properly typed,
  and the `set-state-in-effect` effects migrated to `useSyncExternalStore` (`lib/client-store.ts`).

**Phase 2 — remaining:**
- **Wire `role-chain-smoke.js` into a staging CI job** (needs a non-prod Supabase + secrets).
- **DRY the older backend suites** onto `tests/helpers/` (the 30 pre-helper suites still carry inline mocks).

**Phase 3 — later:** multi-IP load test (single-IP bottoms out on per-IP limiters — see
[PERFORMANCE-BENCHMARK.md](PERFORMANCE-BENCHMARK.md)); jest coverage thresholds; Playwright browser E2E.

## Known limitations
- Hermetic suites cover **route-level** guard logic; the **DB triggers** (`audit_scores_guard`) and **RLS**
  are only exercised by the live smoke — don't read green CI as proof those backstops fire.
- Evaluated PLEs need a **manual admin assignment** to reach an auditor (no auto-assign); `db/reset-demo.js`
  should seed one assigned PLE so the auditor queue is always demoable.
