#!/usr/bin/env node
/*
 * Where is the local-model cutover blocked right now, and what is the next action?
 *
 * WHY THIS EXISTS. The programme spans a network gate, a JSON-contract gate, a human-ICC baseline,
 * a paired shadow corpus, two agreement verdicts and a Model Lock — across a roadmap, a probe
 * harness, a calibration harness, three database tables and four app_settings keys. "Are we blocked
 * on the box, or on raters, or on nothing?" took reading all of them, so nobody asked.
 *
 * READ-ONLY. Every database call is a .select(); the network probe is a GET /models. It reuses
 * backend/src/services/agreement.js and backend/src/lib/settings.js rather than reimplementing the
 * verdicts, so this cannot disagree with GET /oversight/icc/three-way or with the Model Lock gate.
 *
 * Run from backend/ (dotenv loads backend/.env and NODE_PATH resolves @supabase/supabase-js):
 *   cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/local-model/status.mjs
 *
 * Flags:
 *   --json        machine-readable, for pasting a status into the roadmap
 *   --no-probe    skip the network probe (offline, or you do not want to touch the box)
 *
 * Exit codes: 0 = every gate passed (ready to lock) · 1 = blocked somewhere · 2 = misconfigured.
 */
import { createRequire } from 'node:module';

// Resolved against backend/, not this file: NODE_PATH does not apply to ESM `import`, and every
// dependency here (dotenv, @supabase/supabase-js, the backend modules themselves) lives there.
const require = createRequire(`${process.cwd()}/`);
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const PROBE = !argv.includes('--no-probe');

let supabase, decisiveVerdict, pairedSets, iccGates, getTextSetting, verdictFor, iccTwoRater;
try {
  require('dotenv').config();
  ({ supabase } = require(`${process.cwd()}/src/lib/supabase`));
  ({ decisiveVerdict, pairedSets } = require(`${process.cwd()}/src/services/agreement`));
  ({ iccGates, getTextSetting } = require(`${process.cwd()}/src/lib/settings`));
  ({ verdictFor, iccTwoRater } = require(`${process.cwd()}/src/services/icc`));
} catch (e) {
  console.error(`Could not load the backend modules — run this from backend/:\n  cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/local-model/status.mjs\n\n${e.message}`);
  process.exit(2);
}

const C = { reset: '[0m', red: '[31m', green: '[32m', yellow: '[33m', dim: '[2m', bold: '[1m' };
const MARK = { pass: `${C.green}PASS${C.reset}`, block: `${C.red}BLOCKED${C.reset}`, wait: `${C.yellow}WAITING${C.reset}` };

// --- G0: can this machine reach the box at all? ------------------------------------------------
async function probeBox() {
  const base = String(process.env.LOCAL_AI_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return { state: 'block', detail: 'LOCAL_AI_BASE_URL is not set — the box has no address in this environment' };
  if (!PROBE) return { state: 'wait', detail: `probe skipped (--no-probe); configured as ${base}` };
  try {
    const res = await fetch(`${base}/models`, {
      headers: process.env.LOCAL_AI_API_KEY ? { authorization: `Bearer ${process.env.LOCAL_AI_API_KEY}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { state: 'block', detail: `${base}/models returned ${res.status}` };
    const body = await res.json().catch(() => null);
    const ids = (body?.data ?? []).map((m) => m.id);
    // An enumerable-but-empty /models is the reverse-proxy case: reachable, serving nothing.
    if (!ids.length) return { state: 'block', detail: `${base}/models answered 200 but enumerated no models` };
    const pinned = process.env.LOCAL_AI_MODEL;
    if (pinned && !ids.includes(pinned)) {
      return { state: 'block', detail: `LOCAL_AI_MODEL="${pinned}" is not served (available: ${ids.slice(0, 4).join(', ')})` };
    }
    return { state: 'pass', detail: `${ids.length} model(s) served: ${ids.slice(0, 4).join(', ')}` };
  } catch (e) {
    return { state: 'block', detail: `${base} unreachable — ${e.message}` };
  }
}

// --- G0.5: the human-auditor baseline the whole programme is go/no-go on ------------------------
// Deliberately computed the SAME way the decisive arm is (auditors averaged to one value per CLE
// before pairing), so a number here is comparable with the number that will gate the lock.
async function humanBaseline(gates) {
  const sets = await pairedSets({ includeTest: false });
  if (!sets.ok) return { state: 'block', detail: `could not read the corpus: ${sets.error?.message ?? sets.error}` };
  if (sets.empty) return { state: 'block', detail: 'no CLE carries both an AI evaluation and a human score' };
  const pairs = sets.withAi
    .map((id) => ({ a: sets.aiBy.get(id), b: sets.humanBy.get(id) }))
    .filter((p) => p.a && p.b)
    .map((p) => ({ a: Number(p.a.composite_score), b: Number(p.b.composite_score) }));
  const v = verdictFor(iccTwoRater(pairs), gates.decisive);
  return {
    state: v.state === 'pass' ? 'pass' : v.state === 'fail' ? 'block' : 'wait',
    detail: `incumbent vs human: ${v.icc == null ? 'no estimate' : v.icc.toFixed(3)} on n=${v.n} — ${v.why}`,
    verdict: v,
  };
}

// --- the shadow corpus: does a candidate exist and has it scored anything? ----------------------
async function shadowCorpus() {
  const { data, error } = await supabase
    .from('shadow_evaluations').select('provider, model_version, error');
  if (error) {
    return { state: 'block', detail: `shadow_evaluations unreadable — ${error.message} (is db/migration-shadow-evaluations.sql applied?)` };
  }
  const rows = data ?? [];
  if (!rows.length) {
    return { state: 'wait', detail: 'table present, 0 rows — the shadow evaluator writes only when a NON-serving provider exists' };
  }
  const scored = rows.filter((r) => r.error == null).length;
  const failed = rows.length - scored;
  const candidates = [...new Set(rows.map((r) => `${r.provider}/${r.model_version}`))];
  // A candidate that cannot hold the scoring contract is a disqualifying result, not missing data.
  const rate = rows.length ? (scored / rows.length) : 0;
  return {
    state: scored ? 'pass' : 'block',
    detail: `${scored} scored, ${failed} failed (${(rate * 100).toFixed(0)}% contract) across ${candidates.join(', ')}`,
  };
}

async function main() {
  const gates = await iccGates();
  const [box, providers, lockedAt] = await Promise.all([
    probeBox(),
    Promise.all(['chat', 'evaluate', 'criteria', 'discuss', 'embed'].map(async (p) => [p, await getTextSetting(`ai_provider_${p}`, '(env)')])),
    getTextSetting('evaluator_locked_at', null),
  ]);
  const byPurpose = Object.fromEntries(providers);
  const anyLocal = Object.values(byPurpose).includes('local');

  const baseline = await humanBaseline(gates);
  const shadow = await shadowCorpus();
  const decisive = await decisiveVerdict({});

  const decisiveState = !decisive.ok ? 'block'
    : decisive.verdict.state === 'pass' ? 'pass'
    : decisive.verdict.state === 'fail' ? 'block' : 'wait';

  const ladder = [
    { id: 'G0  access', ...box,
      next: 'Get tailnet access to cme-dev (100.68.210.69) and the INFERENCE port, not just the UI port.' },
    { id: 'G0  gate-0 probe', state: box.state === 'pass' ? 'wait' : 'wait',
      detail: box.state === 'pass' ? 'box reachable — run the probe harness' : 'cannot run until the box is reachable',
      next: 'node scripts/probe/discover.mjs, then json-contract.mjs (>=95%) and thai-probe.mjs.' },
    { id: 'G0.5 human baseline', ...baseline,
      next: 'More auditor scores on CLEs that already carry an AI evaluation. This is programme go/no-go (D14).' },
    { id: 'P3  a purpose is local', state: anyLocal ? 'pass' : 'wait',
      detail: anyLocal ? `local serves: ${Object.entries(byPurpose).filter(([, v]) => v === 'local').map(([k]) => k).join(', ')}`
        : `every purpose on ${[...new Set(Object.values(byPurpose))].join(', ')} — nothing to shadow against`,
      next: 'PATCH /admin/ai-providers for a non-evaluate purpose first; the readiness gate refuses an unfit box.' },
    { id: 'P4  shadow corpus', ...shadow,
      next: 'Point `evaluate` shadowing at the candidate and let CLEs accumulate paired scores.' },
    { id: 'P4  decisive verdict', state: decisiveState,
      detail: !decisive.ok ? `could not compute: ${decisive.error?.message ?? decisive.error}`
        : `candidate vs human ${decisive.verdict.icc == null ? '(no estimate)' : decisive.verdict.icc.toFixed(3)} vs gate ${gates.decisive} — ${decisive.verdict.why}`,
      next: 'Accumulate paired scores until the whole interval clears the gate. `insufficient` is not `fail` (D19).' },
    { id: 'P5  model lock', state: lockedAt ? 'pass' : 'wait',
      detail: lockedAt ? `locked at ${lockedAt}` : 'not locked',
      next: 'Declare on /admin/evaluator-lock. Refused until the decisive verdict passes; must disclose the shadow evaluator (D11).' },
  ];

  if (AS_JSON) {
    console.log(JSON.stringify({ gates, providers: byPurpose, evaluator_locked_at: lockedAt, ladder }, null, 2));
  } else {
    console.log(`\n${C.bold}Local-model cutover — where we are${C.reset}\n`);
    for (const step of ladder) {
      console.log(`  ${MARK[step.state]}  ${C.bold}${step.id}${C.reset}  ${C.dim}${step.detail}${C.reset}`);
    }
    const blocker = ladder.find((s) => s.state !== 'pass');
    console.log('');
    if (!blocker) {
      console.log(`${C.green}Every gate has passed. The evaluator can be locked.${C.reset}\n`);
    } else {
      console.log(`${C.bold}Next action${C.reset} — ${blocker.id}\n  ${blocker.next}\n`);
      // Only the FIRST unmet step is actionable; the rest are consequences of it, and listing them
      // as separate work is how a single blocker gets mistaken for a programme in trouble.
      const rest = ladder.slice(ladder.indexOf(blocker) + 1).filter((s) => s.state !== 'pass');
      if (rest.length) console.log(`${C.dim}  ${rest.length} later step(s) wait on this one, not on anything else.${C.reset}\n`);
    }
  }
  process.exit(ladder.every((s) => s.state === 'pass') ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
