// Regression suite for three-way.js.
//
// Why this exists, and why it is a black-box suite rather than unit tests: the same defect class
// has now shipped into this script TWICE and was caught by human review both times, never by a
// test. Both instances were a SCOPE LEAK -- `--manifest` narrowed a set that a later consumer
// still read under a broader meaning:
//
//   f91cd2d  the corpus COUNTERS (corpusRate, contractOk) were reading the manifest subset while
//            labelled "whole corpus";
//   b472ef8  the candidate IDENTITY those counters count was still cohort-scoped, so adding
//            --manifest could switch WHICH model was measured and flip the contract gate
//            FAIL 50% -> PASS 100% on the same database.
//
// Neither bug lives in a function. Both live in the composition of scoping across the whole
// script, which is exactly what a unit test cannot see -- so this suite runs the real entry point
// as a subprocess against a fixed fixture database, and asserts on what an operator actually
// reads: stdout and the archived JSON.
//
// The database is stubbed by putting a fake @supabase/supabase-js on NODE_PATH. No network, no
// real Supabase, no paid API, no writes into the committed runs/ directory.
//
// Fixture `two-candidates.json` is built for the b472ef8 repro:
//   local/m2  newest corpus-wide, CLEAN on p01-p05 and FAILING on p06-p10  -> 50% corpus contract
//   local/m1  older overall, but its most recent rows sit on p01-p05
// so a manifest of p01-p05 is precisely the case where "most recent inside the cohort" disagrees
// with "most recent overall". That is not a corner case: the G0.5 manifest is the OLDEST PLEs and
// a backfill runs oldest-first.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'three-way.js');
const FIX = path.join(HERE, '__fixtures__');

let runsDir;
before(() => { runsDir = mkdtempSync(path.join(tmpdir(), 'three-way-runs-')); });
after(() => { rmSync(runsDir, { recursive: true, force: true }); });

/** Run the real script against the fixture DB. Returns {status, stdout, stderr}. Never throws. */
function run(args = [], { db = 'two-candidates.json' } = {}) {
  const env = {
    ...process.env,
    // resolve, not join: an absolute path (an in-memory DB written to a temp file) must win.
    MOCK_DB: path.resolve(FIX, db),
    NODE_PATH: path.join(FIX, 'stub-modules'),
    THREE_WAY_RUNS_DIR: runsDir,
    SUPABASE_URL: 'http://fixture.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture',
    // Keep the real evaluator/provider env out of the subprocess: a developer's shell must not be
    // able to change what this suite measures.
    ANTHROPIC_API_KEY: '', LOCAL_AI_BASE_URL: '', LOCAL_AI_MODEL: '',
  };
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The most recently archived run. */
function latestArchive() {
  const files = readdirSync(runsDir).filter(f => f.endsWith('.json')).sort();
  assert.ok(files.length, 'expected the run to archive a JSON file');
  return JSON.parse(readFileSync(path.join(runsDir, files.at(-1)), 'utf8'));
}

/** The `-> provider/model` line naming the candidate actually measured. */
function measuredCandidate(stdout) {
  const m = stdout.match(/^\s*->\s*(\S+)/m);
  return m ? m[1] : null;
}

/** The "shadow contract rate (whole corpus)" figure, as printed. */
function corpusContractLine(stdout) {
  const m = stdout.match(/shadow contract rate \(whole corpus\)\s*:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

describe('--manifest scopes the REPORT, never the measurement', () => {
  // The b472ef8 regression. On the broken code these two assertions read
  // local/m2 vs local/m1 and 50.0% vs 100.0%.
  test('the candidate measured does not change when a manifest is applied', () => {
    const whole = run();
    const scoped = run(['--manifest', path.join(FIX, 'manifest-early5.json')]);

    assert.equal(whole.status, 0, whole.stderr);
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.equal(
      measuredCandidate(scoped.stdout), measuredCandidate(whole.stdout),
      'WHICH model is measured is a property of the corpus. A manifest that changes it means the '
      + 'run reports a different model under the same command.',
    );
  });

  test('the corpus contract gate does not move with the cohort', () => {
    const whole = run();
    const scoped = run(['--manifest', path.join(FIX, 'manifest-early5.json')]);

    // The fixture candidate fails half the corpus, so this must read FAIL either way.
    assert.match(corpusContractLine(whole.stdout), /^50\.0%\s+\(5\/10\)/);
    assert.equal(
      corpusContractLine(scoped.stdout), corpusContractLine(whole.stdout),
      'The contract rate is labelled "whole corpus" and is an acceptance gate. A manifest that '
      + 'moves it lets a scoped run PASS a gate the candidate fails corpus-wide.',
    );
    for (const r of [whole, scoped]) assert.match(r.stdout, /\[ FAIL\s*\] contract compliance/);
  });

  test('a cohort holding no shadow rows still reports the corpus, not a zero', () => {
    // The fixture's shadow rows for the chosen candidate straddle the corpus; a late manifest
    // leaves the cohort with no scored shadow rows. Out-of-scope must not render as a confident
    // corpus-wide absence -- the same "withheld must never look like empty" invariant the reveal
    // lock and the budget-pool reader both enforce.
    const late = run(['--manifest', path.join(FIX, 'manifest-late5.json')]);
    assert.equal(late.status, 0, late.stderr);
    assert.match(corpusContractLine(late.stdout), /^50\.0%\s+\(5\/10\)/);
    assert.doesNotMatch(corpusContractLine(late.stdout), /n\/a/);
  });

  test('the archive does not contradict itself about how many rows the candidate has', () => {
    run(['--manifest', path.join(FIX, 'manifest-early5.json')]);
    const a = latestArchive();
    const chosen = a.shadow.candidates.find(c =>
      c.provider === a.shadow.provider && c.model_version === a.shadow.model_version);

    assert.ok(chosen, 'the measured candidate must appear in the candidates list');
    assert.equal(
      chosen.rows, a.corpus.shadow_scored + a.corpus.shadow_failed,
      'candidates[].rows is a corpus count and must agree with corpus.shadow_scored + shadow_failed '
      + 'in the same file.',
    );
    assert.ok(chosen.rows_in_cohort <= chosen.rows, 'the cohort count cannot exceed the corpus count');
  });
});

describe('a run must be reproducible from its own archive', () => {
  test('--manifest records the file, its sha256 and the id count', () => {
    run(['--manifest', path.join(FIX, 'manifest-early5.json')]);
    const early = latestArchive().scope;
    assert.equal(early.manifest.ids, 5);
    // Truncated to 16 hex on purpose (three-way.js:123), matching how prompt shas are recorded.
    assert.match(early.manifest.sha256, /^[0-9a-f]{16}$/);
    assert.ok(early.manifest.file.endsWith('manifest-early5.json'));

    // It has to be a fingerprint of the CONTENT, not of the filename -- two cohorts of the same
    // size must not archive the same sha, or the record cannot tell them apart.
    run(['--manifest', path.join(FIX, 'manifest-late5.json')]);
    const late = latestArchive().scope;
    assert.equal(late.manifest.ids, 5);
    assert.notEqual(late.manifest.sha256, early.manifest.sha256);
  });

  test('--raters records WHICH raters, not just how many', () => {
    // A bare count cannot be reproduced: two runs both reading `"raters": 1` are
    // indistinguishable, and nothing in an audit_scores row separates a recruited physician from
    // a simulated soak rater posting through the same API -- which is what the flag excludes.
    const r = run(['--raters', 'EXP-R1']);
    assert.equal(r.status, 0, r.stderr);
    const { scope } = latestArchive();
    assert.notEqual(typeof scope.raters, 'number', 'a bare count is not a reproducible record');
    assert.deepEqual(scope.raters.ids, ['EXP-R1']);
    assert.deepEqual(scope.raters.matched, ['EXP-R1']);
    assert.equal(scope.raters.source, 'EXP-R1');
  });

  test('the prompt mixture is always reported, even with no --prompt', () => {
    // Pooling scores across evaluator prompts is a silent defect: ICC is a property of
    // (model x prompt x rubric). The fixture deliberately mixes a recorded version with nulls.
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(latestArchive().scope.prompt_versions_present.length > 1);
    assert.match(r.stdout, /prompt/i);
  });
});

describe('scoping flags fail closed', () => {
  // Every one of these must REFUSE. Silently shrinking the cohort instead is the failure mode the
  // flags exist to prevent -- a smaller cohort still prints a confident number.
  const refusals = [
    ['an id the database does not know', ['--manifest', path.join(FIX, 'manifest-ghost.json')]],
    ['a duplicated id',                  ['--manifest', path.join(FIX, 'manifest-dupe.json')]],
    ['an unreadable manifest',           ['--manifest', path.join(FIX, 'does-not-exist.json')]],
    ['a rater with no score in cohort',  ['--raters', 'EXP-NOBODY']],
    ['an unknown prompt version',        ['--prompt', 'pis7-prompt-not-a-real-version']],
  ];
  for (const [what, args] of refusals) {
    test(`refuses ${what}`, () => {
      const r = run(args);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stdout:\n${r.stdout}`);
    });
  }
});

describe('local-vs-auditor with no Claude row required (anchor PLEs)', () => {
  // Built in memory: the anchors imported into SANDBOX carry auditor + shadow scores and, on
  // purpose, NO ai_evaluations row. The three-arm cohort (all three present) can never contain
  // them, so before this section local-vs-auditor on the anchors was uncomputable.
  const D = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
  const vec = (base, i) => Object.fromEntries(D.map((d, k) => [d, Math.max(0, Math.min(5, base + ((i + k) % 3) - 1))]));
  const comp = (v) => D.reduce((s, d) => s + v[d], 0) * 20 / 7;
  function makeDb({ claudeOn = [] } = {}) {
    const db = { ples: [], ai_evaluations: [], audit_scores: [], shadow_evaluations: [],
      professionals: [{ id: 'ph1', pseudonym: 'P-001' }, { id: 'aud-1', pseudonym: 'P-101', exp_code: 'EXP-R1' }] };
    for (let i = 0; i < 8; i++) {
      const id = `a${i}`;
      const base = 1 + (i % 4);
      const human = vec(base, i);
      const local = vec(Math.min(5, base + (i % 2)), i + 1);
      db.ples.push({ id, is_test: false, physician_id: 'ph1' });
      db.audit_scores.push({ id: `au-${id}`, ple_id: id, auditor_id: 'aud-1', composite_score: comp(human), ...human });
      db.shadow_evaluations.push({ id: `sh-${id}`, ple_id: id, provider: 'local', model_version: 'CCME_LLM_v8.0+m',
        evaluated_at: '2026-10-02T10:00:00Z', error: null, stop_reason: null, composite_score: comp(local), ...local });
      if (claudeOn.includes(id)) {
        db.ai_evaluations.push({ id: `ai-${id}`, ple_id: id, composite_score: comp(local), ...local, prompt_version: 'p1', model_version: 'CCME_LLM_v8.0' });
      }
    }
    return db;
  }
  let dbDir;
  before(() => { dbDir = mkdtempSync(path.join(tmpdir(), 'three-way-db-')); });
  after(() => { rmSync(dbDir, { recursive: true, force: true }); });
  const runOn = (db, name, args = []) => {
    const file = path.join(dbDir, `${name}.json`);
    writeFileSync(file, JSON.stringify(db));
    return run(args, { db: file });
  };

  test('with NO ai_evaluations at all: the three arms behave as before, the new section measures all 8', () => {
    const r = runOn(makeDb(), 'no-claude');
    assert.equal(r.status, 0, r.stderr);
    const a = latestArchive();
    // Unchanged: no Claude row -> no common cohort -> shadow arms unavailable.
    assert.equal(a.arms.shadow_vs_human, null);
    assert.equal(a.coverage.ples_all_three, 0);
    assert.equal(a.common_cohort_n, 0);
    // The new, separately labelled section with its own n.
    assert.match(r.stdout, /ARM\s+Local vs Auditor \(no Claude row required\)/);
    assert.match(r.stdout, /8 PLEs with a Local and an auditor score \(8 of them have no Claude row\)/);
    assert.equal(a.local_vs_auditor_no_claude.n, 8);
    assert.equal(a.local_vs_auditor_no_claude.ples_without_claude, 8);
    assert.equal(a.local_vs_auditor_no_claude.arm.n, 8);
    assert.equal(typeof a.local_vs_auditor_no_claude.arm.overall.icc, 'number');
    // Not an acceptance input: the gate still has no local-vs-auditor ICC to read.
    assert.equal(a.acceptance.local_vs_human_icc, null);
  });

  test('with Claude on some PLEs: the common-cohort arm keeps its n, the new section counts every shadow+auditor PLE', () => {
    const r = runOn(makeDb({ claudeOn: ['a0', 'a1', 'a2'] }), 'some-claude');
    assert.equal(r.status, 0, r.stderr);
    const a = latestArchive();
    assert.equal(a.arms.shadow_vs_human.n, 3);
    assert.equal(a.common_cohort_n, 3);
    assert.equal(a.local_vs_auditor_no_claude.n, 8);
    assert.equal(a.local_vs_auditor_no_claude.ples_without_claude, 5);
  });

  test('it respects --manifest like every other arm', () => {
    const man = path.join(dbDir, 'man.json');
    writeFileSync(man, JSON.stringify({ ple_ids: ['a0', 'a1', 'a2', 'a3'] }));
    const r = runOn(makeDb(), 'scoped', ['--manifest', man]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(latestArchive().local_vs_auditor_no_claude.n, 4);
  });

  test('without a shadow table the section reports unavailable, not a number', () => {
    const db = makeDb();
    delete db.shadow_evaluations;
    const r = runOn(db, 'no-shadow-table');
    assert.equal(r.status, 0, r.stderr);
    const a = latestArchive();
    assert.equal(a.local_vs_auditor_no_claude.n, 0);
    assert.equal(a.local_vs_auditor_no_claude.arm, null);
  });
});
