# CLICS — Handoff Snapshot

*State of the app as of **2026-09-03**, for the developer continuing this project. Pairs with
[../README.md](../README.md) (orientation), [../CONTRIBUTING.md](../CONTRIBUTING.md) (how to work in it),
and [ROADMAP.md](ROADMAP.md) (what to build next).*

> **Four days behind, as of 2026-09-07.** Not rewritten wholesale — the newer work is written up where
> it happened, and duplicating it here is how this file went stale in the first place. What landed
> after 2026-09-03:
>
> | where | what |
> |---|---|
> | [GATE0-DGX-RESULTS.md](GATE0-DGX-RESULTS.md) §8.9–8.11, §5.2 | the nine-port sweep (the block is **source-scoped**, `:3003` refuses rather than drops), rimpl's first real run against the box, and `cme-dev` identified as a **gateway** whose inference hosts are LAN-only |
> | [METHODOLOGY-local-vs-sonnet.{en,th}.md](METHODOLOGY-local-vs-sonnet.en.md) | the whole local-evaluator screening programme, including the held-out gate spent 2026-09-04: **ICC 0.436 (0.000–0.873), n=8, `insufficient`** |
> | [ONPREM-INSTALL.th.md](ONPREM-INSTALL.th.md) | the Thai install spec handed to the box owner |
> | [RAG-ROLLOUT-CHECKLIST.md](RAG-ROLLOUT-CHECKLIST.md) | `rag_enabled` migration applied and verified in production 2026-09-06 (`fa3fa89`) |
> | [G0.5-HUMAN-RATER-PREP.th.md](G0.5-HUMAN-RATER-PREP.th.md) §0 | the production rater-spread measurement — `gate.meets: false` |
> | [pilot-timeline.md](pilot-timeline.md) | the published schedule marked superseded |
>
> PRs #84–#89 and #91–#92. The "Open threads" list below has been re-checked against production; two
> of its figures were wrong and are corrected in place.

## Read this first — the 2026-08/09 outage

**Production was broken from 2026-08-31 to 2026-09-03 and nothing said so.** The database was
renamed forward (every CLE-named object became PLE-named, then the `ples.status` values followed on
2026-09-02) while the deployed backend still queried `cles`. Every session query returned PGRST205.
No participant is enrolled and nothing had been written since 2026-08-16, so no data was lost — but
it went unnoticed for three days because the two screens an operator would check both reported
success: `/admin/stats` answered `200 {total: 0}` and `/health/deep` answered `200 "ok"`.

Fixed by merging PR #83 (branch `feat/local-ai-capacity`, 31 commits) to master and deploying all
four layers on 2026-09-03. Both screens now report failure, and `/health/deep`'s verdict can be
failed by the evaluation queue — so a green deep check finally means the drain is claiming work.

Two lessons worth keeping:
- **A fallback that drops its error is worse than no fallback.** Zero looked like an answer.
- **Never rename the database ahead of the code.** If a rename must land first, deploy the code in
  the same window; the gap is an outage, not a migration step.

Verified restored on 2026-09-03: role-chain smoke 20/20, go-live smoke 15/15 (a full physician
session with live AI, screening, de-identified export and reconcile), all portal and dashboard
redirects answering, zero `cle`-named objects left in the database.

## What's live in production

The prototype is feature-complete and deployed (both front-ends on Vercel, backend + RIMPL on Railway,
Supabase Postgres). Working end-to-end today:

- **Auth & roles** — one login portal (physician-ui); Google OAuth (flag-gated by `OAUTH_ENABLED`) +
  email/password + invites. Four roles (Physician / Auditor / Admin / Superadmin) across **multiple
  councils** with council isolation. The CLICS token is the Supabase session token (see the never-`signOut`
  rule). License-No./TMC verification was retired. See [roles.md](roles.md), [AUTH-SETUP.md](AUTH-SETUP.md).
- **Physician flow** — create a PLE (with chief complaint), chat with the AI (citations every turn;
  the Socratic follow-up is a **protocol rescue**, not an experimental arm — it opens only after 4
  exchanges that are off-topic or not yet qualifying, asks 1–2 non-leading questions, and gives no
  diagnosis), pause/resume, end → **reflection** → qualifying gate → PIS-7 evaluation → result + LPDP
  trend. A session qualifies on CREC082 §1's four elements (c4/c5/c7/c6); **c1–c3 are recorded
  metadata and no longer terminal**. Guest mode (anonymous, 2 prompts, no persistence). Per-user
  **$0.50 AI cap** with an allowance meter.
- **Auditor flow** — blind PIS-7 scoring of *evaluated* sessions that have **passed human privacy
  review** (see the gate below), assigned via `ples.auditor_id` or `audit_assignments`; the
  rubric-anchored **DomainScorer** (tappable 0–5 chips, no silent-0 default, submit blocked until all 7
  domains are set); AI score revealed only after submit; ICC(A,1) *and* ICC(A,3) average-measures plus
  quadratic-weighted kappa of AI-vs-auditor.
- **Admin/Superadmin** — PLE list + assignment, flagged-QA queue, invites, users + usage management,
  executive overview, ICC dashboard, **`/admin/privacy`** (human privacy review), **`/admin/identity`**
  (identity verification decisions), **`/admin/governance`** (retention + monthly security review,
  superadmin only). De-identified `/admin/export`.
- **Integrity** — consent gate, PII stripping in RIMPL before any cloud call, **100% human privacy
  review before any transcript reaches a rater**, layered identity verification (national ID + licence,
  stored encrypted + blind-indexed, separate from the research dataset), per-score Model Lock
  provenance, pseudonyms (`P-NNN`), Helmet + rate limits. Concurrency benchmarked: 200+ concurrent reads / 110 distinct simultaneous users,
  0 errors (the AI path's ceiling is Anthropic **OTPM** — see [PERFORMANCE-BENCHMARK.md](PERFORMANCE-BENCHMARK.md)).

## Built 2026-09-02 — local-AI capacity layer (merged as PR #83 and DEPLOYED to prod 2026-09-03; migrations were applied 2026-09-02)

Context: the on-prem model became reachable 2026-08-31 and passed Gate 0; measured head-to-head it agrees
with Sonnet at ICC 0.594 (on the unweighted d1–d7 sum — note, 2026-10-02: GATE0 §7.2) and **neither
model's PIS-7 output is reproducible** (same fixture, Σ|Δ| 0–8 across sessions).
Decisions and measurements: [LOCAL-MODEL-ROADMAP → The capacity layer](LOCAL-MODEL-ROADMAP.md),
[LOCAL-MODEL-CUTOVER → Measured position 2026-09-02](LOCAL-MODEL-CUTOVER.md), [GATE0-DGX-RESULTS §7](GATE0-DGX-RESULTS.md).

- **`ddbba2a` backend + db + portal:** the `ple_pass` row is the evaluation queue (`claim_ple_evaluations` RPC,
  lease, `services/eval-drain.js` as the single writer); finalize / approve / re-evaluate / reconcile only
  enqueue + kick; token budgets beside the $ cap (org ceilings seed 0 = off); transcript cap on
  `ples.context_tokens`; council partition (`eval_drain_exclude_councils` prod setting, `EVAL_DRAIN_ONLY_COUNCILS`
  dev-only, both fail closed); `GET /ples/:id/evaluation` reports queued/scoring + position/eta; portal shows
  the states, the warn band, the limit bubble and `ai_busy`. Reviewed by `clics-reviewer` (6 findings, all
  fixed before commit — the worst was the sweep re-enqueueing live rows). Backend 757/757, responsive
  44/44, readability 112 renders clean.
- **`c4bd08d` + `551df47` probe tooling:** held-out split reserved (D13), `context-limit.mjs --synthetic`
  capacity ramp, `screening-verdict.mjs` (D18 through the production `icc.js`), model-axis table in
  `scripts/calibration/prompt-versions.md`.
- **`afb83d5` rimpl:** two-lane bounded runner with cancellation and a self-calibrating 413 backstop (WP-A),
  `PROVIDER_SETTINGS_SOURCE=env` dev override + dormant `CHAT_FAILOVER_PROVIDER` hook (WP-G), per-call
  `context_tokens` on `/chat`. Reviewed; rimpl 579/579 incl. two new adversarial PII suites.
- **`1fe625c` dashboard:** capacity card, per-user token override + token meter, consistency chip (+ the settings
  PATCH now echoes every key). **`6050e53`** the sandbox smoke. **`aecb861`** four guard mutations (all KILLED).
- **`npm run smoke:local-ai`** (Codex): five scenarios against a laptop stack + prod SANDBOX council; hard
  preconditions, never a prod host, never flips `pilot_test_mode`.

**Live on 2026-09-02 afternoon.** Migrations applied to prod (`ple_status_values`, both halves of
`local_ai_capacity`); `eval_drain_exclude_councils=SANDBOX` set. The laptop stack (`PROVIDER_SETTINGS_SOURCE=env`,
`EVAL_DRAIN_ONLY_COUNCILS=SANDBOX`, chat timeout 150 s, concurrency 3 / reserve 1, `EVAL_CONSISTENCY=adaptive`)
ran the sandbox smoke against prod Supabase: **single PASS** — 4 local chat turns, screening, drain claim, adaptive
PIS-7 (2 calls agreeing within 1), provider `local`, physician billed call 1 at $0, `/end` → verdict in 131–163 s;
**burst n=5** — screening 15–29 s, evaluations strictly FIFO by enqueue time, exactly one per PLE, serial waits
143 → 673 s at drain width 1, an extra physician's chat turn during the burst answered in 95 s. Live runs forced
seven smoke/scope fixes, one of them a real bug (a laptop include scope was cancelled by the shared exclude
setting → empty scope). Prompt calibration on the box read ratio ≈1.9; a 4-turn PLE costs ≈13.4k tokens.

**Prod is inconsistent and needs a decision:** the deployed master backend queries `cles`, which the 2026-08-31
rename removed — every PLE route has failed since, unnoticed. Deploying this branch (backend + rimpl + both
front-ends, migration already applied) is the fix; rolling the two rename halves back is the alternative.

**Not done:** the capacity probe run on the box that sets the real cap
/ concurrency / token ceiling; the smoke itself; the held-out verdict run. **Deploy hazard:** apply
`db/migration-local-ai-capacity.sql` *before* any backend from `ddbba2a` — see [deployment.md](deployment.md).
Hygiene still open: regenerate the Open WebUI token in `~/.clics-dgx.env` (exposed in a screenshot 2026-08-31).

## What just shipped (2026-08-27) — CREC082 protocol conformance

**The governing document changed.** CLICS was built against the JMIR #99520 manuscript and internal
design decisions; as of the **CREC082 submission set (26 Aug 2026)** the **IRB protocol is what the
system must match**, and it differed in specific, checkable ways. PR **#68** (`4db4057`, 74 files,
+5284/−243) closes that gap. Six migrations applied to prod, all four services deployed and verified.

*Also on `master` since the 2026-08-22 snapshot, not detailed below:* **#64** evaluator headroom for
large transcripts, **#61** provider adapter (on-prem DGX, ships dark), **#65** shadow evaluator,
**#66** three-way ICC, **#67** manuscript↔platform gap (sampling, ICC(k), credit, integrity).

### Three live defects found while mapping (not CREC items)

- **`ple_pass` was transient and five counters treated it as terminal.** `ple-finalize.js` sets
  `ple_pass`; `ple-evaluation.js` immediately flips it to `evaluated`. Prod had **`ple_pass=0`**, so
  every "completed PLE" count returned zero — the ≤3 PLE cap never fired and **฿3,000 in owed
  compensation displayed as ฿0** across 5 physicians. Fixed with one shared predicate,
  `backend/src/lib/ple-status.js` (`COMPLETED_STATUSES = ['ple_pass','evaluated']`), applied at all
  five sites. **Deliberately not** applied to `admin.js` `STATUS_BUCKETS` — treating `ple_pass` as
  in-progress in the queue view is correct there ("score pending").
- **`randomised_examiner` violated `ples_socratic_reason_chk`.** Every randomised insert would have
  failed 23514; masked in prod only because `pilot_test_mode=1` overwrote the reason first — proof the
  deployed path was never exercised. A1 removed randomisation; the constraint was rewritten, not left.
- **Pre-approval data is not labelled as development data.** 6 evaluated PLEs in the real TMC council
  carry `is_test=false`, contradicting the submission's *"ไม่มี participant data … ก่อน CREC approval"*.
  Almost certainly the team's own E2E runs (the n=6 ICC from the June audit matches exactly), but
  nothing in the system of record says so. **Untouched — this is evidentiary data and the research
  team's call.**

### A — direct contradictions with the protocol

- **Socratic randomisation → protocol rescue.** The randomisation that shipped the day before was a
  full experimental arm; *PLE Instruction Sheet §4* and *ICF §3* call Socratic **"a standardized
  rescue … not an experimental arm."** Removed `drawSocraticEpisode`, the `socratic_episode`
  allocation + write-back, the `randomised_examiner` reason, and the 6 tests asserting the allocation.
  Built `rimpl/src/services/rescue.js` to §4 semantics: after **4 physician turns**, if off-topic or
  not yet qualifying → 1–2 **non-leading** questions, **no diagnosis**, then back to normal. A
  deterministic pre-filter runs first so the model call is skipped in the common case. `off_topic`
  outranks `not_qualifying`. Persists four columns, not a boolean — `rescue_activated_at`,
  `rescue_reason`, `rescue_exchanges_before`, `qualified_at` — because the SAP reports trigger rate,
  activation point, and exchanges **before and after**.
  `consecutive_t1_fails >= 3` → Socratic is a cross-session rule the protocol does not have; it is
  kept behind `t1_remediation_enabled` (**default 0**) as a documented deviation rather than deleted.
- **PLE gate: c1–c3 demoted to metadata.** `ple-gate.js` hard-failed on duration ≥600s, turns ≥4,
  tokens ≥10000 — effort proxies the protocol never names. They terminated sessions at `ple_fail_t1`
  (6 rows in prod), rejecting a concise but genuinely reflective episode while passing a rambling
  lookup. CREC082 §1 defines a PLE by four qualities; three already mapped (c4 meaningful problem,
  c5 developing reasoning, c6 reflective synthesis) and **the third element — context/evidence
  integration — had no check at all**. Added as **c7**. c2's `turns ≥ 4` kept its correct protocol job
  as the rescue trigger. The only remaining hard stop is a session with **zero physician turns**
  (nothing to classify, so a paid classifier call would buy nothing).
- **Layered identity.** ICF §4 requires ThaID *or* national ID + licence, with the identity layer
  **separate from the research dataset**; the system knew only an email. New `identity_verifications`
  table (deny-all RLS, service-role only, deliberately not in `professionals`). The national ID is
  stored three ways: AES-256-GCM encrypted (reversible — the team may have to re-check a number
  against a register), a **keyed HMAC blind index** (deterministic so uniqueness is enforceable; a
  plain SHA-256 would be useless, the whole space is ~10¹² and a leaked column falls to exhaustive
  search on a laptop), and last-4 for confirming the right record on screen. Checksum validated
  (mod-11, weights 13..2) before any write; fuzz-verified client vs server over 4005 cases, 0
  disagreements. The licence lookup is **evidence, not a verdict** — it can confirm a licence exists,
  never that the person typing it is that person; an administrator decides.
- **Local AI (A2)** — no new code; closes when the DGX unblocks. All five purposes still read
  `anthropic`/`openai`. **GDCC hosting (A3)** — out of scope, named so it is not lost.

### C — committed to CREC, never built

- **100% human privacy review.** The protocol promises automated PII/PHI screening **plus** a human
  reading every transcript before it reaches a rater. Only the automated half existed — RIMPL scrubs
  the *outbound* cloud call, but the stored transcript is deliberately kept **raw** as the evidentiary
  record, and it reached a third party with nobody having looked. Modelled as a **clearance, not a
  lifecycle status** — scored-or-not and cleared-or-not are different axes, and one column would have
  meant rewriting a dozen status filters. `backend/src/lib/privacy-review.js` gates four exposure
  points (manual-assign guard, assign write filter, sampler pool, auditor queue) and `isCleared()`
  **fails closed**. New `/admin/privacy` screen: pass / redact / quarantine / exclude, note required
  for anything but a clean pass.
- **Reflection after every PLE.** The word `reflection` appeared nowhere in the backend or the portal.
  The subtle part: PIS-7 is assessed on *"transcript **และ** reflection"* and the D6 anchor starts at
  *"0: ไม่มี reflection"* — so a reflection collected **after** scoring would leave D6, and c6 (one of
  the four qualifying elements), judged on evidence the protocol calls incomplete. It is captured
  **before** screening and fed into the transcript the evaluator sees, tagged `role: 'reflection'` so
  it reads as evidence rather than more chat. Three columns matching the protocol's three prompts. A
  skipped reflection returns `null`, not a note saying it was skipped — the D6 zero anchor is *no*
  reflection.
- **Acceptability questionnaire**, one per physician after their last PLE. Unique on `physician_id`,
  not `(physician_id, ple_id)` — the questionnaire is about the **system**, not a session.
- **Retention + monthly security review.** New `/admin/governance` (superadmin only) and a
  `security_reviews` table with three separate columns, because a reviewer who covered access but not
  incidents should produce a record that says so; `incidents_found` is explicit rather than inferred
  from empty text. **Deviation from plan: there is deliberately no scheduler.** The deadline is five
  years after a project that has not started (~2031); an unattended five-year cron running irreversible
  deletes against a schema that will have changed repeatedly is a larger risk than the one it manages.
  Execution is a guarded manual action (superadmin + deadline passed + a 31-character typed phrase),
  audit-logged. A test asserts `src/index.js` never reaches the retention service.

### B — measurement conformance

- **ICC(A,3)** average-measures absolute agreement added alongside the existing ICC(A,1); verified
  against an independently-written Python reference to 4dp, and the Spearman-Brown identity cancels
  exactly.
- **Quadratic-weighted kappa** (`backend/src/services/kappa.js`). Matrix sized by **scale**, not
  sample; out-of-range values dropped rather than clamped. Cross-checks against ICC(A,1) as theory
  predicts (converging 0.002 → 0.000 by n=800).
- **Model Lock provenance** — `ai_evaluations.provenance` jsonb + a `config_fingerprint` index. The
  weights checksum is not readable over an inference API, so it is **declared** once at lock time
  (`evaluator_weights_sha256`) and stamped on every score: a pre-lock score says "not locked" on its
  face, and a mid-pilot re-declaration shows up as two fingerprints either side of the change.
- **≥3 raters (B1)** and **≥150 evaluable PLEs (B6)** are recruitment gates, not code — the dial
  exists. **Model identity (B4)** needs Aj. Chanvit: the Model Lock Record names a DeepSeek-based
  model, `cme-dev` serves only Qwen builds. That is a document change, not a code change.

### Rubric, naming, and the settings gates

Rubric anchors replaced with the CREC-approved **behavioural 0–5 scale** plus per-domain 0→3→5
anchors, synced across both sources (`rimpl/src/lib/prompts.js` ↔ `audit-dashboard/lib/pis7-rubric.ts`)
with a drift test. **Weights (15/20/15/15/15/10/10), the 7 domain names, and the 0–5 scale are
untouched** — already verified identical. `PROMPT_VERSION` auto-bumps on rubric edits.

**PLE (protocol) ≡ PLE (code).** Do **not** re-rename the code — a past PLE→PLE rename already left FK
constraints named `ples_*`. Glossary added to [domain-concepts.md](domain-concepts.md); use PLE in
CREC-facing artefacts only.

Four gates are settings rather than hardcoded behaviour, and the defaults are deliberate:

| Setting | Default | Why that default |
|---|---|---|
| `privacy_review_required` | **1** | Fails closed by **withholding** data from third parties — the safe direction. The protocol's promise is 100% |
| `reflection_required` | **1** | Blocks nobody (a physician may always skip), and the reflection is scored evidence |
| `identity_verification_required` | **0** | Fails closed by **blocking every physician from working**, and guards nothing while there are no real participants. **Must be 1 before the first participant** — a release step, not a default |
| `t1_remediation_enabled` | **0** | Opens Socratic from turn 1, which §4 reserves for the rescue |

### Migrations (all applied to prod 2026-08-27)

`db/migration-crec-{phase0,rescue,privacy-gate,identity,reflection,retention-security}.sql`, recorded
as `crec_*` in `supabase_migrations.schema_migrations`. **phase0 must run before rescue** (it opens the
CHECK constraint the rescue writes to); the rest are independent. `migration-socratic-randomisation.sql`
is **superseded, not reverted** — the `socratic_episode` drop lives in phase0 so the history stays readable.

**Existing rows were not backfilled, on purpose.** All 34 PLEs default to
`privacy_review_status='pending'`, which drops the already-evaluated sessions out of the auditor queue
until a human reviews them. Backfilling to `passed` would assert a review that never happened — exactly
the claim this gate exists to make true. If a round must keep running, lower the **setting** (a
recorded, reversible decision); never mass-update the column.

### Gates green after this work

backend **593/593** · rimpl **379/379** (incl. the adversarial PII-leak suite) · audit-dashboard
`tsc` 0 / `lint` 0 / **48/48** · responsive smoke **40 checks across 10 pages**, 0 overflow.

## What just shipped (2026-06-28 → 2026-08-04) — Thai manuals · sandbox test round · landing/login redesign

Seven PRs merged since the 2026-06-25 snapshot below; `master` is current with all of them. Sections
further down are kept in reverse-chronological order as history — **read this one first.**

- **#51–#53 · Thai end-user manuals (PDF).** Two plain-Thai, step-by-step guides in `docs/manuals/`
  for non-technical physicians: `clics-user-guide-th.pdf` (Role C — the full physician journey) and
  `clics-user-auditor-guide-th.pdf` (Special — user + auditor). #52 audited every page boundary so no
  block or heading splits across a page break; #53 fixed §10, which had drawn the *auditor's*
  two-series "You vs AI" radar — a physician's result page is **single-series** (their own 7 domain
  scores) — the radar is inline in `physician-ui/public/ple-result.html:53`, a single
  `'PIS-7 Score'` dataset.
- **#54–#55 · Sandbox test round.** Superadmin **"hold result until audited"** toggle — physicians
  can't see their PIS-7 score until an auditor submits one. Mirrors `peer_calibration` end-to-end:
  `GET /ples/:id/evaluation` returns **`202 pending_review`** until an `audit_scores` row exists, and
  `/ples/lpdp/me` drops un-audited PLEs. Ships **default OFF**. Plus an isolated SANDBOX council +
  cohort and the D/C manuals. #55 renders the per-group login handout only when present and gitignores
  its source + PDF — **the sandbox credentials never enter git.**
- **#56 · Landing/login redesign + ECG logo.** Rebuilt the physician-portal landing (which *is* the
  login), added an animated ECG-pulse CLICS logo to both front-ends, and folded in the highest-value
  a11y findings from a full UX/UI audit. Note: this was deployed to prod on 2026-07-08 **from the
  local tree**, and the PR brought `master` back in sync afterwards.
- **#57 · Daily digest only on active days.** The daily-summary email sends only when ≥1 non-merge
  commit landed in the last 24h; a zero-commit day still goes green but sends nothing.

**Also now on `master` (not in the older sections):** the **mobile-audit harness**
(`scripts/responsive/mobile-audit.mjs`, `npm run test:mobile-audit`) is wired into the CI `responsive`
job — physician-ui runs hermetically on every push, and the audit-dashboard live-smoke activates only
when `DASH_URL` / `BACKEND_URL` / `AUDITOR_EMAIL` / `AUDITOR_PW` repo secrets are set (absent on fork
PRs → hermetic-only). `SUPER_*` is deliberately **not** wired, to keep real admin creds out of CI.

### In flight (open PRs, not merged)

| PR | What |
|----|------|
| **#58** | Sandbox test-cohort **group 4 (SBX-4)** roster. The accounts are *already provisioned in prod*; this only brings `test-cohort.json` in git into line with reality. |
| **#59** | PIS-7 evaluation report for two illustrative PLEs (`scripts/report/pis7-ple-eval.html` → `pis7-ple-evaluation.pdf`), plus `.gitignore` guards for coverage output and physician-identifiable report artifacts. |
| **`feat/council-billing-thai-caching`** | Pushed 2026-08-22, **no PR yet**. Deterministic Thai reply-language per turn, prompt caching (`RIMPL_PROMPT_CACHE`, ships OFF), and per-council usage attribution — the billing foundation. **Its migration has NOT been applied.** See the billing note under *Known gaps*. |

## What just shipped (2026-06-25) — reset-usage dual-pool · peer n=1 label · opt-in go-live CI

Two small follow-up PRs merged to `master` and live (audit-dashboard on Vercel; no migration, no backend change).

- **PR #48 — Reset-usage resets BOTH pools for a "Special" user.** The `/admin/users` Reset-usage action previously
  reset only the physician AI pool for a dual-role **Special** (physician + `can_audit`); it now also resets the
  **auditor** pool (physician-only and auditor-only rows unchanged). Frontend-only — both backend reset endpoints
  (`/reset-usage`, `/reset-auditor-usage`) already existed and fire in parallel.
- **PR #49 — pilot polish.** (a) The per-PLE **peer-calibration** card now reads *"เทียบกับผู้ประเมินอีกคน / vs the
  other auditor"* (legend *Other*, conclusion *"the other auditor"*) when exactly **one** other auditor scored
  (`peer_n === 1`) — "average" only shows at n≥2; the home aggregate (a true cross-PLE mean) is untouched. (b)
  **`go-live-smoke` wired into CI** as an **opt-in** second job in `staging-smoke.yml`, gated on a new
  `include_ai_smoke` dispatch input (**default OFF** → never auto-spends Anthropic budget; the free role-chain job
  is unchanged). **Pending human step:** a repo admin adds `SMOKE_PHYS_EMAIL` + `SMOKE_PHYS_PW` secrets for that
  path to run (see `docs/TESTING.md` → Live gates).

**Verification:** audit-dashboard `tsc`/`eslint`/`jest` (35) + `build`; workflow YAML validated; prod alias serves 200.
**Context:** P1-engineering + TODO/FIXME were both confirmed empty of code work this session (3-agent sweep) — P1-eng
done, remaining P1 is operational-only (rotate key / demo passwords / Resend domain), zero actionable TODO/FIXME.

## What just shipped (2026-06-24) — multi-auditor calibration, compensation payout, XLSX export, UX/Thai pass

Three PRs merged to `master` (`680dd3e` → `19de2f0`) and **live in prod** (2 migrations applied; backend on Railway, both front-ends on Vercel).

- **PR #44 — pilot round.**
  - **(a) Multi-auditor calibration** behind a superadmin **`peer_calibration`** toggle (**OFF by default**): `db/migration-audit-assignments.sql` (a `audit_assignments` join table + backfill from `ples.auditor_id`), a unified `isAssignedAuditor` gate across queue/view/score/discuss, and a *you-vs-other-auditors* PIS-7 radar (per-PLE reveal + home aggregate, **self excluded** so it's a true peer comparison). ICC now **aggregates one human value per PLE** before pairing (a multi-auditor PLE no longer feeds N duplicate-AI pairs into ICC(2,1)) — `oversight.js` + superadmin `/icc`.
  - **(b) Compensation payout pipeline** — `db/migration-compensation-payout.sql`: an **encrypted** `payment_info` vault (AES-256-GCM via `IDENTITY_ENC_KEY`, like `oauth_identities`) + a `payouts` ledger; a physician `/payment` form (physician-only); superadmin owed/paid/outstanding on `/admin/compensation` with **mark-paid** (server-side overpayment guard) + an audit-logged **payout CSV**; rate/cap superadmin-configurable (`comp_rate_thb`=500 / `comp_cap_cles`=3, cap 0 = uncapped).
  - **(c) Superadmin XLSX export** (`exceljs`) — one workbook, a sheet per category (PLEs / AI evals / Auditor scores / Compensation / Participants), **pseudonymized**; button on `/admin/overview`.
  - **(d) UX/Thai-font pass** — physician-ui base 15→16px, 11px micro-labels→12px, `--muted-soft` lifted to AA contrast, wrap/truncation fixes; dashboard `text-xs` 12→13px + navbar specialty. Shared `backend/src/lib/compensation.js` (`compRateCap`/`cappedPles`/`PIS7_DIMS`/`meanByDim`) + `db-helpers.toCsv`.
- **PR #45 — go-live-smoke fix.** Updated stale assertions (already-consented user, Socratic-optional, `EXP-NNN` pseudonyms, `include_test`) → re-ran prod **15/0**.
- **PR #46 — auditor usage bar.** `/admin/users` now shows the **auditor** usage meter for auditor/`can_audit` rows and **both** meters (labelled ผู้ใช้/User · ผู้ตรวจ/Auditor) for a dual-role **Special** user; auditor rows now show usage in the mobile cards too.

**Verification:** 293 backend + 226 RIMPL + 35 dashboard hermetic tests; build/lint/tsc; responsive smoke (0 overflow @ 320/375/768/1280); **live-DB E2E** on a disposable Supabase DB (branching needs the Pro plan — blocked) — migrations apply clean, owed/cap, peer-excludes-self, ICC one-human-per-PLE, guard + `23505` + RLS DENY-ALL all confirmed; prod migration verified (8 assignments backfilled, RLS DENY-ALL on `payment_info`/`payouts`, `audit_scores` unique on `(ple_id, auditor_id)` — old name `audit_scores_ple_auditor_uniq`, so the dup-score backstop is live).

**Prod state to mind:** `peer_calibration` is **OFF** (zero behavior change until a superadmin flips it on `/admin/overview`). A few throwaway soak/smoke test PLEs (`is_test=true`) exist from the go-live runs — excluded from the research export; cleared by `db/reset-demo.js`.

### Plan for next session (2026-06-26)
*06-25 update: item 5 (CI wiring) + the reset-usage and peer-n=1-label parts of the old item 6 are **DONE** (PRs #48, #49) — see "What just shipped (2026-06-25)". Remaining:*
1. **Exercise multi-auditor end-to-end** — flip Peer Calibration on `/admin/overview`; assign **2+ auditors** to an `evaluated` PLE; have them score; confirm the you-vs-other-auditors radar (per-PLE + home aggregate) + `/admin/icc` (per-PLE aggregation) on real data.
2. **Exercise compensation end-to-end** — physician saves payout details at `/payment`; superadmin reviews owed/paid/outstanding, marks a payout, exports the payout CSV; download the multi-sheet XLSX from `/admin/overview`.
3. **Full authenticated browser E2E** of the new dashboard surfaces (deferred 06-24) — superadmin login → users (two usage bars), compensation, overview toggles + export.
4. **Pre-pilot cleanup** — run `db/reset-demo.js` to clear soak/smoke test data; rotate demo credentials (see [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md)).
5. **Enable the opt-in go-live CI** — add the `SMOKE_PHYS_EMAIL` + `SMOKE_PHYS_PW` repo secrets (admin-only) so the `include_ai_smoke` path in `staging-smoke.yml` can run against a non-prod stack.
6. **Remaining Thai-font polish** — revisit any tight Thai-font spots flagged during the 06-24 UX pass.

## What just shipped (2026-06-21) — Specialty layer, position ladder, Google-linking, submit guard

A batch of pilot features (all four layers). Branch work; **prod migration + deploys are gated on the
operator** — see the ordering below.

- **Specialty (the layer under council)** — a new per-council `specialties` table (`db/migration-specialty.sql`),
  seeded with the **15 Royal Colleges** under the Medical Council (TMC). `professionals.specialty_id` +
  `ples.specialty_id` (denormalised from the physician at creation, exactly like `council_id`).
- **Position ladder (ตำแหน่ง)** — `professionals.position` ∈ extern/intern/resident/fellowship/staff/**gp**
  (gp = General Practitioner). Constants in `backend/src/lib/specialties.js` + `audit-dashboard/lib/labels.ts`.
- **Pipeline scoped by council × specialty** — `scopeBySpecialty` (admin.js) pins an admin to their own
  specialty too; auditor assignment now requires **same council AND same specialty** (409 otherwise).
  Specialty is required (API-enforced) for council-scoped roles when the council has specialties.
- **Create/edit/invite** — superadmin create+edit user and the invites form gained **specialty (cascading
  off council) + position** dropdowns; the create-user password field gained an **eye/reveal** toggle.
- **Identity label** — specialty · position shown under the name in both nav bars (audit-dashboard `NavBar`,
  physician-ui dashboard header).
- **Google account linking** — `POST /auth/link-google` records the on-prem `oauth_identities` row for a
  password/invited user who signs in with their **same-email** Google account; physician-ui dashboard shows
  a "Link Google" button when `/auth/me`'s `linked_providers` lacks `google`. **Depends on Supabase
  same-email identity auto-linking being enabled** for the project (verify in the Supabase dashboard).
- **Tier-1 submit guard** — the physician "End & submit" now opens a readiness checklist (the client-checkable
  C1–C3: duration/turns/depth) + a note that AI-judged C4–C6 run on submit + an irreversibility warning.
- **Onboarding** — Google self-signup now collects council **→ specialty** (cascade); public
  `GET /auth/specialties?council_id=`.
- **Rename** — the acronym "PLE" is spelled out as **"Professional Learning Episode"** in physician-portal copy
  (status codes / `PLE-NNN` pseudonyms / `CLE1·2·3` episode codes untouched).

**Deploy ordering (REQUIRED):** apply `db/migration-specialty.sql` (+ backfill existing TMC users' specialty)
**before** deploying the backend — the new PostgREST embeds (`specialties(...)`) and `specialty_id` columns
must exist first, or `/admin/users` and `/admin/ples` will 500. Order: migration → backend (Railway) →
both front-ends (Vercel). Re-run `db/seed-users.js` so demo TMC accounts get Internal Medicine + a position.

## What shipped earlier (2026-06-21) — fix: admin PLE list / auditor assignment (prod 500)

Production regression fix. `GET /admin/ples` (the admin PLE-management list + the assignment surface),
`/admin/ples/flagged` (QA queue), and `/admin/ples/:id/transcript` were **all failing in prod** — the
list/queue returned **500**, the transcript a misleading **404** ("outside your council") — so an admin
saw **0 PLEs**, the QA queue was empty, and **no session could be assigned to an auditor** (the auditor's
queue is assignment-driven, so it stayed empty). Reported via the auditor-flow test.

Root cause: the **PLE→PLE rename** renamed the table + indexes but **not the FK constraints** — Postgres
keeps constraint names across a table rename, so prod's `ples` still had `ples_physician_id_fkey` /
`ples_auditor_id_fkey`. `ples` has **two** FKs to `professionals` (physician + auditor), so the PostgREST
embed of `professionals` is ambiguous and needs a constraint-name hint; those three endpoints embed
`professionals!ples_physician_id_fkey` (correct for fresh installs — `schema.sql` auto-names it `ples_*`),
which **did not resolve** against the renamed prod DB → PostgREST error. The transcript handler
destructures only `{ data: ple }` (ignoring the error) → null `ple` → its `if (!ple)` 404, which the
dashboard renders as "outside your council" (a red herring — councils were fine). Regressed when the
rename deployed (~06-18); the per-physician profile page kept working because it doesn't use the embed.

Fix: **`db/migration-fk-rename.sql`** — renames the 4 `ples` FK constraints `ples_*` → `ples_*` to match
the code + `schema.sql` (metadata-only, instantly reversible; idempotent). Applied to the prod CLICS
Supabase via MCP. Verified: `GET /admin/ples` + `/flagged` now 200; the TMC admin sees all 16 sessions.
*Hardening DONE (2026-06-22, branch `fix/admin-transcript-embed-robustness`): the transcript handler
now uses `maybeSingle()` + `sendDbError`, so a query/embed failure surfaces as a logged **500** instead
of falling through to the misleading 404 (and a messages-fetch error no longer renders a silently-empty
transcript). A static guard test (`backend/tests/admin-transcript-robustness.test.js`) asserts every
`professionals!ples_*_fkey` embed hint in `admin.js` maps to an inline professionals FK on the `ples`
table in `schema.sql`, so the next table rename fails CI, not prod. (`/admin/ples` + `/flagged` already
surfaced the error via `sendDbError`.)*

## What just shipped (2026-06-21) — daily-summary email: removed the cloud sandbox entirely

Ops/tooling fix (not an app-runtime path — the $0.50 cap, blind scoring, and PII boundary are untouched).
The daily Thai progress-summary email kept silently landing as a **Gmail draft** instead of sending. The
2026-06-19 fix (move the *send* to GitHub Actions, keep *generation* in the routine) wasn't enough: on
**2026-06-21** the routine drafted again because `gh` was **not present in the cloud sandbox**, so its
`gh workflow run` dispatch never fired. Root cause, with decisive evidence: the sibling `lidar-hpe`
routine succeeded **4 minutes later in the same cloud environment** — so `gh` availability is **per-repo
GitHub-connection**, and clics's connection is intermittently absent where lidar's is solid. Every failure
this email ever had (jq missing → urllib UA → Python <3.12 f-string → Resend egress block → now `gh`
missing) was a **cloud-sandbox quirk**. So the fix removes the sandbox from the path.

Fix (mirrors lidar-hpe's self-contained `daily_update.py`): generate the report **deterministically inside
GitHub Actions** — no LLM, no sandbox — and trigger it with **native cron**.

- **`scripts/daily-summary/gen_summary.py`** (new, replaces `gen_fallback.py`) — builds the whole `data.json`
  from the runner's git checkout: 24h metrics + a rule-based plain-Thai humanization of the commits
  (conventional-commit prefix → Thai outcome verb, light de-jargon) + the pending **P1** backlog mapped to
  curated Thai sentences (un-mapped bullets are dropped, never leaked as English). Stdlib only, no network.
- **`.github/workflows/daily-summary.yml`** — now triggered by native `schedule:` cron run **twice**
  (08:11 + 08:41 Asia/Bangkok); the 08:41 run is a self-heal **backstop** gated by a dedup guard
  (`gh run list`) so it sends only if the 08:11 run didn't already succeed today → exactly one email on a
  normal day, still covered if GitHub drops the first cron. `workflow_dispatch` stays for manual sends.
  `send.py` (unchanged) renders + POSTs to Resend with the `RESEND_API_KEY` secret.
- **Old LLM routine disabled** (`trig_013if2V1ttgvCmpEhxDq2Pma`, set `enabled:false`) so it can't draft or
  double-send. Trade-off: deterministic Thai is a little less polished than the routine's LLM, but it never
  silently degrades to a draft. Runbook in `scripts/daily-summary/README.md`.

## What just shipped (2026-06-17 / 18) — protocol alignment + readiness

The **CREC/NRCT protocol-alignment** cycle (8 phases) plus a readiness-checks add — merged to `master`
(`d84595a`…`b49c370`) and live in prod (migrations applied to the shared Supabase; Railway + Vercel
redeployed). This is the cycle that built the **research experiment** the protocol hinges on:

- **PLE episode sequencing + Socratic toggle (the experiment).** `ples.episode_number` (1–3, 4th
  blocked), `socratic_active`/`socratic_reason`, `professionals.consecutive_t1_fails`. CLE1/3 run
  **natural** (no forced ❓); CLE2 runs **Socratic-from-start**; a natural session flips to Socratic
  `t1_remediation` after **3 consecutive Tier-1 fails** (resets on a pass). The rimpl prompt split into
  NATURAL / EXAMINER variants threaded by a `socratic` flag. Physician sees "PLE n/3" but not the mode.
- **Pilot Test Mode.** Superadmin toggle (`app_settings.pilot_test_mode`, on the dashboard Overview)
  that lets the team pick Natural/Socratic directly + bypass the 3-PLE cap; such PLEs are `is_test`
  (out of real export/ICC). Exercises Socratic without completing CLE1→CLE2.
- **PLE → PLE rename** across DB + all 4 layers + tests + docs (table `ples`→`ples`, `ple_id`→`ple_id`).
- **Study compliance scaffolding.** `ple_code` (PLE-NNN) + `exp_code` (EXP-NNN) pseudonyms; append-only
  `audit_log` + `logEvent()`; evaluator **version provenance** (`prompt_version`/`rubric_version` hashes);
  structured `consents` table with a physician consent modal + an **auditor confidentiality/COI gate**;
  **Tier-3 analyst** + **Tier-4 ethics** read-only oversight roles (`/oversight`); **compensation report**
  (`/admin/compensation`, ฿500/PLE capped ฿1500). Final consent *wording* still comes from the PI.
- **`/health/deep` readiness checks (P1).** Both RIMPL and the backend now expose `GET /health/deep`
  (the shallow `/health` stays a liveness ping). RIMPL probes Anthropic-key/SDK-constructibility (zero
  token spend) + Supabase; the backend aggregates its own Supabase + RIMPL's deep check, bubbling a
  per-dependency map (200 all-up / 503 degraded). The chat-route 502 gained a stable
  `code: 'rimpl_unavailable'`. See `{backend,rimpl}/src/routes/health.js`.
- **Return-to-Physician** NavBar button for dual-role (`can_audit`) users; **mobile container-query** fix
  (layout grids collapse via `@min-[…px]:` so the forced-mobile preview + real phones go 1-col).

> Reconciliation note: `db/schema.sql` is kept in sync for fresh installs; the 8 migrations
> (`migration-ple-rename.sql` first → … → `migration-oversight-roles.sql`) were applied in order to the
> shared prod Supabase, preserving data.

## What shipped 2026-06-15

A test-hardening + mobile-polish cycle, pushed to master (`1d9a6db`…`e433d41`, CI green) with the
**audit-dashboard redeployed to Vercel**:

- **Automated test pipeline (CI).** `.github/workflows/ci.yml` runs the whole hermetic set on every
  push/PR: backend (**222** tests) + rimpl (all 8 suites now hermetic — the `chat`/`rag-pii`/
  `evaluate-validation` integration suites mock Supabase, no env) + license-verifier + audit-dashboard
  (jest **component tests** + tsc + **blocking ESLint**), each with **coverage-threshold gates**
  (`--coverage`). Six cross-role suites prove the role handoffs. See [TESTING.md](TESTING.md).
- **Dashboard refactor (deployed).** The `react-hooks/set-state-in-effect` debt fixed by migrating
  theme/viewport/auth to `useSyncExternalStore` (`lib/client-store.ts`); `/admin/ples` reads its
  `?status=` drill-down via `useSearchParams` + a Suspense boundary; all 54 `no-explicit-any` typed
  (`lib/types.ts`). `next.config.ts` pins the Turbopack / output-tracing root (the new root
  `package.json` for the dev stack otherwise confused Next's multi-lockfile detection).
- **Mobile layout fixed (deployed).** The nav action cluster no longer overflows phones (icon-only
  toggles + RoleBadge subtitle hidden < 640px) and the auditor scoring page stacks correctly
  (`grid-cols-1`). Audited every page at 320–390px → 0 horizontal overflow.
- **One-command local stack.** `npm run dev` at the repo root boots all four layers (`concurrently`);
  `npm run test:all` runs every hermetic suite.
- **Cross-council guard in the live smoke.** `scripts/smoke/role-chain-smoke.js` now asserts a
  cross-council assign → 409; a 2nd-council (Pharmacy) auditor `auditor2@clics.th` was seeded so it
  fires on real data — live run **21/21**. Full role-chain also browser-E2E'd on prod.

## What shipped before that (2026-06-13 / 14)

Commit **`bf9d5f8`** — the **Claude Design UX/UI audit + a simplify pass**, applied to both front-ends
(frontend only — backend/rimpl untouched, so the $0.50 cap, blind-scoring, and PII boundary are unchanged),
then **deployed to Vercel**. Highlights:

- Flat coral CTA (`#a9583e`, white text 5.06:1 — passes WCAG AA; was a ~3:1 gradient).
- Rubric-anchored **`DomainScorer`** replacing the old `DomainSliders` (deleted); themed
  confirm-modal + toast (`Overlays.tsx` / physician-ui `ui.js`) replacing native dialogs; lucide /
  inline-SVG line-icons replacing functional emoji; bilingual hierarchy (`BiLabel` / `.bi`).
- Auditor gets the physician-grade markdown transcript (`react-markdown` + `remark-gfm`).
- Chart status colors centralized into tokens (`--chart-pass/-fail/-threshold/-warn`); `TranscriptView`
  memoized; physician usage meter reframed to "AI allowance %".
- New shared modules: physician-ui `public/js/{icons,ui}.js`; audit-dashboard
  `components/{BiLabel,DomainScorer,Markdown,Overlays}.tsx`, `lib/{chart-colors,pis7-rubric}.ts`.
  **`lib/pis7-rubric.ts` mirrors `rimpl/src/lib/prompts.js` — keep the two in sync.**

Prod auth'd smoke (superadmin + auditor) passed with **0 console errors**; the DomainScorer was verified
live by reassigning an evaluated PLE to `auditor1`. The original Claude Design audit PDF is in
[design/](design/).

> ⚠️ **Demo-data note:** live verification (the design-audit smoke + the 2026-06-15 role-chain / browser
> E2E / cross-council smokes) mutated demo data on the shared Supabase — several evaluated PLEs were
> (re)assigned to auditor1 and one (`e2ba5470`) scored, and a 2nd-council demo auditor `auditor2@clics.th`
> (Pharmacy) was seeded. All of it is throwaway pre-pilot data that `db/reset-demo.js` clears before real participants.

## Where to start (improvement on-ramp)

[ROADMAP.md](ROADMAP.md) is the prioritized backlog. The **P1 (pilot-readiness)** *engineering* items
are now done — verified 2026-06-18: `db/reset-demo.js` (protocol-aware), cross-pause `active_seconds`
(client accumulates incrementally → server clamps to wall-clock → C1 gate reads it), automated CI, and
`/health/deep`. What remains under P1 is **org-only**: rotate `ANTHROPIC_API_KEY` + demo passwords, and
verify a Resend sending domain (see [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md)).

So the natural next contributions are **P2 spec gaps** — top of the list is full reversible PII
pseudonymization (`P-`/`PLE-` lookup table + broader Thai-name coverage in `rimpl/src/services/pii-filter.js`).

### Open threads as of 2026-08-27

Loose ends a successor inherits, most urgent first:

1. ~~**Clear the privacy queue.**~~ **Measured against production 2026-09-07 and it blocks nothing.**
   The queue holds **13** pending, not 34, and **all 13 are `is_test=true`** sandbox sessions. Every
   one of the 14 `audit_assignments` rows sits on a PLE already at `privacy_review_status='passed'`,
   and only **3** assignment rows across **2** PLEs (1 real, 1 sandbox) are unscored — not 5.
   Kept and struck rather than deleted, because the stale figure is *why* this looked like the most
   urgent item on the list for a fortnight. The gate itself is correct behaviour; there is simply
   nothing waiting behind it.
2. **`identity_verification_required` is 0 and must become 1 before the first participant.** Flipping
   it before the submission form has actually been used blocks every physician from starting a PLE, so
   it is staged deliberately — but shipping without it breaks ICF §4.
3. **Three CREC items are blocked on people, not code** — see *Known gaps* below: D3 pre-approval data
   provenance (research team), the acceptability instrument wording (IRB), and the evaluator model
   identity (Aj. Chanvit).
4. **Land the two open PRs** (#58, #59) and decide on `feat/council-billing-thai-caching`.
   *(The uncommitted rimpl evaluator fix listed here on 2026-08-22 landed as **#64**.)*
5. **Two mobile-audit findings remain**: the dense 8-column `/admin/users` table side-scrolls at
   **768px (iPad portrait) and 812px landscape** because its card fallback is `useIsMobile()` ≤767px.
   Low severity — admin surface, tablet only, contained scroll; phones are clean. Fix is to extend that
   table's card breakpoint to ~1024px.
6. **Dashboard live-smoke in CI is inert** until a repo admin sets `DASH_URL` / `BACKEND_URL` /
   `AUDITOR_EMAIL` / `AUDITOR_PW`. Same for the opt-in go-live smoke's `SMOKE_*` secrets.

## Known gaps & deferred work

- **Full middleware spec** — [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md): L4 multi-provider
  rotation not built (Claude, `claude-sonnet-5-5` since 2026-10-03, plus the on-prem `local` provider); the "4 pre-filter signals" and "ELM" are
  spec'd but not implemented; PII is regex-mask + pseudonym, not yet a fully reversible lookup table
  (residual risk: bare unlabelled **native** Thai surnames not recorded at intake; the `แซ่` Chinese-Thai
  clan-surname class is masked verbatim as of 2026-06-22 — see `rimpl/src/services/pii-filter.js`).
- **#12b full i18n** — only the *label hierarchy* exists (`BiLabel`/`.bi`); there is **no i18n system**
  (a ไทย/EN toggle showing one language at a time, hundreds of strings). Deferred; needs a real i18n layer.
- **Per-council usage billing is a branch, not a feature.** `feat/council-billing-thai-caching`
  carries the `council_usage` table + `increment_council_usage`, `council_id` threaded through the
  spend paths, and `GET /admin/council-usage` — but **the migration has never been applied** and the
  billing model itself is undecided. Treat it as a design decision pending, not as work in progress.
  Hard constraint recorded with it: a **scored PLE must never run through claude.ai** — that path
  bypasses PII de-identification, the C1–C6 gate, provenance and transcript integrity.
- **Three CREC082 items are blocked on people, not engineering.**
  - **D3 — pre-approval data provenance.** 6 evaluated PLEs in the real TMC council carry
    `is_test=false` while the submission states no participant data exists before CREC approval. The
    fix (flag them, record the reconciliation in `audit_log`) is trivial; **deciding what they are is
    not**, and it is the research team's call, not a code one.
  - **Acceptability instrument wording.** `backend/src/lib/acceptability.js` carries
    `INSTRUMENT_VERSION = 'provisional-v1'`. The four **domains** are the protocol's (objective 5:
    acceptability, time burden, data/privacy, suggestions); the seven **sentences** are in no approved
    document. Replace with the IRB-approved wording and **bump the version** — every stored response
    carries it, so responses collected under different wordings can never be pooled by accident.
    Do not edit IRB-approved consent wording directly.
  - **Evaluator model identity (B4).** The Model Lock Record names a **DeepSeek**-based model;
    `cme-dev` serves 8 models, **all Qwen**, 5 of them abliterated community builds. Ask Aj. Chanvit
    which is the real evaluator. If it is `qwen3.6-custom`, the **document** changes, not the code.
- **`pilot_test_mode` is still 1** and stays that way until Napat says otherwise.
- **LINE OAuth** absent (Supabase has no native LINE provider — needs custom OIDC). Google is live.
- The `2026-06-04` plan/spec under `docs/superpowers/` is **historical** and superseded by the design
  audit (it still describes slider-based scoring) — kept for reference, banner-flagged.

## Before real participants (non-engineering gates)

From [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md): IRB sign-off; **rotate `ANTHROPIC_API_KEY`** and the
demo passwords (`db/seed-users.js`); run `db/reset-demo.js` for a clean slate; verify the
migration-applied gate ([deployment.md](deployment.md)); optionally verify a Resend sending domain.

**Settings that must be flipped before the first participant** (all live in `app_settings`; none of
them is a deploy):

| Setting | Now | Must be | Why it is not already set |
|---|---|---|---|
| `identity_verification_required` | 0 | **1** | Fails closed by blocking every physician; guards nothing until there are real participants |
| `evaluator_weights_sha256` | null | **the digest** | Declared at Model Lock time; needs B4 resolved first |
| `min_auditors_per_cle` | 1 | **3** | CREC wants ≥3 raters/PLE. Raising it before recruiting stalls the queue — prod has 3 auditors across 3 of 19 specialties |
| `pilot_test_mode` | 1 | **0** | Held until Napat says so |

Also gating: no participant may start while any AI purpose still reads `anthropic` — see
[LOCAL-MODEL-ROADMAP.md](LOCAL-MODEL-ROADMAP.md). And **A3 (GDCC hosting)** is unresolved: no part of
the stack is in Thailand, against three CREC documents. Either migrate or file a protocol amendment —
do not leave the gap silent.

## Verify the app works

Sign in at the portal with a demo account (creds in [deployment.md](deployment.md)):
`doctor1@clics.th` → create a PLE → chat → expect content + ≥1 `(Source, Year)` ref → end →
**reflection form** → result. A Socratic question is **no longer expected on a normal run** — it fires
only as the rescue, after 4 exchanges that are off-topic or not yet qualifying. As
`auditor1@clics.th` → QA Queue → an assigned evaluated PLE → DomainScorer; **if the queue is empty,
check `/admin/privacy` first** — an evaluated PLE is not assignable until a human clears it. As
`superadmin@clics.th` → overview / ICC / users / governance.
