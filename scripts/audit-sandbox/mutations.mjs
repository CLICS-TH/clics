// The mutation table: one entry per protective line this repo claims to be guarded by a test.
//
// Each entry says "delete or corrupt THIS, and THAT suite must go red". A mutation that survives is
// a finding: the guard is decorative, and whatever it protects can be removed by anyone at any time
// with a green run to point at.
//
// The three bugs that motivated this file all passed every gate:
//   * `text-danger` rendered as plain body text for weeks — the test asserted the CLASS NAME, which
//     is present whether or not the token resolves.
//   * "hitting the cap does not un-rescue the session" asserted `rescue === null` while its comment
//     claimed the rescue prompt stayed in force. It did not.
//   * Three admin screens 404'd in production — every route test builds its own express app and
//     picks its own mount prefix, so both the right and the wrong prefix were green.
//
// Adding a guard without adding it here leaves exactly that gap open.

export const MUTATIONS = [
  // ---- the API contract between the two deployables ------------------------------------------
  {
    id: 'api-contract/mount-prefix',
    why: 'A dashboard call to a path production does not serve must fail a test, not render as "could not reach".',
    file: 'audit-dashboard/app/admin/ai-readiness/page.tsx',
    find: "apiFetch<Readiness>('/admin/ai-readiness')",
    replace: "apiFetch<Readiness>('/superadmin/ai-readiness')",
    dir: 'backend',
    suite: 'tests/api-contract.test.js',
  },
  {
    id: 'api-contract/route-table-read',
    why: 'If the route table comes back empty the contract test passes vacuously — the very failure mode it exists to prevent.',
    file: 'backend/src/routes/superadmin.js',
    find: "router.get('/ai-readiness'",
    replace: "router.get('/ai-readiness-RENAMED'",
    dir: 'backend',
    suite: 'tests/api-contract.test.js',
  },

  // ---- the Socratic rescue -------------------------------------------------------------------
  {
    id: 'rescue/prompt-held-at-cap',
    why: 'At the round cap the turn must still run under the rescue prompt, not fall through to the general examiner.',
    file: 'rimpl/src/routes/chat.js',
    find: '      systemPrompt = RIMPL_SYSTEM_PROMPT_RESCUE;\n      rescue = {',
    replace: '      rescue = {',
    dir: 'rimpl',
    suite: 'tests/rescue.test.js',
  },
  {
    id: 'rescue/cap-is-terminal',
    why: 'A rescue past its cap must END. Left running it is neither re-assessed nor recorded, and recovery becomes unobservable.',
    file: 'rimpl/src/services/rescue.js',
    find: '  return !!rescueActive && rescueRounds >= MAX_RESCUE_ROUNDS;',
    replace: '  return false;',
    dir: 'rimpl',
    suite: 'tests/rescue.test.js',
  },
  {
    id: 'rescue/outcome-recorded',
    why: '"The rescue gave up" and "the rescue is still running" must not both be recorded as silence.',
    file: 'backend/src/routes/ples.js',
    find: "    rescueCols.rescue_outcome = 'exhausted';",
    replace: '',
    dir: 'backend',
    suite: 'tests/ples-rescue-persist.test.js',
  },
  {
    id: 'rescue/classifier-off-physician-budget',
    why: 'The per-round classifier is the system\'s choice; charging it to the physician penalises the people it is performed on.',
    file: 'backend/src/routes/ples.js',
    find: '    rescueCols.rescue_assessment_tokens = (ple.rescue_assessment_tokens ?? 0) + aIn + aOut;',
    replace: '    rescueCols.rescue_assessment_tokens = 0;',
    dir: 'backend',
    suite: 'tests/ples-rescue-persist.test.js',
  },

  // ---- the privacy boundary ------------------------------------------------------------------
  {
    id: 'privacy/report-leaves-the-queue',
    why: 'A reported session must leave the auditor queue whether or not the privacy gate is switched on.',
    file: 'backend/src/routes/auditor.js',
    find: ".eq('status', 'evaluated').eq('privacy_concern_open', false)",
    replace: ".eq('status', 'evaluated')",
    dir: 'backend',
    suite: 'tests/auditor-scoring.test.js',
  },
  {
    id: 'privacy/reporter-is-not-reviewer',
    why: 'Stamping the reporting auditor as the reviewer is the one fact the privacy audit trail exists to state correctly.',
    file: 'backend/src/routes/auditor.js',
    find: "    privacy_review_status: 'pending',\n    privacy_concern_open: true,",
    replace: "    privacy_review_status: 'quarantined',\n    privacy_reviewed_by: req.user.id,\n    privacy_concern_open: true,",
    dir: 'backend',
    suite: 'tests/auditor-scoring.test.js',
  },
  {
    id: 'privacy/self-report-refused',
    why: 'A dual-role rater quarantining their own session is a way to withdraw data without withdrawing from the study.',
    file: 'backend/src/routes/auditor.js',
    find: "  if (ple.physician_id === req.user.id) return res.status(403).json({ error: 'You cannot act on your own session.' });",
    replace: '',
    dir: 'backend',
    suite: 'tests/auditor-scoring.test.js',
  },

  // ---- the readiness gate --------------------------------------------------------------------
  {
    id: 'readiness/numbers-are-fields',
    why: 'The refusal must carry measured and required as fields; prose only a human can parse is what shipped.',
    file: 'rimpl/src/services/providers/local.js',
    find: "status: 'down', model, context_length: ctx, min_context: minContext,",
    replace: "status: 'down', model, context_length: ctx,",
    dir: 'rimpl',
    suite: 'tests/provider-probe.test.js',
  },
  {
    id: 'readiness/unknown-is-unfit',
    why: 'A server that cannot be enumerated proves nothing and must not read as ready.',
    file: 'rimpl/src/services/providers/local.js',
    find: "      return { checks: { local_ai: { status: 'down', error: '/models returned 200 but enumerated no models' } } };",
    replace: "      return { checks: { local_ai: { status: 'up', model, context_length: 'unknown' } } };",
    dir: 'rimpl',
    suite: 'tests/local-provider.test.js',
  },
  {
    id: 'readiness/probe-route-is-gated',
    why: 'The probe route sits inside an OPEN health router and can trigger a paid embedding call.',
    file: 'rimpl/src/routes/health.js',
    find: "router.get('/provider/:name', internalAuth, async (req, res) => {",
    replace: "router.get('/provider/:name', async (req, res) => {",
    dir: 'rimpl',
    suite: 'tests/provider-probe.test.js',
  },
  {
    id: 'readiness/dev-carve-out',
    why: 'The copy of this check that health.js used to carry had lost the carve-out: 401 locally on one route, 200 on every other.',
    file: 'rimpl/src/lib/internal-auth.js',
    find: '  if (!token) return next();',
    replace: '',
    dir: 'rimpl',
    suite: 'tests/provider-probe.test.js',
  },

  // ---- the PII boundary itself ---------------------------------------------------------------
  {
    id: 'pii/outbound-de-identification',
    why: 'The single rule the whole architecture exists for: nothing identifying leaves the on-prem layer.',
    file: 'rimpl/src/routes/chat.js',
    find: '    const cleanMessage = stripPii(message, undefined, hints);',
    replace: '    const cleanMessage = message;',
    dir: 'rimpl',
    // NOT pii-leak-adversarial.test.js, which exercises stripPii as a pure function and stays green
    // with the call deleted from the route. This suite covers what reaches the MODEL; rag-pii covers
    // the embedding leg. Both go red — verified by running the full rimpl suite under this mutation.
    suite: 'tests/chat.test.js',
  },

  // ---- the agreement verdicts ----------------------------------------------------------------
  {
    id: 'icc/insufficient-is-not-pass',
    why: 'Below n=4 the interval is not one to gate on; without this refusal two agreeing pairs could clear a 0.75 gate.',
    file: 'backend/src/services/icc.js',
    find: '  if (n < 4) {',
    replace: '  if (n < 0) {',
    dir: 'backend',
    suite: 'tests/icc-verdict.test.js',
  },
  {
    id: 'icc/missing-shadow-table-is-not-a-500',
    why: 'migration-shadow-evaluations.sql is unapplied in production; this predicate is all that keeps the screen up.',
    file: 'backend/src/services/agreement.js',
    find: "  if (code === 'PGRST205' || code === 'PGRST106' || code === '42P01') return true;",
    replace: "  if (code === 'PGRST205' || code === '42P01') return true;",
    dir: 'backend',
    suite: 'tests/icc-three-way.test.js',
  },

  // ---- the model lock ------------------------------------------------------------------------
  {
    id: 'lock/evaluator-change-refused',
    why: 'Once locked, the scoring instrument is frozen — a mid-cohort swap confounds the primary outcome.',
    file: 'backend/src/routes/superadmin.js',
    find: "        code: 'evaluator_locked', evaluator_locked_at: lockedAt,",
    replace: "        code: 'evaluator_not_locked', evaluator_locked_at: null,",
    dir: 'backend',
    suite: 'tests/evaluator-model-lock.test.js',
  },
  {
    id: 'lock/declaration-gated-on-pass',
    why: 'Freezing a configuration whose agreement has not passed declares a gate met on evidence that does not exist.',
    file: 'backend/src/routes/superadmin.js',
    find: "  if (gate.verdict.state !== 'pass') {",
    replace: "  if (false) {",
    dir: 'backend',
    suite: 'tests/evaluator-model-lock.test.js',
  },
  {
    id: 'lock/relock-takes-its-own-phrase',
    why: 'Re-declaring is permitted only for a critical reason with scoring stopped — pressing the button twice must not do it quietly.',
    file: 'backend/src/routes/superadmin.js',
    find: "  if (existingLock && parsed.data.confirm_relock !== CONFIRM_RELOCK) {",
    replace: "  if (false) {",
    dir: 'backend',
    suite: 'tests/evaluator-model-lock.test.js',
  },

  // ---- the schema contract -------------------------------------------------------------------
  {
    id: 'schema/selected-columns-exist',
    why: 'The mocked suite returns whatever a test hands it, so a column that does not exist ships green and 500s on the first real request.',
    file: 'backend/src/services/rater-spread.js',
    find: 'scored_at, ',
    replace: 'created_at, ',
    dir: 'backend',
    suite: 'tests/select-columns.test.js',
  },

  // ---- the rater-spread reading ----------------------------------------------------------------
  {
    id: 'rater-spread/the-diagnosis',
    why: 'The one sentence an ICC cannot say: the episodes differ from each other by less than the raters differ on the same episode.',
    file: 'audit-dashboard/components/RaterSpread.tsx',
    find: '&& gate.sd_between_observed < gate.sd_error && (',
    replace: '&& false && (',
    dir: 'audit-dashboard',
    suite: '__tests__/RaterSpread.test.tsx',
  },
  {
    id: 'rater-spread/error-not-reported-as-zero',
    why: 'With no multi-rated episode, rater error is unknowable; reporting it as 0 makes the spread requirement look satisfied.',
    file: 'backend/src/services/rater-spread.js',
    find: '  return { varError: spreads.length ? mean(spreads) : null, multiRated };',
    replace: '  return { varError: spreads.length ? mean(spreads) : 0, multiRated };',
    dir: 'backend',
    suite: 'tests/rater-spread.test.js',
  },

  // ---- the front-end token layer -------------------------------------------------------------
  {
    id: 'theme/token-has-a-utility-mapping',
    why: 'Tailwind v4 generates text-danger only from a --color-danger entry; without it the class renders as body text.',
    file: 'audit-dashboard/app/globals.css',
    find: '  --color-danger: var(--danger);',
    replace: '',
    dir: 'audit-dashboard',
    suite: '__tests__/theme-tokens.test.ts',
  },
  {
    id: 'theme/contrast-holds-on-a-card',
    why: 'A muted token that clears AA on the canvas can still fail on a card — 4.48:1, live on the reflection form.',
    file: 'physician-ui/public/css/main.css',
    find: '  --muted:           #6b6964;',
    replace: '  --muted:           #6c6a64;',
    dir: 'audit-dashboard',
    suite: '__tests__/contrast.test.ts',
  },
  {
    id: 'mirror/anchor-vocabulary',
    why: 'Three copies of one triple: the buttons, the zod enum, and a SQL CHECK. Drift is invisible until a rater submits.',
    file: 'audit-dashboard/components/DomainScorer.tsx',
    find: '{ value: "ambiguous", th: "ยาก/ก้ำกึ่ง", en: "Ambiguous" },',
    replace: '{ value: "unclear", th: "ยาก/ก้ำกึ่ง", en: "Ambiguous" },',
    dir: 'audit-dashboard',
    suite: '__tests__/backend-mirrors.test.ts',
  },
  {
    id: 'mirror/attestation-keys',
    why: 'A key that drifts here produces a form the rater can complete and the server will refuse.',
    file: 'backend/src/lib/schemas.js',
    find: "const SCORE_ATTESTATIONS = [",
    replace: "const SCORE_ATTESTATIONS = ['drifted',",
    dir: 'audit-dashboard',
    suite: '__tests__/backend-mirrors.test.ts',
  },

  // ---- the local-AI capacity layer (2026-09-02) ----------------------------------------------
  {
    id: 'queue/sweep-never-reenqueues-live-rows',
    why: 'The reconcile sweep re-enqueueing a row that is already queued resets its claim, attempts and backoff — a row in flight gets claimed twice and the box scores it twice.',
    file: 'backend/src/services/reconcile.js',
    find: '      if (!p.eval_enqueued_at) {',
    replace: '      if (true) {',
    dir: 'backend',
    suite: 'tests/reconcile.test.js',
  },
  {
    id: 'scope/unknown-council-fails-closed',
    why: 'A typo in eval_drain_exclude_councils must make the drain claim NOTHING. Failing open lets the prod drain score the sandbox on the cloud model — the evaluator confound the partition exists to prevent.',
    file: 'backend/src/lib/eval-scope.js',
    find: '    include: failedClosed ? [NIL_UUID] : (INCLUDE_CODES.length ? ids(INCLUDE_CODES) : null),',
    replace: '    include: INCLUDE_CODES.length ? ids(INCLUDE_CODES) : null,',
    dir: 'backend',
    suite: 'tests/eval-scope.test.js',
  },
  {
    id: 'budget/token-ceiling-enforced',
    why: 'The local model is priced $0, so the $ cap never throttles it. If the token comparison goes, a physician\'s load on the shared box is unbounded and nothing in the UI says so.',
    file: 'backend/src/lib/usage.js',
    find: '  const tokenOver = tokenLimit != null && tokens >= tokenLimit;',
    replace: '  const tokenOver = false;',
    dir: 'backend',
    suite: 'tests/token-budget.test.js',
  },
  {
    id: 'lanes/background-respects-reserve',
    why: 'Without the reserve rule a burst of evaluations fills every slot and the next physician\'s chat turn — and the End click — waits behind 70-second scoring calls.',
    file: 'rimpl/src/services/providers/runtime.js',
    find: '    return total() < maxConcurrency && active.background < backgroundMax;',
    replace: '    return total() < maxConcurrency;',
    dir: 'rimpl',
    suite: 'tests/runtime-lanes.test.js',
  },
];
