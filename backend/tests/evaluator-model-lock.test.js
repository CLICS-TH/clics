// The Primary Evaluator Model Lock.
//
// Scores already carried a configuration fingerprint. What was missing is the DECLARATION of the
// parts a running system cannot read for itself — the weights checksum above all, which is not
// obtainable over an inference API and has to be stated by someone with filesystem access. Until it
// is, the lock is an assertion rather than a checkable fact.
//
// The gate is the point of this suite: a configuration may not be frozen against a number that never
// touched a human judgement, and it may not be frozen against a number the data cannot support.
//
// Since GitHub #75 / CCME R2 it is also bound to the BUILD it froze: POST /evaluator-lock reads rimpl's
// model manifest (GET /manifest, mocked here to its contract) and refuses anything it cannot verify.
// And it fails closed: an unreadable lock state, a failed audit write, a rollback that did not finish —
// each is an answer, never a silent default.
//
// The database is the shared hermetic double (tests/helpers/supabase-mock) over a small in-memory
// model of the three tables involved — app_settings, evaluator_model_lock and audit_log — so the
// real lib/audit.js runs, awaited, and every write is checked against what the table then holds.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
// decisiveVerdict is the agreement assembly's job (tests/agreement-grouping.test.js); here it is a
// verdict on demand. Everything else in the module is real.
jest.mock('../src/services/agreement', () => ({ ...jest.requireActual('../src/services/agreement'), decisiveVerdict: jest.fn() }));
jest.mock('../src/services/rimpl-client', () => ({
  fetchRimplManifest: jest.fn(),
  probeRimplProvider: async () => ({ fit: true }),
  probeRimplDeep: jest.fn(async () => ({ body: {} })),
  // rimpl's local-only mode is off here, so the switch reaches the lock checks this suite is about.
  fetchRimplLocalOnly: async () => 'off',
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { decisiveVerdict } = require('../src/services/agreement');
const { fetchRimplManifest, probeRimplDeep } = require('../src/services/rimpl-client');
const { evaluatorDigest, resetManifestCache } = require('../src/services/model-lock');

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/superadmin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const SA = { id: 'sa-1', role: 'superadmin', status: 'active', email: 'sa@t' };
const DIGEST = 'a'.repeat(64);
const MSHA = 'f'.repeat(64);
const PV = 'pis7-prompt-59561c29+local-c5ffe572aa81';
const RV = 'pis7-weights-08b0cb1a';
const MV = 'CCME_LLM_v8.0+qwen-2.5-72b';
const DECLARATION = {
  weights_sha256: DIGEST,
  inference_engine: 'vllm 0.21.1',
  quantization: 'Q8_0',
  system_prompt_version: 'sys-v3',
  evaluator_prompt_version: PV,
  rubric_version: RV,
  decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: 7 },
  environment: { os: 'ubuntu 24.04', cuda: '12.4' },
};

// The manifest rimpl serves, in the shape of rimpl/src/routes/manifest.js. `live` carries a sentinel
// that must never reach the lock row.
const LIVE_SENTINEL = 'LIVE-ONLY-qwen-served-id-0xDEADBEEF';
// A server's own string, declared in the manifest. It may be frozen with the expected half, but the GET
// screen's expected_for_candidate never relays it.
const FP_SENTINEL = 'vllm-FP-SENTINEL-tp2';
const EXPECTED = {
  code: {
    anthropic: { model: 'claude-sonnet-4-6', model_version: 'CCME_LLM_v8.0+claude-sonnet-4-6' },
    model_version_prefix: 'CCME_LLM_v8.0+',
    evaluator: { prompt_version: { anthropic: 'pis7-prompt-59561c29', local: PV }, rubric_version: RV },
    // The rimpl shape: a plain number, or { default, env } for an env-tunable value.
    decoding: { evaluate: { max_tokens: { default: 1500, env: 'EVAL_MAX_TOKENS' }, temperature: 0 },
      num_ctx: { local: { default: null, env: 'LOCAL_AI_NUM_CTX', sent: 'as options.num_ctx, only when > 0' },
        'local-tutor': { default: null, env: 'LOCAL_TUTOR_AI_NUM_CTX', sent: 'as options.num_ctx, only when > 0' } } },
    // applies_to: EVAL_CONSISTENCY reaches the local arm only (rimpl lib/consistency-config.js).
    consistency: { evaluate: { mode: { default: 'off', env: 'EVAL_CONSISTENCY', applies_to: 'local' },
      json_retries: { default: 2, env: 'EVAL_JSON_RETRIES' } } },
    providers: { allowed: { evaluate: ['anthropic', 'local'] } },
  },
  declared: { providers: { evaluate: 'local' },
    local: { role: 'evaluator', model: 'qwen-2.5-72b', engine: 'vllm', system_fingerprint: FP_SENTINEL } },
};
const manifestBody = (over = {}) => ({
  manifest: { schema: 'clics-model-manifest/v1', expected: EXPECTED, sha256: MSHA },
  sha256: MSHA, claimed_sha256: MSHA, file: 'present', code_match: true,
  live: { models: { local: LIVE_SENTINEL } }, drift: [],
  ...over,
});

const CANDIDATE = { provider: 'local', model_version: MV, prompt_version: PV, rubric_versions: [RV] };
const verdict = (state, over = {}, candidate = CANDIDATE) => ({
  ok: true,
  verdict: { state, threshold: 0.75, icc: 0.82, lower: 0.77, upper: 0.9, n: 60, why: 'the whole interval is at or above 0.75', ...over },
  candidate,
});

// ---- the in-memory database --------------------------------------------------------------------
let db;
const err = (message, code) => ({ error: { message, ...(code ? { code } : {}) } });
function freshDb() {
  return {
    settings: {}, locks: [], audit: [], seq: 0,
    // Fault injection. Each is checked where the read or write happens.
    fail: {
      settingsRead: null,      // a key, or '*', whose strict read errors
      lockUpsert: null,        // error for the upsert that SETS the lock
      restoreUpsert: null,     // error for an upsert that writes back previous values (a rollback)
      restoreShort: false,     // that rollback upsert confirms fewer rows than it wrote
      clearUpsert: null,       // error for the unlock's clearing upsert
      audit: null,             // { action, message }: an audit_log insert for that action errors
      deleteErr: null,         // error for the rollback delete
      deleteMatchesNothing: false,
      schemaProbe: null,       // error for the manifest-column probe
      insert: null,            // error for the lock-row insert
      insertNoRow: false,      // the insert returns no row
      insertRowNoId: false,    // the insert returns a row, but without its id
    },
  };
}

function resolve(table, kind, ctx) {
  const f = db.fail;
  if (table === 'app_settings') {
    if (kind === 'maybeSingle') {
      const key = ctx.id('key');
      if (f.settingsRead === '*' || f.settingsRead === key) return err('connection reset');
      return key in db.settings ? { value_text: db.settings[key] } : null;
    }
    if (kind === 'upsert') {
      const rows = [].concat(ctx.payload);
      const sets = rows.some((r) => r.key === 'evaluator_locked_at' && r.value_text != null);
      const isRollback = Array.isArray(ctx.selectArgs) && ctx.selectArgs.length > 0;   // restoreLockSettings selects
      if (isRollback && f.restoreUpsert) return err(f.restoreUpsert);
      if (!isRollback && sets && f.lockUpsert) return err(f.lockUpsert);
      if (!isRollback && !sets && rows.some((r) => r.key === 'evaluator_locked_at') && f.clearUpsert) return err(f.clearUpsert);
      for (const r of rows) db.settings[r.key] = r.value_text;
      if (isRollback && f.restoreShort) return { data: rows.slice(1).map((r) => ({ key: r.key })) };
      return { data: rows.map((r) => ({ key: r.key })) };
    }
    return undefined;
  }
  if (table === 'evaluator_model_lock') {
    if (kind === 'list') return f.schemaProbe ? { error: f.schemaProbe } : [];           // the column probe
    if (kind === 'maybeSingle' && ctx.op === 'insert') {
      if (f.insert) return { error: f.insert };
      const row = { id: `lock-${++db.seq}`, ...ctx.payload };
      db.locks.push(row);
      if (f.insertRowNoId) { const { id: _id, ...rest } = row; return rest; }
      return f.insertNoRow ? null : row;
    }
    if (kind === 'maybeSingle') return db.locks.at(-1) ?? null;                             // GET's current
    if (kind === 'delete') {
      if (f.deleteErr) return err(f.deleteErr);
      if (f.deleteMatchesNothing) return { data: [] };
      const id = ctx.id('id');
      const gone = db.locks.filter((l) => l.id === id);
      db.locks = db.locks.filter((l) => l.id !== id);
      return { data: gone.map((l) => ({ id: l.id })) };
    }
    return undefined;
  }
  if (table === 'audit_log' && kind === 'insert') {
    if (f.audit && f.audit.action === ctx.payload.action) return err(f.audit.message);
    db.audit.push(ctx.payload);
    return { data: null };
  }
  return undefined;
}

beforeEach(() => {
  m.reset();
  db = freshDb();
  m.state.caller = SA;
  m.state.resolve = resolve;
  // The candidate below is local, and a lock may only be declared on the provider serving `evaluate`.
  db.settings.ai_provider_evaluate = 'local';
  decisiveVerdict.mockReset().mockImplementation(async () => verdict('pass'));
  fetchRimplManifest.mockReset().mockImplementation(async () => manifestBody());
  probeRimplDeep.mockReset().mockImplementation(async () => ({ body: {} }));
  resetManifestCache();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { console.error.mockRestore(); });

const declare = (body = DECLARATION) => auth(request(app).post('/admin/evaluator-lock')).send(body);
const getLock = () => auth(request(app).get('/admin/evaluator-lock'));
const patch = (body) => auth(request(app).patch('/admin/ai-providers')).send(body);
const lockAudits = () => db.audit.filter((e) => e.action === 'evaluator_model_lock');
// Nothing of a lock exists: no record, no flag, no digest.
const expectNoLock = () => {
  expect(db.locks).toHaveLength(0);
  expect(db.settings.evaluator_locked_at ?? null).toBeNull();
  expect(db.settings.evaluator_weights_sha256 ?? null).toBeNull();
};

describe('the gate on declaring', () => {
  test('a candidate that has not cleared the decisive bar cannot be frozen', async () => {
    decisiveVerdict.mockResolvedValue(verdict('fail', { why: 'the whole interval is below 0.75' }));
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('gate_not_passed');
    expectNoLock();
  });

  test('INSUFFICIENT is refused too — not knowing is not permission', async () => {
    // The tempting reading is that only an outright `fail` should block. It is exactly backwards:
    // freezing on a number the data cannot support is the failure mode the third state exists for.
    decisiveVerdict.mockResolvedValue(verdict('insufficient', { why: '3 pairs cannot support a confidence interval' }));
    const r = await declare();
    expect(r.status).toBe(409);
    expectNoLock();
  });

  test('the refusal says which state and why, so it is actionable', async () => {
    decisiveVerdict.mockResolvedValue(verdict('insufficient', { why: 'the interval spans 0.75 — more pairs are needed to decide' }));
    const r = await declare();
    expect(r.body.error).toMatch(/insufficient/);
    expect(r.body.gate.why).toMatch(/more pairs/);
  });

  test('the verdict is computed on the DECLARED prompt version\'s own rows', async () => {
    await declare();
    expect(decisiveVerdict).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: PV }));
  });

  test('a prompt version nobody scored under is refused, and the refusal says so', async () => {
    decisiveVerdict.mockResolvedValue({ ...verdict('insufficient', { why: 'no estimate', n: 0 }), candidate: null });
    const r = await declare({ ...DECLARATION, evaluator_prompt_version: 'pis7-prompt-typo' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('gate_not_passed');
    expect(r.body.error).toMatch(/No candidate scores were recorded under prompt_version "pis7-prompt-typo"/);
    expectNoLock();
  });
});

describe('declaring', () => {
  test('writes ONE record carrying everything the system could not read for itself', async () => {
    const r = await declare();
    expect(r.status).toBe(200);
    expect(db.locks).toHaveLength(1);
    expect(db.locks[0]).toMatchObject({
      weights_sha256: DIGEST,
      inference_engine: 'vllm 0.21.1',
      evaluator_prompt_version: PV,
      rubric_version: RV,
      locked_by: SA.id,
      provider: 'local', model_version: MV,
    });
  });

  test('stores the verdict that PERMITTED the freeze, beside the freeze', async () => {
    // Otherwise "was this frozen against a number that had cleared the bar?" is answerable only by
    // reconstructing the corpus as it stood that day, which nobody will do.
    await declare();
    expect(db.locks[0].gate).toMatchObject({ state: 'pass', threshold: 0.75, n: 60 });
  });

  test('freezes the manifest sha256 and its EXPECTED half — never the live view', async () => {
    const r = await declare();
    expect(r.body.manifest_sha256).toBe(MSHA);
    expect(db.locks[0].manifest_sha256).toBe(MSHA);
    expect(db.locks[0].manifest).toEqual(EXPECTED);
    expect(JSON.stringify(db.locks[0])).not.toContain(LIVE_SENTINEL);
    expect(db.locks[0]).not.toHaveProperty('live');
  });

  test('freezes no expected config_fingerprint: nothing reliable exists to freeze', async () => {
    await declare();
    expect(Object.keys(db.locks[0]).filter((k) => /fingerprint/.test(k))).toEqual([]);
  });

  test('sets the flag the provider switch refuses on, and the digest every later score is stamped with', async () => {
    await declare();
    expect(db.settings.evaluator_locked_at).toEqual(db.locks[0].locked_at);
    expect(db.settings.evaluator_weights_sha256).toBe(DIGEST);
  });

  test('is one audit entry, naming what was frozen — including the manifest', async () => {
    await declare();
    expect(lockAudits()).toHaveLength(1);
    expect(lockAudits()[0].metadata).toMatchObject({
      weights_sha256: DIGEST, model_version: MV, prompt_version: PV, rubric_version: RV,
      manifest_sha256: MSHA, record_id: db.locks[0].id,
    });
  });

  test('a checksum that is not a SHA-256 digest is refused', async () => {
    // A checksum nobody can verify the shape of is a string, not evidence.
    for (const bad of ['not-a-digest', 'abc123', 'z'.repeat(64), '']) {
      expect((await declare({ ...DECLARATION, weights_sha256: bad })).status).toBe(400);
    }
    expectNoLock();
  });

  test('the fields only a person can state are required, not optional', async () => {
    for (const k of ['inference_engine', 'system_prompt_version', 'evaluator_prompt_version', 'rubric_version']) {
      const { [k]: _drop, ...partial } = DECLARATION;
      expect((await declare(partial)).status).toBe(400);
    }
  });
});

describe('GET /evaluator-lock', () => {
  test('reports that declaring is unavailable, and why', async () => {
    decisiveVerdict.mockResolvedValue(verdict('insufficient', { why: '3 pairs cannot support a confidence interval' }));
    const r = await getLock();
    expect(r.status).toBe(200);
    expect(r.body.can_declare).toBe(false);
    expect(r.body.blockers).toEqual(['gate_not_passed']);
    expect(r.body.gate).toMatchObject({ state: 'insufficient' });
  });

  test('opens only on a pass, against a verified manifest that agrees with the candidate', async () => {
    const r = await getLock();
    expect(r.body.can_declare).toBe(true);
    expect(r.body.blockers).toEqual([]);
    expect(r.body.candidate).toMatchObject({ model_version: MV, prompt_version: PV });
    expect(r.body.manifest).toMatchObject({ ok: true, sha256: MSHA, file: 'present', code_match: true,
      expected_for_candidate: { prompt_version: PV, rubric_version: RV, model_version: MV } });
    expect(r.body.manifest_diff).toEqual([]);
    expect(r.body.migrations_pending).toEqual([]);
  });

  test('stays closed while rimpl cannot show a verified manifest', async () => {
    fetchRimplManifest.mockRejectedValue(Object.assign(new Error('RIMPL /manifest error: 404'), { status: 404 }));
    const r = await getLock();
    expect(r.status).toBe(200);
    expect(r.body.can_declare).toBe(false);
    expect(r.body.blockers).toEqual(['manifest_unavailable']);
    expect(r.body.manifest).toMatchObject({ ok: false, code: 'manifest_unavailable', reason: 'unreachable' });
  });

  test('stays closed when the candidate was scored under a prompt the manifest no longer ships', async () => {
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, prompt_version: 'pis7-prompt-59561c29+local-aaaaaaaaaaaa' }));
    const r = await getLock();
    expect(r.body.can_declare).toBe(false);
    expect(r.body.blockers).toEqual(['manifest_mismatch']);
    expect(r.body.manifest_diff).toEqual([expect.objectContaining({ field: 'prompt_version', source: 'candidate', expected: PV })]);
  });

  test('an unmigrated database is a reason on the screen, not a 500', async () => {
    db.fail.schemaProbe = { code: '42703', message: 'column evaluator_model_lock.manifest_sha256 does not exist' };
    const r = await getLock();
    expect(r.status).toBe(200);
    expect(r.body.can_declare).toBe(false);
    expect(r.body.blockers).toEqual(['migration_required']);
    expect(r.body.migrations_pending).toEqual(['db/migration-evaluator-lock-manifest.sql']);
  });

  test('an unreadable lock state is a 503, not a guess at "unlocked"', async () => {
    db.fail.settingsRead = 'evaluator_locked_at';
    const r = await getLock();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('lock_state_unreadable');
  });

  test('after an unlock the record stays on file and in_force says it is no longer the lock', async () => {
    await declare();
    expect((await getLock()).body.in_force).toBe(true);
    await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    const r = await getLock();
    expect(r.body.locked_at).toBeNull();
    expect(r.body.current).toMatchObject({ id: db.locks[0].id });
    expect(r.body.in_force).toBe(false);
  });
});

// The candidate is frozen as the study's measuring instrument, so it must be a provider that may serve
// `evaluate` (lib/ai-providers.js). services/agreement.js never picks the tutor model; this pins the
// same rule at the write itself, so it holds even if the assembly changes (CCME R3).
describe('the tutor model is never a lockable evaluator', () => {
  const tutorGate = () => verdict('pass', {}, { provider: 'local-tutor', model_version: 'qwen-tutor', prompt_version: PV, rubric_versions: [RV] });

  test('POST refuses a local-tutor candidate even on a passing verdict — no record, no flag', async () => {
    decisiveVerdict.mockResolvedValue(tutorGate());
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('candidate_not_evaluator');
    expectNoLock();
  });

  test('GET does not offer the form for it', async () => {
    decisiveVerdict.mockResolvedValue(tutorGate());
    const r = await getLock();
    expect(r.body.can_declare).toBe(false);
    expect(r.body.blockers).toContain('candidate_not_evaluator');
  });

  test('the evaluator transport is unaffected: a passing local candidate still locks', async () => {
    const r = await declare();
    expect(r.status).toBe(200);
    expect(db.locks).toHaveLength(1);
  });
});

test('once declared, the evaluator provider is refused outright', async () => {
  // The lock is only worth having if it actually stops the thing it names. This is the existing
  // refusal; the point here is that DECLARING is what arms it.
  await declare();
  const r = await patch({ purpose: 'evaluate', provider: 'anthropic', confirm: 'CHANGE EVALUATOR' });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('evaluator_locked');
});

// Two ways the lock could end up meaning less than it says.
describe('the lock cannot half-happen, or be replaced by accident', () => {
  test('a second declaration is REFUSED without its own typed phrase', async () => {
    await declare();
    const again = await declare();
    // Replacing a lock is not a repeat of the same action: the change-control rule allows it only
    // for a critical safety or security reason, with scoring stopped and the data either side
    // separated. Pressing the button twice must not be able to do that quietly.
    expect(again.status).toBe(409);
    expect(again.body.confirm_phrase).toBe('REPLACE THE LOCK');
    expect(db.locks).toHaveLength(1);
  });

  test('with the phrase it goes through, and the audit entry names what it replaced', async () => {
    await declare();
    const first = db.settings.evaluator_locked_at;
    const r = await declare({ ...DECLARATION, confirm_relock: 'REPLACE THE LOCK' });
    expect(r.status).toBe(200);
    expect(db.locks).toHaveLength(2);          // append-only: the first freeze stays on the record
    expect(lockAudits().at(-1).metadata.replaced_lock).toBe(first);
  });

  test('the phrase is not stored as if it were part of the declaration', async () => {
    await declare();
    await declare({ ...DECLARATION, confirm_relock: 'REPLACE THE LOCK' });
    expect(db.locks.at(-1)).not.toHaveProperty('confirm_relock');
  });

  test('a record whose lock did not apply is rolled back BY ITS ID, and the delete is checked', async () => {
    // Otherwise it is the worst of both: a signed record asserting a freeze that the provider-switch
    // endpoint would still happily override, because the flag it reads was never set.
    db.fail.lockUpsert = 'app_settings write failed';
    const r = await declare();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('lock_not_applied');
    expect(r.body.error).toMatch(/rolled back/);
    const del = m.all('evaluator_model_lock', 'delete');
    expect(del).toHaveLength(1);
    expect(del[0].eqs).toEqual([['id', 'lock-1']]);      // the id, and only the id
    expectNoLock();
  });

  test('…and if that delete fails, the 500 names the record left standing', async () => {
    db.fail.lockUpsert = 'app_settings write failed';
    db.fail.deleteErr = 'statement timeout';
    const r = await declare();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('rollback_incomplete');
    expect(r.body.inconsistent).toEqual([expect.objectContaining({ step: 'delete_record', left: expect.stringMatching(/lock-1/) })]);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ROLLBACK INCOMPLETE/));
  });

  test('…and a delete that matched no row is a failure too, not a success', async () => {
    db.fail.lockUpsert = 'app_settings write failed';
    db.fail.deleteMatchesNothing = true;
    const r = await declare();
    expect(r.body.code).toBe('rollback_incomplete');
    expect(r.body.inconsistent[0].step).toBe('delete_record');
  });

  test('an insert that returns no row id writes nothing else, and says the record is unconfirmed', async () => {
    db.fail.insertNoRow = true;
    const r = await declare();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('lock_record_unconfirmed');
    expect(db.settings.evaluator_locked_at ?? null).toBeNull();
    expect(lockAudits()).toHaveLength(0);
  });
});

// The audit entry IS part of the lock: a freeze nobody can account for is not one.
describe('the audit write is strict, and a failed one undoes the lock', () => {
  test('first lock: audit fails → settings restored, the record deleted by id, 500 audit_write_failed', async () => {
    db.fail.audit = { action: 'evaluator_model_lock', message: 'audit_log insert refused' };
    const r = await declare();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('audit_write_failed');
    expectNoLock();
    expect(m.all('evaluator_model_lock', 'delete')[0].eqs).toEqual([['id', 'lock-1']]);
    // The restore was CHECKED: it asked for the rows back.
    const restore = m.all('app_settings', 'upsert').find((q) => q.selectArgs);
    expect(restore.selectArgs).toEqual(['key']);
  });

  test('re-declaration: audit fails → the PREVIOUS lock is back exactly, and only the new record goes', async () => {
    await declare();
    const before = { ...db.settings };
    const firstId = db.locks[0].id;
    db.fail.audit = { action: 'evaluator_model_lock', message: 'audit_log insert refused' };
    const r = await declare({ ...DECLARATION, weights_sha256: 'b'.repeat(64), confirm_relock: 'REPLACE THE LOCK' });
    expect(r.body.code).toBe('audit_write_failed');
    expect(db.settings.evaluator_locked_at).toBe(before.evaluator_locked_at);
    expect(db.settings.evaluator_weights_sha256).toBe(DIGEST);
    expect(db.locks.map((l) => l.id)).toEqual([firstId]);
  });

  test('audit fails and the settings restore fails → 500 rollback_incomplete naming the settings', async () => {
    db.fail.audit = { action: 'evaluator_model_lock', message: 'audit_log insert refused' };
    db.fail.restoreUpsert = 'connection reset';
    const r = await declare();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('rollback_incomplete');
    expect(r.body.inconsistent.map((f) => f.step)).toEqual(['restore_settings']);
    expect(r.body.inconsistent[0].left).toMatch(/unaudited lock/);
    expect(db.locks).toHaveLength(0);                    // the record step still ran, and succeeded
  });

  test('a restore that confirms fewer rows than it wrote is a failure, not a success', async () => {
    db.fail.audit = { action: 'evaluator_model_lock', message: 'audit_log insert refused' };
    db.fail.restoreShort = true;
    const r = await declare();
    expect(r.body.code).toBe('rollback_incomplete');
    expect(r.body.inconsistent[0].step).toBe('restore_settings');
  });

  test('audit fails and BOTH rollback steps fail → both are named', async () => {
    db.fail.audit = { action: 'evaluator_model_lock', message: 'audit_log insert refused' };
    db.fail.restoreUpsert = 'connection reset';
    db.fail.deleteErr = 'connection reset';
    const r = await declare();
    expect(r.body.inconsistent.map((f) => f.step)).toEqual(['restore_settings', 'delete_record']);
  });
});

// ---- #75 gap: fail closed on the lock state --------------------------------------------------
describe('an unreadable lock state is never read as "unlocked"', () => {
  test('POST: 503 lock_state_unreadable, nothing written, rimpl not even asked', async () => {
    db.fail.settingsRead = 'evaluator_locked_at';
    const r = await declare();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'lock_state_unreadable' });
    expect(r.body.error).toMatch(/ \/ The evaluator lock state could not be read/);   // bilingual
    expectNoLock();
    expect(fetchRimplManifest).not.toHaveBeenCalled();
  });

  test('POST: the digest is needed for a rollback, so its read error refuses too', async () => {
    db.fail.settingsRead = 'evaluator_weights_sha256';
    expect((await declare()).status).toBe(503);
    expectNoLock();
  });

  test('PATCH evaluate switch: 503 — a read error must not let the evaluator change while it might be locked', async () => {
    db.settings.evaluator_locked_at = '2026-10-01T00:00:00.000Z';
    db.fail.settingsRead = 'evaluator_locked_at';
    const r = await patch({ purpose: 'evaluate', provider: 'anthropic', confirm: 'CHANGE EVALUATOR' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('lock_state_unreadable');
    expect(m.all('app_settings', 'upsert')).toHaveLength(0);
  });

  test('PATCH unlock: 503, the lock stays', async () => {
    await declare();
    db.fail.settingsRead = 'evaluator_locked_at';
    const r = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(r.status).toBe(503);
    expect(db.settings.evaluator_weights_sha256).toBe(DIGEST);
  });

  test('a chat switch does not depend on the lock, so it still goes through — and says it cannot show the lock', async () => {
    db.fail.settingsRead = 'evaluator_locked_at';
    const r = await patch({ purpose: 'chat', provider: 'local' });
    expect(db.settings.ai_provider_chat).toBe('local');
    // The write is in; the read-back of the lock is not. Never "nothing was changed", never a guessed state.
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('saved_state_unreadable');
    expect(r.body.error).toMatch(/Saved/);
    expect(r.body.error).toMatch(/ \/ /);
  });
});

// ---- #75 gap: unlock clears the digest --------------------------------------------------------
describe('unlock clears everything the lock set', () => {
  test('the flag AND the weights digest, so later scores stop reading `locked: true`', async () => {
    await declare();
    const r = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(r.status).toBe(200);
    expect(r.body.evaluator_locked_at).toBeNull();
    expect(db.settings.evaluator_locked_at).toBeNull();
    expect(db.settings.evaluator_weights_sha256).toBeNull();
    const audit = db.audit.find((e) => e.action === 'evaluator_lock');
    expect(audit.metadata).toMatchObject({ locked: false, previous_weights_sha256: DIGEST,
      cleared: ['evaluator_locked_at', 'evaluator_weights_sha256'] });
  });

  test('a digest left behind by the old quick unlock is cleared by unlocking again', async () => {
    // The state the old PATCH produced: flag cleared, digest still set.
    db.settings.evaluator_weights_sha256 = DIGEST;
    const r = await patch({ evaluator_locked: false });
    expect(r.status).toBe(200);
    expect(db.settings.evaluator_weights_sha256).toBeNull();
  });

  test('the record of the lock is not deleted by an unlock (append-only)', async () => {
    await declare();
    await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(db.locks).toHaveLength(1);
    expect(m.all('evaluator_model_lock', 'delete')).toHaveLength(0);
  });

  test('an unlock whose audit write fails puts the lock back — flag and digest — and says so', async () => {
    await declare();
    const lockedAt = db.settings.evaluator_locked_at;
    db.fail.audit = { action: 'evaluator_lock', message: 'audit_log insert refused' };
    const r = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('audit_write_failed');
    expect(db.settings.evaluator_locked_at).toBe(lockedAt);
    expect(db.settings.evaluator_weights_sha256).toBe(DIGEST);
  });

  test('…and if putting it back fails too, 500 rollback_incomplete', async () => {
    await declare();
    db.fail.audit = { action: 'evaluator_lock', message: 'audit_log insert refused' };
    db.fail.restoreUpsert = 'connection reset';
    const r = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(r.body.code).toBe('rollback_incomplete');
    expect(r.body.inconsistent[0]).toMatchObject({ step: 'restore_settings' });
    expect(r.body.inconsistent[0].left).toMatch(/not on the audit trail/);
  });

  test('a clearing write that fails changes nothing and is a 500', async () => {
    await declare();
    db.fail.clearUpsert = 'write failed';
    const r = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(r.status).toBe(500);
    expect(db.settings.evaluator_weights_sha256).toBe(DIGEST);
    expect(db.audit.filter((e) => e.action === 'evaluator_lock')).toHaveLength(0);
  });
});

// ---- #75 gap: the quick lock bypassed the record ----------------------------------------------
describe('PATCH /ai-providers can no longer lock', () => {
  test('{evaluator_locked: true} → 409 use_model_lock, pointing at POST /admin/evaluator-lock; nothing written', async () => {
    const r = await patch({ evaluator_locked: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'use_model_lock', lock_endpoint: 'POST /admin/evaluator-lock' });
    expect(r.body.error).toMatch(/\/admin\/evaluator-lock/);
    expect(m.all('app_settings', 'upsert')).toHaveLength(0);
    expect(db.audit).toHaveLength(0);
  });

  test('…even when a lock is already in force (it used to be an idempotent no-op)', async () => {
    await declare();
    const r = await patch({ evaluator_locked: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('use_model_lock');
  });
});

// ---- binding to the manifest -------------------------------------------------------------------
describe('the manifest must be verifiable, or nothing is frozen', () => {
  test.each([
    ['rimpl unreachable', () => fetchRimplManifest.mockRejectedValue(new Error('connect ECONNREFUSED')), 'unreachable'],
    ['rimpl predates the manifest (404)', () => fetchRimplManifest.mockRejectedValue(Object.assign(new Error('RIMPL /manifest error: 404'), { status: 404 })), 'unreachable'],
    ['the file is missing', () => fetchRimplManifest.mockResolvedValue(manifestBody({ file: 'missing', sha256: null, manifest: null })), 'file_not_present'],
    ['the file is invalid', () => fetchRimplManifest.mockResolvedValue(manifestBody({ file: 'invalid', sha256: null })), 'file_not_present'],
    ['sha256 is null', () => fetchRimplManifest.mockResolvedValue(manifestBody({ sha256: null })), 'unverified'],
    ['sha256 is not a digest', () => fetchRimplManifest.mockResolvedValue(manifestBody({ sha256: 'nope', claimed_sha256: 'nope' })), 'unverified'],
    ['the claimed sha differs from the verified one', () => fetchRimplManifest.mockResolvedValue(manifestBody({ claimed_sha256: 'e'.repeat(64) })), 'unverified'],
    ['code_match is false', () => fetchRimplManifest.mockResolvedValue(manifestBody({ code_match: false })), 'code_mismatch'],
    ['code_match is null', () => fetchRimplManifest.mockResolvedValue(manifestBody({ code_match: null })), 'code_mismatch'],
    ['no expected half', () => fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { schema: 'x', sha256: MSHA } })), 'malformed'],
  ])('%s → 503, nothing frozen', async (_label, setup, reason) => {
    setup();
    const r = await declare();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'manifest_unavailable', reason });
    expect(r.body.error).toMatch(/ \/ /);   // bilingual
    expectNoLock();
    expect(decisiveVerdict).not.toHaveBeenCalled();
  });
});

describe('declared vs measured vs the manifest', () => {
  test('a pass earned under an addendum that no longer ships → 409 with the field-by-field diff', async () => {
    const OLD = 'pis7-prompt-59561c29+local-aaaaaaaaaaaa';
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, prompt_version: OLD }));
    const r = await declare({ ...DECLARATION, evaluator_prompt_version: OLD });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('manifest_mismatch');
    expect(r.body.diff).toEqual([{
      field: 'evaluator_prompt_version', source: 'declaration', value: OLD, expected: PV,
      manifest_path: 'expected.code.evaluator.prompt_version.local',
    }]);
    expect(r.body.error).toMatch(/evaluator_prompt_version: declared "pis7-prompt-59561c29\+local-aaaaaaaaaaaa", manifest expects "pis7-prompt-59561c29\+local-c5ffe572aa81"/);
    expect(r.body.manifest_sha256).toBe(MSHA);
    expectNoLock();
  });

  test('a declared rubric that is not the manifest\'s → 409', async () => {
    const r = await declare({ ...DECLARATION, rubric_version: 'pis7-weights-ffffffff' });
    expect(r.status).toBe(409);
    expect(r.body.diff.map((d) => d.field)).toEqual(['rubric_version']);
  });

  test('a candidate model the manifest does not declare → 409 (measured, not declared)', async () => {
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, model_version: 'CCME_LLM_v8.0+llama-3.1-8b' }));
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body.diff).toEqual([expect.objectContaining({ field: 'model_version', source: 'candidate',
      value: 'CCME_LLM_v8.0+llama-3.1-8b', expected: MV })]);
  });

  test('a candidate whose rows span two rubrics is not one instrument → 409', async () => {
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, rubric_versions: [RV, 'pis7-weights-older'] }));
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body.diff.map((d) => d.field)).toEqual(['candidate_rubric_versions']);
  });

  test('a manifest that names no expectation for the provider cannot be met → 409, expected null', async () => {
    fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { sha256: MSHA, expected: { ...EXPECTED, declared: {} } } }));
    const r = await declare();
    expect(r.status).toBe(409);
    // No declared block: neither the evaluate provider nor the model can be met.
    expect(r.body.diff).toEqual([
      expect.objectContaining({ field: 'provider', expected: null, manifest_path: 'expected.declared.providers.evaluate' }),
      expect.objectContaining({ field: 'model_version', expected: null }),
    ]);
  });

  test('an anthropic candidate is checked against the pinned Anthropic model', async () => {
    // Serving anthropic, and a manifest whose target deployment scores with anthropic.
    db.settings.ai_provider_evaluate = 'anthropic';
    const expected = { ...EXPECTED, declared: { ...EXPECTED.declared, providers: { evaluate: 'anthropic' } } };
    fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { sha256: MSHA, expected } }));
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, {
      provider: 'anthropic', model_version: 'CCME_LLM_v8.0+claude-sonnet-4-6', prompt_version: 'pis7-prompt-59561c29', rubric_versions: [RV],
    }));
    const r = await declare({ ...DECLARATION, evaluator_prompt_version: 'pis7-prompt-59561c29' });
    expect(r.status).toBe(200);
    expect(db.locks[0]).toMatchObject({ provider: 'anthropic', manifest_sha256: MSHA });
    // The instrument digest is the anthropic one: it covers code.anthropic, and differs from local's.
    expect(db.locks[0].evaluator_sha256).toBe(evaluatorDigest(expected, 'anthropic'));
    expect(db.locks[0].evaluator_sha256).not.toBe(evaluatorDigest(expected, 'local'));
  });
});

// ---- code ships before the migration -----------------------------------------------------------
describe('before db/migration-evaluator-lock-manifest.sql is applied', () => {
  test('a missing manifest column: POST 503 migration_required, naming the file; nothing written', async () => {
    db.fail.schemaProbe = { code: '42703', message: 'column evaluator_model_lock.manifest_sha256 does not exist' };
    const r = await declare();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'migration_required', migrations: ['db/migration-evaluator-lock-manifest.sql'] });
    expect(r.body.error).toMatch(/apply db\/migration-evaluator-lock-manifest\.sql first/);
    expectNoLock();
  });

  test('no lock table at all: both migrations, in order', async () => {
    db.fail.schemaProbe = { code: 'PGRST205', message: "Could not find the table 'public.evaluator_model_lock' in the schema cache" };
    const r = await declare();
    expect(r.status).toBe(503);
    expect(r.body.migrations).toEqual(['db/migration-evaluator-model-lock.sql', 'db/migration-evaluator-lock-manifest.sql']);
  });

  test('the insert itself reporting a missing column (PGRST204) is a 503 too, never a 500', async () => {
    db.fail.insert = { code: 'PGRST204', message: "Could not find the 'manifest' column of 'evaluator_model_lock' in the schema cache" };
    const r = await declare();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('migration_required');
    expect(db.settings.evaluator_locked_at ?? null).toBeNull();
  });

  test('any other probe error is a 500, not a migration message', async () => {
    db.fail.schemaProbe = { code: '57014', message: 'canceling statement due to statement timeout' };
    expect((await declare()).status).toBe(500);
  });
});

// ---- the lock freezes what is actually scoring ---------------------------------------------------
describe('the candidate must be the provider serving evaluate', () => {
  test('POST: a local candidate while anthropic serves → 409 candidate_not_serving, bilingual, nothing written', async () => {
    db.settings.ai_provider_evaluate = 'anthropic';
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'candidate_not_serving', candidate_provider: 'local', serving_provider: 'anthropic' });
    expect(r.body.error).toMatch(/ \/ /);
    expect(r.body.error).toMatch(/Switch evaluate to local first/);
    expectNoLock();
  });

  test('POST: an unset evaluate provider reads as its default (anthropic), so a local candidate is refused', async () => {
    delete db.settings.ai_provider_evaluate;
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'candidate_not_serving', serving_provider: 'anthropic' });
    expectNoLock();
  });

  test('POST: an unreadable evaluate provider is 503 lock_state_unreadable, never a guess', async () => {
    db.fail.settingsRead = 'ai_provider_evaluate';
    const r = await declare();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('lock_state_unreadable');
    expectNoLock();
  });

  test('GET: the same rule is a blocker, and the screen names who is serving', async () => {
    db.settings.ai_provider_evaluate = 'anthropic';
    const r = await getLock();
    expect(r.status).toBe(200);
    expect(r.body.blockers).toContain('candidate_not_serving');
    expect(r.body.serving_provider).toBe('anthropic');
    expect(r.body.can_declare).toBe(false);
  });

  test('GET: an unreadable evaluate provider is 503, not a form', async () => {
    db.fail.settingsRead = 'ai_provider_evaluate';
    const r = await getLock();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('lock_state_unreadable');
  });

  test('POST: a candidate provider that is not the manifest\'s declared evaluate provider → 409 provider diff', async () => {
    const expected = { ...EXPECTED, declared: { ...EXPECTED.declared, providers: { evaluate: 'anthropic' } } };
    fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { sha256: MSHA, expected } }));
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('manifest_mismatch');
    expect(r.body.diff).toEqual([{ field: 'provider', source: 'candidate', value: 'local', expected: 'anthropic',
      manifest_path: 'expected.declared.providers.evaluate' }]);
    expectNoLock();
  });
});

describe('declared decoding vs the manifest', () => {
  test('a declared temperature the evaluator does not send → 409 decoding diff', async () => {
    const r = await declare({ ...DECLARATION, decoding: { ...DECLARATION.decoding, temperature: 0.7 } });
    expect(r.status).toBe(409);
    expect(r.body.diff).toEqual([{ field: 'decoding.temperature', source: 'declaration', value: 0.7, expected: 0,
      manifest_path: 'expected.code.decoding.evaluate.temperature' }]);
    expectNoLock();
  });

  test('an env-tunable value is compared against its default', async () => {
    const r = await declare({ ...DECLARATION, decoding: { ...DECLARATION.decoding, max_tokens: 4096 } });
    expect(r.status).toBe(409);
    expect(r.body.diff).toEqual([expect.objectContaining({ field: 'decoding.max_tokens', value: 4096, expected: 1500 })]);
  });

  test('keys the manifest does not state (top_p, seed) and an omitted decoding are not compared', async () => {
    expect((await declare({ ...DECLARATION, decoding: { temperature: 0, top_p: 0.5, seed: 1 } })).status).toBe(200);
  });

  test('…and a declaration with no decoding at all is consistent too', async () => {
    const { decoding: _d, ...rest } = DECLARATION;
    expect((await declare(rest)).status).toBe(200);
  });
});

describe('the evaluator digest is frozen at declaration', () => {
  test('the row, the response and the audit entry carry evaluator_sha256 from the shared helper', async () => {
    const r = await declare();
    expect(r.status).toBe(200);
    const want = evaluatorDigest(EXPECTED, 'local');
    expect(want).toMatch(/^[0-9a-f]{64}$/);
    expect(db.locks[0].evaluator_sha256).toBe(want);
    expect(r.body.evaluator_sha256).toBe(want);
    expect(lockAudits()[0].metadata.evaluator_sha256).toBe(want);
    // And it is what the GET screen says the lock would freeze.
    db.locks = []; db.settings.evaluator_locked_at = null;
    expect((await getLock()).body.manifest.expected_for_candidate.evaluator_sha256).toBe(want);
  });

  test('an insert that returns a row without its id is unconfirmed too: nothing else written', async () => {
    db.fail.insertRowNoId = true;
    const r = await declare();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('lock_record_unconfirmed');
    expect(db.settings.evaluator_locked_at ?? null).toBeNull();
    expect(lockAudits()).toHaveLength(0);
  });
});

describe('GET /evaluator-lock: what the screen is told', () => {
  test('no candidate at all is `no_candidate`, not `candidate_not_evaluator`', async () => {
    decisiveVerdict.mockResolvedValue({ ...verdict('insufficient', { n: 0 }), candidate: null });
    const r = await getLock();
    expect(r.body.blockers).toContain('no_candidate');
    expect(r.body.blockers).not.toContain('candidate_not_evaluator');
  });

  test('carries the replace-lock phrase, the groups, and the manifest\'s expectations for the candidate', async () => {
    const groups = [
      { provider: 'local', model_version: MV, prompt_version: PV, rows: 60, rubric_versions: [RV], latest: '2026-10-05T00:00:00.000Z' },
      { provider: 'local', model_version: MV, prompt_version: 'pis7-prompt-59561c29+local-aaaaaaaaaaaa', rows: 40, rubric_versions: [RV], latest: null },
    ];
    decisiveVerdict.mockResolvedValue({ ...verdict('pass'), groups });
    fetchRimplManifest.mockResolvedValue(manifestBody({ drift: [{ key: 'declared.local.model', expected: 'qwen-2.5-72b', live: 'SECRET-LIVE-VALUE' }] }));
    const r = await getLock();
    expect(r.status).toBe(200);
    expect(r.body.confirm_phrases).toEqual({ replace_lock: 'REPLACE THE LOCK' });
    expect(r.body.gate.groups).toEqual(groups);
    expect(r.body.manifest.drift_keys).toEqual(['declared.local.model']);
    expect(r.body.manifest.expected_for_candidate).toMatchObject({
      prompt_version: PV, rubric_version: RV, model_version: MV, provider_declared: 'local',
      decoding: EXPECTED.code.decoding.evaluate,
      declared: { engine: 'vllm', model: 'qwen-2.5-72b' },
    });
    // Keys only for drift, and never the server's own fingerprint string.
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/SECRET-LIVE-VALUE/);
    expect(JSON.stringify(r.body.manifest.expected_for_candidate)).not.toMatch(/FP-SENTINEL/);
  });

  test('verdict_unavailable carries a sanitized detail', async () => {
    decisiveVerdict.mockResolvedValue({ ok: false, error: { message: 'relation audit_scores timed out' } });
    const r = await getLock();
    expect(r.status).toBe(200);
    expect(r.body.blockers).toContain('verdict_unavailable');
    expect(r.body.blocker_detail.verdict_unavailable).toBe('relation audit_scores timed out');
    expect(r.body.gate).toBeNull();
  });

  test('lock_table_unreadable carries a sanitized detail; an unmigrated table does not need one', async () => {
    db.fail.schemaProbe = { code: '42501', message: 'permission denied for table evaluator_model_lock' };
    const r = await getLock();
    expect(r.body.blockers).toContain('lock_table_unreadable');
    expect(r.body.blocker_detail.lock_table_unreadable).toMatch(/permission denied/);
    expect(r.body.migrations_pending).toEqual([]);
  });

  test('in production the detail is the generic message, never the database text', () => {
    // IS_PROD is read when lib/db-helpers loads, so production is a fresh module registry.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      jest.isolateModules(() => {
        const { publicDbMessage } = require('../src/lib/db-helpers');
        expect(publicDbMessage({ message: 'relation audit_scores timed out' })).toBe('Internal server error');
        expect(publicDbMessage(null)).toBeNull();
      });
    } finally { process.env.NODE_ENV = prev; }
  });

  test('a read that throws is a bilingual 500 with its own code, not a hung request', async () => {
    decisiveVerdict.mockRejectedValue(new Error('socket hang up'));
    const r = await getLock();
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('lock_read_failed');
    expect(r.body.error).toMatch(/ \/ /);
  });
});

describe('errors a superadmin reads are bilingual (ไทย / English)', () => {
  test('POST 400 is invalid_declaration, with the validation detail kept apart', async () => {
    const r = await declare({ weights_sha256: 'short' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_declaration');
    expect(r.body.error).toMatch(/ \/ /);
    expect(r.body.details.fieldErrors.weights_sha256).toBeDefined();
    expectNoLock();
  });

  test('POST confirmation_required, gate_not_passed, candidate_not_evaluator', async () => {
    await declare();
    const relock = await declare();
    expect(relock.body.code).toBe('confirmation_required');
    expect(relock.body.error).toMatch(/ \/ /);

    db.settings.evaluator_locked_at = null;
    decisiveVerdict.mockResolvedValue(verdict('fail', { why: 'below' }));
    const gate = await declare();
    expect(gate.body.code).toBe('gate_not_passed');
    expect(gate.body.error).toMatch(/ \/ /);

    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, provider: 'local-tutor' }));
    const tutor = await declare();
    expect(tutor.body.code).toBe('candidate_not_evaluator');
    expect(tutor.body.error).toMatch(/ \/ /);
  });

  test('PATCH unlock confirmation_required and evaluator_locked', async () => {
    await declare();
    const unlock = await patch({ evaluator_locked: false });
    expect(unlock.status).toBe(409);
    expect(unlock.body.code).toBe('confirmation_required');
    expect(unlock.body.error).toMatch(/ \/ /);
    const sw = await patch({ purpose: 'evaluate', provider: 'anthropic', confirm: 'CHANGE EVALUATOR' });
    expect(sw.status).toBe(409);
    expect(sw.body.code).toBe('evaluator_locked');
    expect(sw.body.error).toMatch(/ \/ /);
  });
});

describe('GET /admin/ai-providers reads the lock strictly', () => {
  test('an unreadable lock state is 503 lock_state_unreadable, never "unlocked"', async () => {
    db.fail.settingsRead = 'evaluator_locked_at';
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('lock_state_unreadable');
  });

  test('a declared lock is reported with its record and as bound to the evaluator digest', async () => {
    await declare();
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(r.status).toBe(200);
    expect(r.body.evaluator_lock).toEqual({ locked: true, record: 'found', manifest_bound: true });
  });

  test('a flag set by hand has no record behind it, and says so', async () => {
    db.settings.evaluator_locked_at = '2026-10-01T00:00:00.000Z';
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(r.body.evaluator_lock).toEqual({ locked: true, record: 'none', manifest_bound: false });
  });

  test('unlocked: locked false, nothing to bind', async () => {
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(r.body.evaluator_lock).toEqual({ locked: false, record: null, manifest_bound: null });
  });
});

describe('GET /admin/ai-readiness relays the manifest and the lock verdict', () => {
  test('rimpl\'s public manifest block is relayed, and the lock check rides beside it', async () => {
    const pub = { sha256: MSHA, claimed_sha256: MSHA, file: 'present', code_match: true, drift: [] };
    probeRimplDeep.mockResolvedValue({ body: { checks: {}, models: {}, manifest: pub } });
    const r = await auth(request(app).get('/admin/ai-readiness'));
    expect(r.status).toBe(200);
    // Relayed as published, plus the evaluator-scope subset of its drift keys (none here) and for whom.
    expect(r.body.manifest).toEqual({ ...pub, evaluator_provider: 'local', evaluator_drift_keys: [] });
    // Unlocked: up, and no manifest fetch on the lock's account.
    expect(r.body.model_lock).toMatchObject({ status: 'up', locked: false, live_sha256: MSHA });
    expect(fetchRimplManifest).not.toHaveBeenCalled();
  });

  test('locked: the same evaluator check /health/deep runs', async () => {
    await declare();
    fetchRimplManifest.mockClear();
    const r = await auth(request(app).get('/admin/ai-readiness'));
    expect(r.body.model_lock).toMatchObject({ status: 'up', locked: true, match: true,
      evaluator_sha256: evaluatorDigest(EXPECTED, 'local') });
    expect(fetchRimplManifest).toHaveBeenCalledTimes(1);
  });

  test('a re-declaration clears the cached live manifest, so the new lock is never compared to the old build', async () => {
    await declare();
    expect((await auth(request(app).get('/admin/ai-readiness'))).body.model_lock).toMatchObject({ status: 'up' });   // caches build A
    // rimpl is redeployed with a different evaluator (build B), and the lock is replaced on it.
    const expectedB = JSON.parse(JSON.stringify(EXPECTED));
    expectedB.code.evaluator.prompt_version.local = PV;           // the same declared prompt...
    expectedB.code.evaluator.weights = { d1: 0.2 };                // ...but a different evaluator
    fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { sha256: 'b'.repeat(64), expected: expectedB }, sha256: 'b'.repeat(64), claimed_sha256: 'b'.repeat(64) }));
    expect((await declare({ ...DECLARATION, confirm_relock: 'REPLACE THE LOCK' })).status).toBe(200);
    const r = await auth(request(app).get('/admin/ai-readiness'));
    expect(r.body.model_lock).toMatchObject({ status: 'up', match: true, evaluator_sha256: evaluatorDigest(expectedB, 'local') });
  });

  test('an unreachable rimpl still answers, with manifest null', async () => {
    probeRimplDeep.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await auth(request(app).get('/admin/ai-readiness'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reachable: false, manifest: null });
    expect(r.body.model_lock).toMatchObject({ status: 'up', locked: false });
  });
});

// ---- the evaluator digest itself ----------------------------------------------------------------
describe('evaluatorDigest: exactly the scoring instrument', () => {
  const { canonicalJson, evaluatorScope, EVALUATOR_SCOPE_VERSION } = require('../src/services/model-lock');
  const SMALL = { code: { model_version_prefix: 'P+', evaluator: { prompt_version: { local: 'pv' }, rubric_version: 'rv' },
    decoding: { evaluate: { temperature: 0, max_tokens: 10 }, num_ctx: { local: { default: null, env: 'LOCAL_AI_NUM_CTX' } } },
    consistency: { agree: { max_domain_delta: 1 }, evaluate: { mode: { default: 'off', applies_to: 'local' } }, method: 'self-consistency',
      modes: ['off', 'adaptive', 'median3'], rules: { pair: 'first-of-agreeing-pair' }, shadow: { json_retries: 0 } },
    anthropic: { model: 'claude-x' } },
  declared: { providers: { evaluate: 'local' }, local: { model: 'm', engine: 'vllm' } } };
  const CONSISTENCY = 'code.consistency (minus shadow, as it governs this provider)';
  const clone = (x) => JSON.parse(JSON.stringify(x));

  test('pinned values: changing one invalidates every lock in force, so it must come with a new scope tag', () => {
    // Recomputed independently when pinned: the scope built BY HAND in Python from the documented rules,
    // then json.dumps(sort_keys=True, separators=(',', ':')) and sha256. v3: num_ctx for an on-prem
    // provider; consistency as it governs the provider. For local, the whole block minus shadow plus
    // num_ctx.local; for anthropic, only consistency.evaluate.mode.{applies_to, default}, and no num_ctx.
    expect(EVALUATOR_SCOPE_VERSION).toBe('clics-evaluator-scope/v3');
    expect(evaluatorDigest(SMALL, 'local')).toBe('5a88fe4a1322142efe1bc43cedbe6679ac452aaa282bd687e048c941a46276d3');
    expect(evaluatorDigest(SMALL, 'anthropic')).toBe('4f4b9db761393adeade956750229f8f4bf7724f31a59b674d81ec0801d8d0d8f');
  });

  test('object key order does not matter; array order does', () => {
    const reordered = { declared: { local: { engine: 'vllm', model: 'm' }, providers: { evaluate: 'local' } },
      code: { anthropic: { model: 'claude-x' }, decoding: { num_ctx: { local: { env: 'LOCAL_AI_NUM_CTX', default: null } }, evaluate: { max_tokens: 10, temperature: 0 } },
        evaluator: { rubric_version: 'rv', prompt_version: { local: 'pv' } }, model_version_prefix: 'P+',
        consistency: { shadow: { json_retries: 0 }, rules: { pair: 'first-of-agreeing-pair' }, modes: ['off', 'adaptive', 'median3'],
          method: 'self-consistency', evaluate: { mode: { applies_to: 'local', default: 'off' } }, agree: { max_domain_delta: 1 } } } };
    expect(evaluatorDigest(reordered, 'local')).toBe(evaluatorDigest(SMALL, 'local'));
    expect(evaluatorDigest(reordered, 'anthropic')).toBe(evaluatorDigest(SMALL, 'anthropic'));
    const a = clone(EXPECTED); const b = clone(EXPECTED);
    b.code.providers.allowed.evaluate = [...a.code.providers.allowed.evaluate].reverse();
    expect(evaluatorDigest(b, 'local')).not.toBe(evaluatorDigest(a, 'local'));
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });

  test('the scope is exactly the documented key list', () => {
    expect(Object.keys(evaluatorScope(EXPECTED, 'local')).sort()).toEqual([
      CONSISTENCY, 'code.decoding.evaluate', 'code.decoding.num_ctx.local', 'code.evaluator', 'code.model_version_prefix',
      'code.providers.allowed.evaluate', 'declared.local', 'declared.providers.evaluate',
    ]);
    expect(Object.keys(evaluatorScope(EXPECTED, 'anthropic')).sort()).toEqual([
      'code.anthropic', CONSISTENCY, 'code.decoding.evaluate', 'code.evaluator',
      'code.model_version_prefix', 'code.providers.allowed.evaluate', 'declared.anthropic', 'declared.providers.evaluate',
    ]);
    // For the provider it governs, every consistency key but `shadow` is in.
    expect(Object.keys(evaluatorScope(SMALL, 'local')[CONSISTENCY]).sort())
      .toEqual(['agree', 'evaluate', 'method', 'modes', 'rules']);
  });

  test('outside the scope: router, prompts, thinking, other decoding, another provider\'s declared block', () => {
    const base = evaluatorDigest(EXPECTED, 'local');
    const e = clone(EXPECTED);
    e.code.router = { fast: 'local-tutor' };
    e.code.prompts = { chat: 'x' };
    e.code.thinking = { chat: 'on' };
    e.code.decoding.chat = { temperature: 0.9 };
    e.code.consistency.shadow = { json_retries: 0, mode: { default: 'median3' } };
    e.declared['local-tutor'] = { model: 'qwen-tutor' };
    e.declared.providers.chat = 'local-tutor';
    expect(evaluatorDigest(e, 'local')).toBe(base);
  });

  test.each([
    ['agree.max_domain_delta', (c) => { c.agree.max_domain_delta = 2; }],
    ['agree.max_sum_delta', (c) => { c.agree.max_sum_delta = 3; }],
    ['method', (c) => { c.method = 'majority'; }],
    ['modes', (c) => { c.modes = ['off', 'median3']; }],
    ['rules', (c) => { c.rules.pair = 'mean-of-agreeing-pair'; }],
    ['evaluate.mode', (c) => { c.evaluate.mode.default = 'adaptive'; }],
  ])('consistency.%s is part of the instrument', (_k, mutate) => {
    const e = clone(SMALL);
    mutate(e.code.consistency);
    expect(evaluatorDigest(e, 'local')).not.toBe(evaluatorDigest(SMALL, 'local'));
  });

  test('consistency.shadow is not: the shadow evaluator never scores a PLE', () => {
    const e = clone(SMALL);
    e.code.consistency.shadow = { json_retries: 3, mode: { default: 'median3', env: 'SHADOW_EVAL_CONSISTENCY' } };
    expect(evaluatorDigest(e, 'local')).toBe(evaluatorDigest(SMALL, 'local'));
    delete e.code.consistency.shadow;
    expect(evaluatorDigest(e, 'local')).toBe(evaluatorDigest(SMALL, 'local'));
  });

  test('code.anthropic counts only for an anthropic lock', () => {
    const e = clone(EXPECTED);
    e.code.anthropic.model_version = 'CCME_LLM_v8.0+claude-sonnet-5';
    expect(evaluatorDigest(e, 'local')).toBe(evaluatorDigest(EXPECTED, 'local'));
    expect(evaluatorDigest(e, 'anthropic')).not.toBe(evaluatorDigest(EXPECTED, 'anthropic'));
  });

  test('the provider is part of the digest', () => {
    expect(evaluatorDigest(EXPECTED, 'local')).not.toBe(evaluatorDigest(EXPECTED, 'anthropic'));
  });

  // v3: num_ctx is sent by the on-prem transport only, and decides how much of the transcript it sees.
  test('num_ctx: the evaluate provider\'s entry counts for a local lock; the tutor\'s does not; anthropic has none', () => {
    const e = clone(SMALL);
    e.code.decoding.num_ctx.local.default = 32768;
    expect(evaluatorDigest(e, 'local')).not.toBe(evaluatorDigest(SMALL, 'local'));
    expect(evaluatorDigest(e, 'anthropic')).toBe(evaluatorDigest(SMALL, 'anthropic'));
    const t = clone(SMALL);
    t.code.decoding.num_ctx['local-tutor'] = { default: 8192, env: 'LOCAL_TUTOR_AI_NUM_CTX' };
    expect(evaluatorDigest(t, 'local')).toBe(evaluatorDigest(SMALL, 'local'));
    expect(evaluatorScope(SMALL, 'anthropic')).not.toHaveProperty('code.decoding.num_ctx.anthropic');
    // A local provider whose entry the manifest does not state is still in scope, as null.
    const none = clone(SMALL);
    delete none.code.decoding.num_ctx;
    expect(evaluatorScope(none, 'local')['code.decoding.num_ctx.local']).toBeNull();
  });

  // v3: consistency only as it governs the provider (rimpl's consistencyModeFor rule).
  describe('consistency as it governs the provider', () => {
    test.each([
      ['agree.max_domain_delta', (c) => { c.agree.max_domain_delta = 2; }],
      ['agree.max_sum_delta', (c) => { c.agree.max_sum_delta = 3; }],
      ['method', (c) => { c.method = 'majority'; }],
      ['modes', (c) => { c.modes = ['off', 'median3']; }],
      ['rules', (c) => { c.rules.pair = 'mean-of-agreeing-pair'; }],
      ['evaluate.json_retries', (c) => { c.evaluate.json_retries = { default: 5 }; }],
    ])('%s: moves a local lock, not an anthropic one', (_k, mutate) => {
      const e = clone(SMALL);
      mutate(e.code.consistency);
      expect(evaluatorDigest(e, 'local')).not.toBe(evaluatorDigest(SMALL, 'local'));
      expect(evaluatorDigest(e, 'anthropic')).toBe(evaluatorDigest(SMALL, 'anthropic'));
    });

    test('anthropic keeps exactly what keeps the rule off its scores: applies_to and the default mode', () => {
      expect(evaluatorScope(SMALL, 'anthropic')[CONSISTENCY]).toEqual({ evaluate: { mode: { applies_to: 'local', default: 'off' } } });
      for (const mutate of [(m) => { m.default = 'adaptive'; }, (m) => { m.applies_to = 'anthropic'; }]) {
        const e = clone(SMALL);
        mutate(e.code.consistency.evaluate.mode);
        expect(evaluatorDigest(e, 'anthropic')).not.toBe(evaluatorDigest(SMALL, 'anthropic'));
      }
    });

    test('a default mode that is not off governs every provider, so anthropic then carries the whole block', () => {
      const { consistencyGoverns } = require('../src/services/model-lock');
      const e = clone(SMALL);
      e.code.consistency.evaluate.mode.default = 'median3';
      expect(consistencyGoverns(e.code.consistency, 'anthropic')).toBe(true);
      expect(Object.keys(evaluatorScope(e, 'anthropic')[CONSISTENCY]).sort()).toEqual(['agree', 'evaluate', 'method', 'modes', 'rules']);
    });

    test('a manifest that does not name applies_to keeps the whole block in scope for everyone (fails closed)', () => {
      const { consistencyGoverns } = require('../src/services/model-lock');
      const e = clone(SMALL);
      delete e.code.consistency.evaluate.mode.applies_to;
      expect(consistencyGoverns(e.code.consistency, 'anthropic')).toBe(true);
      expect(consistencyGoverns(undefined, 'anthropic')).toBe(true);
      expect(consistencyGoverns(SMALL.code.consistency, 'anthropic')).toBe(false);
      expect(consistencyGoverns(SMALL.code.consistency, 'local')).toBe(true);
    });
  });
});

// ---- live drift on an evaluator key ---------------------------------------------------------------
// The digest covers the manifest's EXPECTED half (code defaults + declared values), so an env override
// (EVAL_CONSISTENCY, LOCAL_AI_MODEL, ...) leaves it unchanged while rimpl runs a different instrument.
// rimpl reports that as GET /manifest `drift[]` with RAW values. The lock reads the keys on the
// evaluator's scope (services/model-lock.js evaluatorDriftKeys) and never relays a value.
const LOCAL_EVALUATOR_DRIFT = [
  'code.decoding.evaluate.temperature', 'code.decoding.evaluate.max_tokens', 'code.decoding.num_ctx.local',
  'code.consistency.evaluate_mode', 'code.consistency.max_sum_delta', 'code.consistency.json_retries',
  'declared.providers.evaluate',
  'declared.local.model', 'declared.local.served_model', 'declared.local.engine', 'declared.local.system_fingerprint',
];
// The consistency keys, in scope only while the rule governs the provider (applies_to 'local').
const CONSISTENCY_DRIFT = ['code.consistency.evaluate_mode', 'code.consistency.max_sum_delta', 'code.consistency.json_retries'];
// Outside the evaluator's scope for a local lock, as they are outside the digest.
const NOT_EVALUATOR_DRIFT = [
  ['tutor', 'declared.local-tutor.model'], ['tutor', 'declared.local-tutor.served_model'],
  ['tutor', 'declared.local-tutor.engine'], ['tutor', 'declared.local-tutor.system_fingerprint'],
  ['tutor', 'code.thinking_style.local-tutor'], ['tutor', 'code.decoding.num_ctx.local-tutor'],
  ['chat', 'code.decoding.chat.temperature'], ['chat', 'code.decoding.chat.fast_max_tokens'],
  ['chat', 'code.decoding.chat.deep_max_tokens'], ['chat', 'code.decoding.chat.evidence_line_max_tokens'],
  ['chat', 'declared.providers.chat'],
  ['discuss', 'code.decoding.discuss.max_tokens'], ['discuss', 'declared.providers.discuss'],
  ['criteria', 'code.decoding.criteria.max_tokens'], ['criteria', 'declared.providers.criteria'],
  ['shadow', 'code.decoding.shadow.max_tokens'], ['shadow', 'code.consistency.shadow_mode'],
  // The evaluator instance's thinking style is sent on chat turns only, never on evaluate.
  ['chat-only', 'code.thinking_style.local'],
  ['another provider', 'code.models.anthropic'],
];
const EXP_VALUE = 'EXPECTED-VALUE-SENTINEL-7f3a';
const LIVE_VALUE = 'LIVE-VALUE-SENTINEL-9c1e';
const driftOn = (...keys) => keys.map((key) => ({ key, expected: EXP_VALUE, live: LIVE_VALUE }));
const noDriftValues = (body) => {
  const text = JSON.stringify(body);
  expect(text).not.toContain(LIVE_VALUE);
  expect(text).not.toContain(EXP_VALUE);
};

describe('live drift on an evaluator key blocks a lock', () => {
  const withDrift = (...keys) => fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn(...keys) }));

  test.each(LOCAL_EVALUATOR_DRIFT)('%s → GET blocker with the key, POST 409, nothing frozen', async (key) => {
    withDrift(key);
    const g = await getLock();
    expect(g.status).toBe(200);
    expect(g.body.can_declare).toBe(false);
    expect(g.body.blockers).toEqual(['evaluator_live_drift']);
    expect(g.body.blocker_detail.evaluator_live_drift).toEqual([key]);
    noDriftValues(g.body);

    const p = await declare();
    expect(p.status).toBe(409);
    expect(p.body).toEqual({ error: expect.any(String), code: 'evaluator_live_drift', keys: [key], provider: 'local' });
    expect(p.body.error).toMatch(/ \/ The live RIMPL configuration differs from the model manifest on 1 evaluator key/);   // bilingual
    expect(p.body.error).toContain(key);
    noDriftValues(p.body);
    expectNoLock();
    expect(lockAudits()).toHaveLength(0);
  });

  test.each(NOT_EVALUATOR_DRIFT)('%s drift (%s) → no blocker, and the lock goes through', async (_area, key) => {
    withDrift(key);
    const g = await getLock();
    expect(g.body.blockers).toEqual([]);
    expect(g.body.blocker_detail).not.toHaveProperty('evaluator_live_drift');
    expect(g.body.manifest.drift_keys).toEqual([key]);   // still reported, by key, as before
    const p = await declare();
    expect(p.status).toBe(200);
    noDriftValues(p.body);
    noDriftValues(db.locks[0]);
    noDriftValues(lockAudits()[0]);
  });

  test('a mix: only the evaluator keys block, in rimpl\'s order', async () => {
    withDrift('code.decoding.chat.temperature', 'declared.local.model', 'code.consistency.shadow_mode', 'code.consistency.evaluate_mode');
    const g = await getLock();
    expect(g.body.blocker_detail.evaluator_live_drift).toEqual(['declared.local.model', 'code.consistency.evaluate_mode']);
    const p = await declare();
    expect(p.status).toBe(409);
    expect(p.body.keys).toEqual(['declared.local.model', 'code.consistency.evaluate_mode']);
    expect(p.body.error).toMatch(/on 2 evaluator key\(s\)/);
  });

  // FAILS CLOSED: a key no rule classifies (a knob rimpl adds later) is on the instrument until it is.
  test.each([
    'code.think_preopened.local', 'code.evaluator.prompt_override', 'code.router.version', 'declared.local',
  ])('an UNKNOWN key (%s) blocks: GET blocker, POST 409', async (key) => {
    withDrift(key, 'code.decoding.chat.temperature');
    const g = await getLock();
    expect(g.body.blockers).toEqual(['evaluator_live_drift']);
    expect(g.body.blocker_detail.evaluator_live_drift).toEqual([key]);
    const p = await declare();
    expect(p.status).toBe(409);
    expect(p.body).toMatchObject({ code: 'evaluator_live_drift', keys: [key] });
    expectNoLock();
  });

  test('a malformed key blocks too, reported as a placeholder, never as the string it carried', async () => {
    const SMUGGLED = 'declared.local.model=qwen-SECRET-72b';
    fetchRimplManifest.mockResolvedValue(manifestBody({ drift: [
      { key: SMUGGLED, expected: EXP_VALUE, live: LIVE_VALUE }, { expected: EXP_VALUE, live: LIVE_VALUE }, { key: 42 },
    ] }));
    const g = await getLock();
    expect(g.body.blocker_detail.evaluator_live_drift).toEqual(['(malformed drift key)']);
    expect(g.body.manifest.drift_keys).toEqual(['(malformed drift key)', '(malformed drift key)', '(malformed drift key)']);
    const p = await declare();
    expect(p.status).toBe(409);
    expect(p.body.keys).toEqual(['(malformed drift key)']);
    for (const body of [g.body, p.body]) {
      expect(JSON.stringify(body)).not.toContain('SECRET');
      noDriftValues(body);
    }
    expectNoLock();
  });

  test('an anthropic candidate is blocked by an unknown key as well', async () => {
    db.settings.ai_provider_evaluate = 'anthropic';
    const expected = { ...EXPECTED, declared: { ...EXPECTED.declared, providers: { evaluate: 'anthropic' } } };
    fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { sha256: MSHA, expected }, drift: driftOn('code.evaluator.prompt_override') }));
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, {
      provider: 'anthropic', model_version: 'CCME_LLM_v8.0+claude-sonnet-4-6', prompt_version: 'pis7-prompt-59561c29', rubric_versions: [RV],
    }));
    const p = await declare({ ...DECLARATION, evaluator_prompt_version: 'pis7-prompt-59561c29' });
    expect(p.status).toBe(409);
    expect(p.body).toMatchObject({ code: 'evaluator_live_drift', keys: ['code.evaluator.prompt_override'], provider: 'anthropic' });
  });

  test('both reasons at once are both on the screen; POST answers the manifest mismatch first', async () => {
    const OLD = 'pis7-prompt-59561c29+local-aaaaaaaaaaaa';
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, prompt_version: OLD }));
    withDrift('code.consistency.json_retries');
    expect((await getLock()).body.blockers).toEqual(['manifest_mismatch', 'evaluator_live_drift']);
    expect((await declare({ ...DECLARATION, evaluator_prompt_version: OLD })).body.code).toBe('manifest_mismatch');
  });

  test('a tutor candidate gets candidate_not_evaluator, not a drift blocker for its own block', async () => {
    decisiveVerdict.mockResolvedValue(verdict('pass', {}, { ...CANDIDATE, provider: 'local-tutor' }));
    withDrift('declared.local-tutor.model');
    const g = await getLock();
    expect(g.body.blockers).toContain('candidate_not_evaluator');
    expect(g.body.blockers).not.toContain('evaluator_live_drift');
  });

  describe('an anthropic candidate', () => {
    const expected = { ...EXPECTED, declared: { ...EXPECTED.declared, providers: { evaluate: 'anthropic' } } };
    const anthropic = (...keys) => {
      db.settings.ai_provider_evaluate = 'anthropic';
      fetchRimplManifest.mockResolvedValue(manifestBody({ manifest: { sha256: MSHA, expected }, drift: driftOn(...keys) }));
      decisiveVerdict.mockResolvedValue(verdict('pass', {}, {
        provider: 'anthropic', model_version: 'CCME_LLM_v8.0+claude-sonnet-4-6', prompt_version: 'pis7-prompt-59561c29', rubric_versions: [RV],
      }));
    };
    const declareAnthropic = () => declare({ ...DECLARATION, evaluator_prompt_version: 'pis7-prompt-59561c29' });

    test('the pinned Claude model drifting blocks it', async () => {
      anthropic('code.models.anthropic');
      expect((await getLock()).body.blocker_detail.evaluator_live_drift).toEqual(['code.models.anthropic']);
      const p = await declareAnthropic();
      expect(p.status).toBe(409);
      expect(p.body).toMatchObject({ code: 'evaluator_live_drift', keys: ['code.models.anthropic'], provider: 'anthropic' });
      noDriftValues(p.body);
      expectNoLock();
    });

    test('the local evaluator\'s declared block drifting does not', async () => {
      anthropic('declared.local.model', 'declared.local.engine', 'declared.local.system_fingerprint');
      expect((await getLock()).body.blockers).toEqual([]);
      expect((await declareAnthropic()).status).toBe(200);
    });

    test('the evaluate-scope keys still do', async () => {
      anthropic('declared.providers.evaluate', 'code.decoding.evaluate.max_tokens');
      expect((await declareAnthropic()).body.keys).toEqual(['declared.providers.evaluate', 'code.decoding.evaluate.max_tokens']);
    });

    test('consistency overrides (EVAL_CONSISTENCY and siblings) do not: the rule applies to the local arm', async () => {
      anthropic(...CONSISTENCY_DRIFT);
      const g = await getLock();
      expect(g.body.blockers).toEqual([]);
      expect(g.body.manifest.evaluator_drift_keys).toEqual([]);
      expect((await declareAnthropic()).status).toBe(200);
    });

    test('the local evaluator\'s num_ctx does not: the Anthropic transport sends none', async () => {
      anthropic('code.decoding.num_ctx.local');
      expect((await getLock()).body.blockers).toEqual([]);
      expect((await declareAnthropic()).status).toBe(200);
    });
  });

  test('a local lock IS blocked by consistency overrides and by its own num_ctx', async () => {
    withDrift(...CONSISTENCY_DRIFT, 'code.decoding.num_ctx.local');
    const p = await declare();
    expect(p.status).toBe(409);
    expect(p.body.keys).toEqual([...CONSISTENCY_DRIFT, 'code.decoding.num_ctx.local']);
  });

  test('locked, then an override appears: /admin/ai-readiness model_lock degrades with the keys only', async () => {
    expect((await declare()).status).toBe(200);
    fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn('code.consistency.evaluate_mode', 'code.decoding.chat.temperature') }));
    const r = await auth(request(app).get('/admin/ai-readiness'));
    expect(r.status).toBe(200);
    expect(r.body.model_lock).toMatchObject({ status: 'down', locked: true, match: true, reason: 'evaluator_live_drift',
      drift_keys: ['code.consistency.evaluate_mode'] });
    noDriftValues(r.body);
  });

  test('locked, and only a tutor override: /admin/ai-readiness stays up', async () => {
    expect((await declare()).status).toBe(200);
    fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn('declared.local-tutor.model') }));
    const r = await auth(request(app).get('/admin/ai-readiness'));
    expect(r.body.model_lock).toMatchObject({ status: 'up', match: true });
    expect(r.body.model_lock).not.toHaveProperty('drift_keys');
    expect(r.body.model_lock).not.toHaveProperty('reason');
  });
});

// ---- the filter's result, exposed so the dashboard never re-implements it ----------------------------
describe('manifest.evaluator_drift_keys / evaluator_provider', () => {
  const MIX = ['code.decoding.chat.temperature', 'declared.local.model', 'code.consistency.evaluate_mode',
    'code.decoding.num_ctx.local', 'code.models.anthropic', 'declared.local-tutor.model', 'code.consistency.shadow_mode'];
  const FOR_LOCAL = ['declared.local.model', 'code.consistency.evaluate_mode', 'code.decoding.num_ctx.local'];
  const FOR_ANTHROPIC = ['code.models.anthropic'];
  const noCandidate = () => decisiveVerdict.mockResolvedValue({ ...verdict('insufficient', { n: 0 }), candidate: null });

  describe('GET /admin/evaluator-lock', () => {
    test('always present on a verified manifest: [] when nothing on the evaluator\'s scope drifts', async () => {
      fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn('code.decoding.chat.temperature') }));
      const r = await getLock();
      expect(r.body.manifest).toMatchObject({ evaluator_drift_keys: [], evaluator_provider: 'local' });
    });

    test('for the candidate: the same list as the blocker, keys only', async () => {
      fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn(...MIX) }));
      const r = await getLock();
      expect(r.body.manifest.evaluator_provider).toBe('local');
      expect(r.body.manifest.evaluator_drift_keys).toEqual(FOR_LOCAL);
      expect(r.body.blocker_detail.evaluator_live_drift).toEqual(FOR_LOCAL);
      noDriftValues(r.body);
    });

    test('no candidate: computed for the provider serving evaluate (local), and nothing extra blocks', async () => {
      noCandidate();
      fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn(...MIX) }));
      const r = await getLock();
      expect(r.body.manifest).toMatchObject({ evaluator_provider: 'local', evaluator_drift_keys: FOR_LOCAL });
      expect(r.body.blockers).not.toContain('evaluator_live_drift');
      noDriftValues(r.body);
    });

    test('no candidate, anthropic serving: v3 rules (no consistency, no num_ctx, no declared.local.*)', async () => {
      noCandidate();
      db.settings.ai_provider_evaluate = 'anthropic';
      fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn(...MIX, 'declared.providers.evaluate') }));
      const r = await getLock();
      expect(r.body.manifest).toMatchObject({ evaluator_provider: 'anthropic',
        evaluator_drift_keys: [...FOR_ANTHROPIC, 'declared.providers.evaluate'] });
      noDriftValues(r.body);
    });

    test('an unverified manifest has no drift to filter, so neither field', async () => {
      fetchRimplManifest.mockResolvedValue(manifestBody({ code_match: false, drift: driftOn(...MIX) }));
      const r = await getLock();
      expect(r.body.manifest.ok).toBe(false);
      expect(r.body.manifest).not.toHaveProperty('evaluator_drift_keys');
      noDriftValues(r.body);
    });
  });

  // ai-readiness relays rimpl's PUBLIC /health/deep manifest block: the same drift keys as GET /manifest,
  // with free-text live values replaced by a short hash (rimpl lib/manifest.js publicDrift).
  describe('GET /admin/ai-readiness', () => {
    const publicEntry = (key) => (key.startsWith('code.consistency.')
      ? { key, expected: 'off', live: 'adaptive' }                                    // a fixed vocabulary: shown raw
      : { key, expected: 'PUBLIC-EXPECTED', live_present: true, live_sha256_12: 'abcdefabcdef' });
    const publicBlock = (keys) => ({ sha256: MSHA, claimed_sha256: MSHA, file: 'present', code_match: true, drift: keys.map(publicEntry) });
    const readiness = (keys) => {
      probeRimplDeep.mockResolvedValue({ body: { checks: {}, models: {}, manifest: publicBlock(keys) } });
      // GET /manifest carries RAW values; only its expected half may be used, never a value relayed.
      fetchRimplManifest.mockResolvedValue(manifestBody({ drift: driftOn(...keys) }));
      return auth(request(app).get('/admin/ai-readiness'));
    };

    test('local serving: the v3 filter over the public block\'s keys; the block itself is relayed unchanged', async () => {
      const r = await readiness(MIX);
      expect(r.status).toBe(200);
      expect(r.body.manifest).toEqual({ ...publicBlock(MIX), evaluator_provider: 'local', evaluator_drift_keys: FOR_LOCAL });
      noDriftValues(r.body);
    });

    test('anthropic serving: consistency, num_ctx and declared.local.* are off its scope', async () => {
      db.settings.ai_provider_evaluate = 'anthropic';
      const r = await readiness(MIX);
      expect(r.body.manifest).toMatchObject({ evaluator_provider: 'anthropic', evaluator_drift_keys: FOR_ANTHROPIC });
      noDriftValues(r.body);
    });

    test('a consistency key needs the expected half: GET /manifest is read once, through the 60 s cache', async () => {
      await readiness(MIX);
      await readiness(MIX);
      expect(fetchRimplManifest).toHaveBeenCalledTimes(1);
    });

    test('no consistency key: no GET /manifest at all', async () => {
      const r = await readiness(['declared.local.model', 'code.decoding.chat.temperature']);
      expect(r.body.manifest.evaluator_drift_keys).toEqual(['declared.local.model']);
      expect(fetchRimplManifest).not.toHaveBeenCalled();
    });

    test('GET /manifest unreadable: the consistency keys stay in, even for anthropic (fails closed)', async () => {
      db.settings.ai_provider_evaluate = 'anthropic';
      probeRimplDeep.mockResolvedValue({ body: { checks: {}, models: {}, manifest: publicBlock(MIX) } });
      fetchRimplManifest.mockRejectedValue(new Error('ECONNREFUSED'));
      const r = await auth(request(app).get('/admin/ai-readiness'));
      expect(r.body.manifest.evaluator_drift_keys).toEqual(['code.consistency.evaluate_mode', 'code.models.anthropic']);
    });

    test('locked: computed for the LOCKED provider, whatever the serving setting says', async () => {
      expect((await declare()).status).toBe(200);
      db.settings.ai_provider_evaluate = 'anthropic';   // set behind the switch's back
      const r = await readiness(MIX);
      expect(r.body.manifest).toMatchObject({ evaluator_provider: 'local', evaluator_drift_keys: FOR_LOCAL });
      expect(r.body.model_lock).toMatchObject({ locked: true, reason: 'evaluator_live_drift', drift_keys: FOR_LOCAL });
      noDriftValues(r.body);
    });

    test('no provider known (unlocked, serving setting unreadable): both fields null', async () => {
      db.fail.settingsRead = 'ai_provider_evaluate';
      const r = await readiness(MIX);
      expect(r.body.manifest).toMatchObject({ evaluator_provider: null, evaluator_drift_keys: null });
    });

    test('rimpl unreachable: manifest null, as before', async () => {
      probeRimplDeep.mockRejectedValue(new Error('ECONNREFUSED'));
      const r = await auth(request(app).get('/admin/ai-readiness'));
      expect(r.body).toMatchObject({ reachable: false, manifest: null });
    });
  });
});

// ---- the filter itself, pinned to the key strings rimpl emits ---------------------------------------
// Read from rimpl/src/lib/manifest.js (codeComparisons + driftOf) as TEXT, the way tests/rubric-sync.test.js
// reads rimpl/src/lib/prompts.js, and cross-checked by running rimpl's own driftOf (package-free, like
// lib/decoding.js in tests/provenance.test.js). A key rimpl adds or renames fails here until it is
// classified in or out of the evaluator's scope.
describe('evaluatorDriftKeys: pinned to rimpl/src/lib/manifest.js', () => {
  const fs = require('fs');
  const path = require('path');
  const { isEvaluatorDriftKey, evaluatorDriftKeys } = require('../src/services/model-lock');
  const SRC = fs.readFileSync(path.join(__dirname, '../../rimpl/src/lib/manifest.js'), 'utf8');
  // The names rimpl's drift keys are templated over (package-free: provider-policy.js requires nothing).
  const { PURPOSES, LOCAL_INSTANCES } = require('../../rimpl/src/lib/provider-policy');
  const INSTANCES = Object.keys(LOCAL_INSTANCES);
  const sorted = (a) => [...a].sort();

  function slice(from, to) {
    const a = SRC.indexOf(from);
    const b = SRC.indexOf(to, a + from.length);
    if (a < 0 || b < 0) throw new Error(`rimpl/src/lib/manifest.js no longer contains ${JSON.stringify(a < 0 ? from : to)}`);
    return SRC.slice(a, b);
  }
  // `${name}` ranges over the on-prem instances, `${purpose}` over the purposes; anything else is unknown.
  function expand(template) {
    const out = template.includes('${name}') ? INSTANCES.map((n) => template.replace('${name}', n))
      : template.includes('${purpose}') ? PURPOSES.map((p) => template.replace('${purpose}', p)) : [template];
    for (const k of out) if (k.includes('${')) throw new Error(`unexpanded placeholder in drift key template ${template}`);
    return out;
  }
  function keysFromSource() {
    const comparisons = slice('function codeComparisons(', '\nfunction driftOf(');
    const drift = slice('function driftOf(', '\n}\n');
    // driftOf prefixes every code comparison with `code.`, and pushes the declared keys as templates.
    expect(drift).toContain('push(`code.${key}`');
    const code = [
      ...[...comparisons.matchAll(/\['([a-z_.]+)',/g)].map((m) => [m[1]]),
      ...[...comparisons.matchAll(/out\.push\(\[`([^`]+)`/g)].map((m) => expand(m[1])),
    ].flat().map((k) => `code.${k}`);
    const declared = [...drift.matchAll(/push\(`(declared\.[^`]+)`/g)].flatMap((m) => expand(m[1]));
    return [...code, ...declared];
  }

  // Every drift key rimpl can emit, at eb2af4e5 (#156).
  const ALL_KEYS = [
    'code.decoding.evaluate.temperature', 'code.decoding.evaluate.max_tokens',
    'code.decoding.shadow.temperature', 'code.decoding.shadow.max_tokens',
    'code.decoding.criteria.temperature', 'code.decoding.criteria.max_tokens',
    'code.decoding.discuss.temperature', 'code.decoding.discuss.max_tokens',
    'code.decoding.chat.temperature', 'code.decoding.chat.fast_max_tokens', 'code.decoding.chat.deep_max_tokens',
    'code.decoding.chat.evidence_line_max_tokens',
    'code.consistency.evaluate_mode', 'code.consistency.max_sum_delta', 'code.consistency.json_retries', 'code.consistency.shadow_mode',
    'code.models.anthropic',
    'code.decoding.num_ctx.local', 'code.decoding.num_ctx.local-tutor', 'code.thinking_style.local', 'code.thinking_style.local-tutor',
    'declared.providers.chat', 'declared.providers.evaluate', 'declared.providers.criteria', 'declared.providers.discuss',
    'declared.local.model', 'declared.local.served_model', 'declared.local.engine', 'declared.local.system_fingerprint',
    'declared.local-tutor.model', 'declared.local-tutor.served_model', 'declared.local-tutor.engine', 'declared.local-tutor.system_fingerprint',
  ];
  const ANTHROPIC_EVALUATOR_DRIFT = [
    'code.decoding.evaluate.temperature', 'code.decoding.evaluate.max_tokens',
    'code.models.anthropic', 'declared.providers.evaluate',
  ];
  // The expected half rimpl's code generates today (consistency applies_to 'local', default 'off'): what
  // the v3 consistency rule reads.
  const M = require('../../rimpl/src/lib/manifest');
  const REAL = { code: M.expectedCode(), declared: M.readDeclared() };

  test('the source names exactly these keys — a new or renamed one must be classified first', () => {
    expect(sorted(keysFromSource())).toEqual(sorted(ALL_KEYS));
  });

  test('…and rimpl\'s own driftOf emits exactly them when every value differs', () => {
    // Every leaf of the code half becomes a value no live view holds, so every comparison runs.
    const leaves = (v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, leaves(x)])) : 'EXPECTED');
    const declared = {
      providers: Object.fromEntries(PURPOSES.map((p) => [p, 'EXPECTED'])),
      ...Object.fromEntries(INSTANCES.map((n) => [n, { model: 'EXPECTED', engine: 'EXPECTED', system_fingerprint: 'EXPECTED' }])),
    };
    // Nothing live is set, except a server that has answered once per instance (the last_seen shape of
    // rimpl/src/services/manifest.js liveSnapshot), so the served-model / engine / fingerprint checks run.
    const live = { last_seen: Object.fromEntries(INSTANCES.map((n) => [n, { model: 'LIVE' }])) };
    const emitted = M.driftOf({ expected: { code: leaves(M.expectedCode()), declared } }, live).map((d) => d.key);
    expect(sorted(emitted)).toEqual(sorted(ALL_KEYS));
  });

  test('a local lock\'s scope (v3): evaluate decoding, its num_ctx, consistency minus shadow, the evaluate route, declared.local.*', () => {
    expect(REAL.code.consistency.evaluate.mode).toMatchObject({ applies_to: 'local', default: 'off' });
    expect(sorted(evaluatorDriftKeys(ALL_KEYS, 'local', REAL))).toEqual(sorted(LOCAL_EVALUATOR_DRIFT));
  });

  test('an anthropic lock\'s scope (v3): evaluate decoding, the evaluate route and the pinned Claude model only', () => {
    expect(sorted(evaluatorDriftKeys(ALL_KEYS, 'anthropic', REAL))).toEqual(sorted(ANTHROPIC_EVALUATOR_DRIFT));
  });

  test('without the expected half, the consistency keys stay in for anthropic too (fails closed)', () => {
    expect(sorted(evaluatorDriftKeys(ALL_KEYS, 'anthropic'))).toEqual(sorted([...ANTHROPIC_EVALUATOR_DRIFT, ...CONSISTENCY_DRIFT]));
    expect(sorted(evaluatorDriftKeys(ALL_KEYS, 'local'))).toEqual(sorted(LOCAL_EVALUATOR_DRIFT));
  });

  test('rimpl\'s PUBLIC drift (/health/deep) keeps every key verbatim, so the filter gives the same answer on it', () => {
    // The raw drift of every key, with free-text sentinel values the public form must hash.
    const raw = ALL_KEYS.map((key) => ({ key, expected: 'EXPECTED', live: 'qwen-SENTINEL-live-id' }));
    const pub = M.publicDrift(raw);
    expect(pub.map((d) => d.key)).toEqual(ALL_KEYS);
    expect(JSON.stringify(pub)).not.toContain('qwen-SENTINEL-live-id');
    for (const provider of ['local', 'anthropic']) {
      expect(evaluatorDriftKeys(pub.map((d) => d.key), provider, REAL)).toEqual(evaluatorDriftKeys(ALL_KEYS, provider, REAL));
    }
  });

  test('every NOT_EVALUATOR_DRIFT key above is a real key, and OUT for a local lock', () => {
    for (const [, key] of NOT_EVALUATOR_DRIFT) {
      expect(ALL_KEYS).toContain(key);
      expect(isEvaluatorDriftKey(key, 'local', REAL)).toBe(false);
    }
  });

  // The dev-time half of failing closed: for every provider that may evaluate, the explicit IN and OUT
  // rules PARTITION every key rimpl emits. A key added to rimpl (and so to ALL_KEYS) that no rule
  // names fails here, even though at runtime it would already count as IN.
  describe('IN and OUT partition every key, for every provider that may evaluate', () => {
    const { driftKeyRules } = require('../src/services/model-lock');
    const { PROVIDER_NAMES, servesPurpose } = require('../../rimpl/src/lib/provider-policy');
    const EVALUATORS = PROVIDER_NAMES.filter((n) => servesPurpose(n, 'evaluate'));
    const OUT = {
      local: [
        'code.decoding.shadow.temperature', 'code.decoding.shadow.max_tokens',
        'code.decoding.criteria.temperature', 'code.decoding.criteria.max_tokens',
        'code.decoding.discuss.temperature', 'code.decoding.discuss.max_tokens',
        'code.decoding.chat.temperature', 'code.decoding.chat.fast_max_tokens', 'code.decoding.chat.deep_max_tokens',
        'code.decoding.chat.evidence_line_max_tokens',
        'code.consistency.shadow_mode', 'code.models.anthropic',
        'code.decoding.num_ctx.local-tutor', 'code.thinking_style.local', 'code.thinking_style.local-tutor',
        'declared.providers.chat', 'declared.providers.criteria', 'declared.providers.discuss',
        'declared.local-tutor.model', 'declared.local-tutor.served_model', 'declared.local-tutor.engine', 'declared.local-tutor.system_fingerprint',
      ],
      anthropic: [
        'code.decoding.shadow.temperature', 'code.decoding.shadow.max_tokens',
        'code.decoding.criteria.temperature', 'code.decoding.criteria.max_tokens',
        'code.decoding.discuss.temperature', 'code.decoding.discuss.max_tokens',
        'code.decoding.chat.temperature', 'code.decoding.chat.fast_max_tokens', 'code.decoding.chat.deep_max_tokens',
        'code.decoding.chat.evidence_line_max_tokens',
        'code.consistency.shadow_mode', ...CONSISTENCY_DRIFT,
        'code.decoding.num_ctx.local', 'code.decoding.num_ctx.local-tutor', 'code.thinking_style.local', 'code.thinking_style.local-tutor',
        'declared.providers.chat', 'declared.providers.criteria', 'declared.providers.discuss',
        'declared.local.model', 'declared.local.served_model', 'declared.local.engine', 'declared.local.system_fingerprint',
        'declared.local-tutor.model', 'declared.local-tutor.served_model', 'declared.local-tutor.engine', 'declared.local-tutor.system_fingerprint',
      ],
    };
    const IN = { local: LOCAL_EVALUATOR_DRIFT, anthropic: ANTHROPIC_EVALUATOR_DRIFT };

    test('the providers that may evaluate are rimpl\'s: anthropic and local', () => {
      expect(sorted(EVALUATORS)).toEqual(['anthropic', 'local']);
    });

    test.each(['anthropic', 'local'])('%s: each key matches an IN or an OUT rule, never both, never neither', (provider) => {
      const inKeys = [];
      const outKeys = [];
      for (const key of ALL_KEYS) {
        const rules = driftKeyRules(key, provider, REAL);
        expect({ key, both: rules.in.length > 0 && rules.out.length > 0 }).toEqual({ key, both: false });
        expect({ key, neither: rules.in.length === 0 && rules.out.length === 0 }).toEqual({ key, neither: false });
        (rules.in.length ? inKeys : outKeys).push(key);
      }
      expect(sorted([...inKeys, ...outKeys])).toEqual(sorted(ALL_KEYS));
      expect(sorted(inKeys)).toEqual(sorted(IN[provider]));
      expect(sorted(outKeys)).toEqual(sorted(OUT[provider]));
      expect(IN[provider].length + OUT[provider].length).toBe(ALL_KEYS.length);
    });

    test('the three temperatures with no env override are OUT by name, not by default', () => {
      for (const provider of ['anthropic', 'local']) {
        expect(driftKeyRules('code.decoding.shadow.temperature', provider, REAL).out).toEqual(['shadow decoding']);
        expect(driftKeyRules('code.decoding.criteria.temperature', provider, REAL).out).toEqual(['criteria decoding']);
        expect(driftKeyRules('code.decoding.discuss.temperature', provider, REAL).out).toEqual(['discuss decoding']);
      }
    });

    test('a key no rule names is IN at runtime, for every provider', () => {
      for (const provider of ['anthropic', 'local']) {
        for (const key of ['code.think_preopened.local', 'code.evaluator.prompt_override', 'code.router.version']) {
          expect(driftKeyRules(key, provider, REAL)).toEqual({ in: [], out: [] });
          expect(isEvaluatorDriftKey(key, provider, REAL)).toBe(true);
        }
      }
    });
  });

  test('with no provider, nothing provider-specific can be ruled out; odd input is always in, as a placeholder', () => {
    // Only the provider-independent OUT rules apply: other purposes' decoding, routes and thinking, and
    // the shadow. Every provider-specific key (num_ctx, declared blocks, the Claude model) stays IN.
    const providerFree = [
      'code.decoding.shadow.temperature', 'code.decoding.shadow.max_tokens',
      'code.decoding.criteria.temperature', 'code.decoding.criteria.max_tokens',
      'code.decoding.discuss.temperature', 'code.decoding.discuss.max_tokens',
      'code.decoding.chat.temperature', 'code.decoding.chat.fast_max_tokens', 'code.decoding.chat.deep_max_tokens',
      'code.decoding.chat.evidence_line_max_tokens', 'code.consistency.shadow_mode',
      'code.thinking_style.local', 'code.thinking_style.local-tutor',
      'declared.providers.chat', 'declared.providers.criteria', 'declared.providers.discuss',
    ];
    for (const expected of [null, REAL]) {
      expect(sorted(evaluatorDriftKeys(ALL_KEYS, null, expected))).toEqual(sorted(ALL_KEYS.filter((k) => !providerFree.includes(k))));
    }
    for (const bad of [null, undefined, 42, {}, 'declared.local.model\n', 'code.consistency.evaluate_mode value=x']) {
      expect(isEvaluatorDriftKey(bad, 'local', REAL)).toBe(true);
    }
    expect(evaluatorDriftKeys(['code.decoding.chat.temperature', 'a b', 'c=d'], 'local', REAL)).toEqual(['(malformed drift key)']);
    // 'providers' is the purpose map, never a provider: it must not pull in every purpose's route.
    expect(evaluatorDriftKeys(ALL_KEYS, 'providers')).not.toContain('declared.providers.chat');
    // 'local' must not match 'local-tutor' by prefix.
    expect(evaluatorDriftKeys(ALL_KEYS, 'local').filter((k) => k.includes('local-tutor'))).toEqual([]);
    expect(evaluatorDriftKeys(null, 'local')).toEqual([]);
    expect(evaluatorDriftKeys(['declared.local.model', 'declared.local.model'], 'local')).toEqual(['declared.local.model']);
  });
});
