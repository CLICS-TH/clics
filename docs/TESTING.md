# Testing

How CLICS is tested, how to run it, and the roadmap for closing the remaining gaps. The backend and
license-verifier suites — and rimpl's **logic** suites — are **hermetic** (Supabase + the Anthropic SDK
mocked at the module level), so CI runs them with no real secrets. rimpl's three **integration** suites
(`chat`, `rag-pii`, `evaluate-validation`) make a real Supabase round-trip and are NOT hermetic — they run
locally with creds, or via the live gate, not in unit CI.

## Run it

```bash
cd backend          && npm test       # jest --runInBand  (36 suites / 222 tests, hermetic)
cd rimpl            && npm run test:ci # the 5 hermetic logic suites (170 tests, no creds)
cd rimpl            && npm test        # ALL 8 suites — the 3 integration ones need a live Supabase in env
cd license-verifier && npm test       # node --test       (8 tests, hermetic)
cd audit-dashboard  && npx tsc --noEmit   # typecheck (blocking gate)
cd audit-dashboard  && npm run lint       # ESLint (informational — see Phase 2)
cd physician-ui     && for f in public/js/*.js; do node --check "$f"; done   # syntax
```

CI (`.github/workflows/ci.yml`) runs the hermetic set on every push to `master` and every PR, on Node 22:
backend + license-verifier (`npm test`), rimpl (`npm run test:ci`, with dummy placeholder env so the
Supabase client constructs at import), dashboard typecheck (blocking) + lint (`continue-on-error` —
pre-existing findings, Phase 2), and physician-ui JS syntax.

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

**Phase 2 — next:**
- **audit-dashboard component tests** — add `jest + @testing-library/react` (jsdom); first targets:
  `DomainScorer` (chips, no-silent-0, submit-gated), `TranscriptView` (markdown + memo), admin status badges.
- **One-command local stack** — a `concurrently` script (or compose) to boot backend+rimpl+dashboard+
  physician-ui together for live E2E (today it's 4 manual terminals).
- **Wire `role-chain-smoke.js` into a staging CI job** (needs a non-prod Supabase + secrets).
- **Fix the 65 dashboard ESLint findings**, then make `npm run lint` blocking in CI.
- **DRY the older backend suites** onto `tests/helpers/`.
- **Make rimpl's integration suites hermetic** — mock Supabase in `chat`/`rag-pii`/`evaluate-validation`
  (they currently need a live DB), then fold them into CI and drop the `test:ci` carve-out.

**Phase 3 — later:** multi-IP load test (single-IP bottoms out on per-IP limiters — see
[PERFORMANCE-BENCHMARK.md](PERFORMANCE-BENCHMARK.md)); jest coverage thresholds; Playwright browser E2E.

## Known limitations
- Hermetic suites cover **route-level** guard logic; the **DB triggers** (`audit_scores_guard`) and **RLS**
  are only exercised by the live smoke — don't read green CI as proof those backstops fire.
- Evaluated PLEs need a **manual admin assignment** to reach an auditor (no auto-assign); `db/reset-demo.js`
  should seed one assigned PLE so the auditor queue is always demoable.
