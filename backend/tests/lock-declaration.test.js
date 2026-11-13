// #75 acceptance criterion 7: "Two scores from different configurations are distinguishable by
// fingerprint alone."
//
// rimpl's per-score config_fingerprint covers what rimpl can see. Until this, the rest of the
// declaration (the declared inference engine, quantization, environment, system prompt version and
// decoding) existed only on the lock record, so two locks over the same weights checksum (the same file
// loaded at fp8 and at bf16, say) gave scores with identical fingerprints. Now an evaluation run under a
// lock carries lockDeclarationDigest() of the record in force, and rimpl folds it into the fingerprint
// (rimpl/tests/provenance-lock-declaration.test.js covers that half).
//
// Three layers here: the digest itself, the wire body rimplEvaluate sends, and the whole path from
// POST /admin/evaluator-lock to the /evaluate request body, over the shared hermetic database double and
// a fetch double standing in for rimpl. Nothing is mocked between the declaration and the wire except
// the agreement verdict and the usage meter.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/agreement', () => ({ ...jest.requireActual('../src/services/agreement'), decisiveVerdict: jest.fn() }));
jest.mock('../src/lib/usage', () => ({ ...jest.requireActual('../src/lib/usage'), accrueUsage: jest.fn(async () => ({ cost: 0, error: null })) }));

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { decisiveVerdict } = require('../src/services/agreement');
const {
  lockDeclarationDigest, LOCK_DECLARATION_VERSION, LOCK_DECLARATION_FIELDS, resetManifestCache,
} = require('../src/services/model-lock');
const { triggerEvaluation, evaluationLockStamp } = require('../src/services/ple-evaluation');
const { rimplEvaluate } = require('../src/services/rimpl-client');

const W = 'a'.repeat(64);
const MSHA = 'f'.repeat(64);
// The local evaluator's label: the manifest's model-free label plus `@<declared model>` (rimpl
// versions.js promptVersionFor), which is what its rows are stamped with and what a lock declares.
const PV_LABEL = 'pis7-prompt-59561c29+local-c5ffe572aa81';
const PV = `${PV_LABEL}@qwen-2.5-72b`;
const RV = 'pis7-weights-08b0cb1a';
const MV = 'CCME_LLM_v8.0+qwen-2.5-72b';

// ---- the digest ----------------------------------------------------------------------------------

const RECORD = Object.freeze({
  id: 'lock-1', locked_at: '2026-10-15T09:00:00.000Z', locked_by: 'sa-1',
  provider: 'local', model_version: MV,
  weights_sha256: W, inference_engine: 'vllm 0.21.1', quantization: 'bf16',
  system_prompt_version: 'sys-v3', evaluator_prompt_version: PV, rubric_version: RV,
  decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: 7 },
  environment: { os: 'ubuntu 24.04', cuda: '12.4', vllm: '0.21.1' },
  gate: { state: 'pass', icc: 0.82, n: 60 }, note: 'first lock',
  manifest_sha256: MSHA, manifest: { code: {} }, evaluator_sha256: 'e'.repeat(64),
});

describe('lockDeclarationDigest: what a post-lock score carries', () => {
  test('the declared fields, exactly, and the version tag', () => {
    expect(LOCK_DECLARATION_VERSION).toBe('clics-lock-declaration/v1');
    expect([...LOCK_DECLARATION_FIELDS]).toEqual([
      'weights_sha256', 'inference_engine', 'quantization', 'environment',
      'system_prompt_version', 'evaluator_prompt_version', 'rubric_version', 'decoding',
      'provider', 'model_version',
    ]);
    expect(Object.isFrozen(LOCK_DECLARATION_FIELDS)).toBe(true);
  });

  test('the payload is the tagged canonical JSON of those fields, so anyone can recompute it from a record', () => {
    // Written out by hand, keys sorted at every level: the format is pinned independently of the helper.
    const payload = '{"declaration":{'
      + '"decoding":{"max_tokens":1500,"seed":7,"temperature":0,"top_p":1},'
      + '"environment":{"cuda":"12.4","os":"ubuntu 24.04","vllm":"0.21.1"},'
      + `"evaluator_prompt_version":"${PV}","inference_engine":"vllm 0.21.1","model_version":"${MV}",`
      + `"provider":"local","quantization":"bf16","rubric_version":"${RV}","system_prompt_version":"sys-v3",`
      + `"weights_sha256":"${W}"},"v":"clics-lock-declaration/v1"}`;
    expect(lockDeclarationDigest(RECORD)).toBe(crypto.createHash('sha256').update(payload, 'utf8').digest('hex'));
  });

  test('is deterministic: the same declaration digests the same, whatever the key order', () => {
    const d = lockDeclarationDigest(RECORD);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(lockDeclarationDigest({ ...RECORD })).toBe(d);
    const reordered = Object.fromEntries(Object.entries(RECORD).reverse());
    reordered.decoding = { seed: 7, max_tokens: 1500, top_p: 1, temperature: 0 };
    reordered.environment = { vllm: '0.21.1', cuda: '12.4', os: 'ubuntu 24.04' };
    expect(lockDeclarationDigest(reordered)).toBe(d);
  });

  // ONE case per declared field. The list is checked against LOCK_DECLARATION_FIELDS below, so a field
  // added to the digest without a case here fails.
  const CHANGES = [
    ['weights_sha256', 'b'.repeat(64)],
    ['inference_engine', 'vllm 0.22.0'],
    ['quantization', 'fp8'],                                   // the same weights loaded at fp8: the motivating case
    ['environment', { ...RECORD.environment, vllm: '0.22.0' }],  // a library upgrade under an unchanged model id
    ['system_prompt_version', 'sys-v4'],
    ['evaluator_prompt_version', 'pis7-prompt-59561c29'],
    ['rubric_version', 'pis7-weights-ffffffff'],
    ['decoding', { ...RECORD.decoding, top_p: 0.9 }],
    ['provider', 'anthropic'],
    ['model_version', 'CCME_LLM_v8.0+qwen-2.5-72b-instruct'],
  ];
  test('every declared field has a case below', () => {
    expect(CHANGES.map(([f]) => f).sort()).toEqual([...LOCK_DECLARATION_FIELDS].sort());
  });
  test.each(CHANGES)('a different %s gives a different digest', (field, value) => {
    expect(lockDeclarationDigest({ ...RECORD, [field]: value })).not.toBe(lockDeclarationDigest(RECORD));
  });

  test('a declared value and no declaration differ (quantization, environment)', () => {
    expect(lockDeclarationDigest({ ...RECORD, quantization: null })).not.toBe(lockDeclarationDigest(RECORD));
    expect(lockDeclarationDigest({ ...RECORD, environment: null })).not.toBe(lockDeclarationDigest(RECORD));
  });

  test('a top-level field the record lacks is the same as one that is null', () => {
    const { provider: _p, model_version: _m, ...withoutThem } = RECORD;
    expect(lockDeclarationDigest(withoutThem)).toBe(lockDeclarationDigest({ ...RECORD, provider: null, model_version: null }));
  });

  test('a STATED "no seed" is not an undeclared seed, as the lock form treats them', () => {
    const { seed: _s, ...noSeedKey } = RECORD.decoding;
    expect(lockDeclarationDigest({ ...RECORD, decoding: { ...noSeedKey, seed: null } }))
      .not.toBe(lockDeclarationDigest({ ...RECORD, decoding: noSeedKey }));
  });

  test('when, by whom and on what evidence do not move it: a re-declaration of identical values does not split groups', () => {
    const relock = { ...RECORD, id: 'lock-2', locked_at: '2026-11-01T00:00:00.000Z', locked_by: 'sa-2',
      gate: { state: 'pass', icc: 0.91, n: 80 }, note: 'replaced after the security patch',
      manifest_sha256: '0'.repeat(64), manifest: { code: { other: true } }, evaluator_sha256: '1'.repeat(64) };
    expect(lockDeclarationDigest(relock)).toBe(lockDeclarationDigest(RECORD));
  });

  test('refuses anything that is not a record, rather than digesting nothing', () => {
    for (const bad of [null, undefined, 'x', [], 42]) expect(() => lockDeclarationDigest(bad)).toThrow(TypeError);
  });
});

// ---- the identity basis (ADR 0012): v1 for a weights lock, unchanged; v2 for a model-identity lock ----
describe('lockDeclarationDigest by identity basis', () => {
  // A v1 record as it stood before identity_basis existed, with its digest as a literal: the sha256 of the
  // hand-written v1 payload above, for the model-free prompt label that record declared.
  const V1_RECORD = Object.freeze({ ...RECORD, evaluator_prompt_version: PV_LABEL });
  const V1_DIGEST = '24946448595635e8c454d5a6101769c5ed3120251f297f920798ef2ec9fe9093';
  const FP = 'vllm-0.22.0-tp2-0123abcd';
  const ID_RECORD = Object.freeze({ ...RECORD, identity_basis: 'model_id+system_fingerprint', weights_sha256: null, system_fingerprint: FP });

  test('a weights_sha256 record digests to the value it had before the basis existed, with or without the new columns', () => {
    expect(lockDeclarationDigest(V1_RECORD)).toBe(V1_DIGEST);
    expect(lockDeclarationDigest({ ...V1_RECORD, identity_basis: 'weights_sha256', system_fingerprint: null })).toBe(V1_DIGEST);
  });

  test('a model-identity record is the v2 tagged canonical JSON: v1\'s fields plus the basis and the fingerprint', () => {
    const payload = '{"declaration":{'
      + '"decoding":{"max_tokens":1500,"seed":7,"temperature":0,"top_p":1},'
      + '"environment":{"cuda":"12.4","os":"ubuntu 24.04","vllm":"0.21.1"},'
      + `"evaluator_prompt_version":"${PV}","identity_basis":"model_id+system_fingerprint","inference_engine":"vllm 0.21.1",`
      + `"model_version":"${MV}","provider":"local","quantization":"bf16","rubric_version":"${RV}",`
      + `"system_fingerprint":"${FP}","system_prompt_version":"sys-v3","weights_sha256":null},"v":"clics-lock-declaration/v2"}`;
    expect(lockDeclarationDigest(ID_RECORD)).toBe(crypto.createHash('sha256').update(payload, 'utf8').digest('hex'));
  });

  test('a different fingerprint or model id is a different v2 digest', () => {
    const d = lockDeclarationDigest(ID_RECORD);
    expect(lockDeclarationDigest({ ...ID_RECORD, system_fingerprint: 'vllm-0.22.1-tp2-ffff' })).not.toBe(d);
    expect(lockDeclarationDigest({ ...ID_RECORD, model_version: 'CCME_LLM_v8.0+other' })).not.toBe(d);
  });

  test('the same declared fields under the two bases never share a digest', () => {
    expect(lockDeclarationDigest(ID_RECORD)).not.toBe(lockDeclarationDigest({ ...ID_RECORD, identity_basis: 'weights_sha256' }));
  });

  test('an unknown basis is refused rather than digested under a guess', () => {
    expect(() => lockDeclarationDigest({ ...RECORD, identity_basis: 'vibes' })).toThrow(TypeError);
  });
});

// ---- the fetch double: rimpl's GET /manifest and POST /evaluate ------------------------------------

const EXPECTED = {
  code: {
    anthropic: { model: 'claude-sonnet-4-6', model_version: 'CCME_LLM_v8.0+claude-sonnet-4-6' },
    model_version_prefix: 'CCME_LLM_v8.0+',
    evaluator: { prompt_version: { anthropic: 'pis7-prompt-59561c29', local: PV_LABEL }, rubric_version: RV },
    decoding: { evaluate: { max_tokens: { default: 1500, env: 'EVAL_MAX_TOKENS' }, temperature: 0 } },
    consistency: { evaluate: { mode: { default: 'off', env: 'EVAL_CONSISTENCY', applies_to: 'local' } } },
    providers: { allowed: { evaluate: ['anthropic', 'local'] } },
  },
  declared: { providers: { evaluate: 'local' }, local: { role: 'evaluator', model: 'qwen-2.5-72b', engine: 'vllm' } },
};
const SCORE = { d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {}, model_version: MV,
  prompt_version: PV, rubric_version: RV, provenance: {}, input_tokens: 100, output_tokens: 50, provider: 'local' };

const savedFetch = global.fetch;
afterAll(() => { global.fetch = savedFetch; });
const respond = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const evaluateBodies = () => global.fetch.mock.calls
  .filter(([url]) => String(url).endsWith('/evaluate')).map(([, init]) => JSON.parse(init.body));

describe('rimplEvaluate puts the digest on the wire only when there is one', () => {
  beforeEach(() => { global.fetch = jest.fn(async () => respond(SCORE)); });
  const CALL = { ple_id: 'p1', transcript: [{ role: 'physician', content: 'x' }], patient_ref: null, chief_complaint: null, shadow: true };

  test('locked: the declaration digest is sent beside the weights digest', async () => {
    const d = lockDeclarationDigest(RECORD);
    await rimplEvaluate({ ...CALL, weights_sha256: W, lock_declaration_sha256: d });
    expect(evaluateBodies()[0]).toMatchObject({ weights_sha256: W, lock_declaration_sha256: d });
  });

  test('unlocked: the key is ABSENT, so the request is the one an unlocked evaluation always sent', async () => {
    await rimplEvaluate({ ...CALL, weights_sha256: null, lock_declaration_sha256: null });
    await rimplEvaluate({ ...CALL });
    for (const body of evaluateBodies()) {
      expect(body).not.toHaveProperty('lock_declaration_sha256');
      expect(body.weights_sha256).toBeNull();
    }
  });
});

// ---- from the declaration to the evaluation payload ------------------------------------------------

const SA = { id: 'sa-1', role: 'superadmin', status: 'active', email: 'sa@t' };
const DECLARATION = {
  weights_sha256: W,
  inference_engine: 'vllm 0.21.1',
  quantization: 'bf16',
  system_prompt_version: 'sys-v3',
  evaluator_prompt_version: PV,
  rubric_version: RV,
  decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: 7 },
  environment: { os: 'ubuntu 24.04', cuda: '12.4' },
};
const CANDIDATE = { provider: 'local', model_version: MV, prompt_version: PV, rubric_versions: [RV] };

let db;
// The columns a select asked for, or null for '*'. PostgREST returns only those, so the double does too.
const projection = (ctx) => {
  const arg = Array.isArray(ctx.selectArgs) ? ctx.selectArgs[0] : null;
  return typeof arg === 'string' && arg.trim() !== '*' ? arg.split(',').map((c) => c.trim()) : null;
};
const project = (row, cols) => (row && cols ? Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])) : row);

function resolve(table, kind, ctx) {
  if (table === 'app_settings') {
    if (kind === 'maybeSingle') {
      const key = ctx.id('key');
      return key in db.settings ? { value_text: db.settings[key] } : null;
    }
    if (kind === 'list') {
      const keys = ctx.ins.find(([c]) => c === 'key')?.[1] ?? [];
      return keys.filter((k) => k in db.settings).map((k) => ({ key: k, value_text: db.settings[k] }));
    }
    if (kind === 'upsert') {
      const rows = [].concat(ctx.payload);
      for (const r of rows) db.settings[r.key] = r.value_text;
      return { data: rows.map((r) => ({ key: r.key })) };
    }
    return undefined;
  }
  if (table === 'evaluator_model_lock') {
    if (kind === 'list') return [];                                              // the manifest-column probe
    if (kind === 'maybeSingle' && ctx.op === 'insert') {
      const row = { id: `lock-${db.locks.length + 1}`, ...ctx.payload };
      db.locks.push(row);
      return row;
    }
    if (kind === 'maybeSingle') {
      const at = ctx.id('locked_at');
      const hits = at === undefined ? db.locks : db.locks.filter((l) => l.locked_at === at);
      return project(hits.at(-1) ?? null, projection(ctx));
    }
    return undefined;
  }
  if (table === 'audit_log' && kind === 'insert') { db.audit.push(ctx.payload); return { data: null }; }
  if (table === 'ai_evaluations' && kind === 'insert') { db.saved.push(ctx.payload); return { data: null }; }
  return undefined;   // lpdp_snapshots inserts and the ples update succeed
}

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/superadmin'));
const auth = (r) => r.set('Authorization', 'Bearer t');
const declare = (body) => auth(request(app).post('/admin/evaluator-lock')).send(body);
const unlock = () => auth(request(app).patch('/admin/ai-providers')).send({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
const evaluate = (pleId) => triggerEvaluation(pleId, [{ role: 'physician', content: 'x' }], 'doc1', null, { attempts: 1 });
// What rimpl stamps into provenance from the body it was sent. A CURRENT rimpl stamps both lock digests;
// master's (and any rimpl older than this change) strips the unknown lock_declaration_sha256 in its zod
// schema and still answers 200, `locked: true`, with the weights digest alone.
let rimplIsCurrent = true;
const rimplProvenance = (body) => ({
  weights_sha256: body.weights_sha256 ?? null, locked: !!body.weights_sha256,
  ...(rimplIsCurrent ? { lock_declaration_sha256: body.lock_declaration_sha256 ?? null, identity_basis: body.identity_basis ?? null } : {}),
});
const lastEvaluateBody = () => evaluateBodies().at(-1);

describe('from POST /admin/evaluator-lock to the /evaluate request body', () => {
  beforeEach(() => {
    m.reset();
    db = { settings: { ai_provider_evaluate: 'local' }, locks: [], audit: [], saved: [] };
    rimplIsCurrent = true;
    m.state.caller = SA;
    m.state.resolve = resolve;
    decisiveVerdict.mockReset().mockImplementation(async () => ({
      ok: true, verdict: { state: 'pass', threshold: 0.75, icc: 0.82, lower: 0.77, upper: 0.9, n: 60, why: 'clear' }, candidate: CANDIDATE,
    }));
    global.fetch = jest.fn(async (url, init) => (String(url).endsWith('/manifest')
      ? respond({ manifest: { schema: 'clics-model-manifest/v1', expected: EXPECTED, sha256: MSHA },
        sha256: MSHA, claimed_sha256: MSHA, file: 'present', code_match: true, live: {}, drift: [] })
      : respond({ ...SCORE, provenance: rimplProvenance(JSON.parse(init.body)) })));
    resetManifestCache();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { console.error.mockRestore(); });

  test('a declared lock: the digest POST reports, records on the audit trail, and the evaluation sends are one value', async () => {
    const r = await declare(DECLARATION);
    expect(r.status).toBe(200);
    const d = r.body.lock_declaration_sha256;
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(lockDeclarationDigest(db.locks[0]));
    expect(db.audit.find((e) => e.action === 'evaluator_model_lock').metadata.lock_declaration_sha256).toBe(d);

    await evaluate('ple-1');
    expect(lastEvaluateBody()).toMatchObject({ ple_id: 'ple-1', weights_sha256: W, lock_declaration_sha256: d });
  });

  test('unlocked, before and after a lock: nothing is sent', async () => {
    await evaluate('ple-before');
    expect(lastEvaluateBody()).not.toHaveProperty('lock_declaration_sha256');
    expect(lastEvaluateBody().weights_sha256).toBeNull();

    expect((await declare(DECLARATION)).status).toBe(200);
    expect((await unlock()).status).toBe(200);
    await evaluate('ple-after');
    expect(lastEvaluateBody()).not.toHaveProperty('lock_declaration_sha256');
    expect(lastEvaluateBody().weights_sha256).toBeNull();
  });

  test('same weights, different quantization: the two locks\' evaluations carry different digests', async () => {
    const first = (await declare(DECLARATION)).body.lock_declaration_sha256;
    await evaluate('ple-bf16');
    const bf16 = lastEvaluateBody();

    // A re-declaration (the change-control path): the same weights file, loaded at fp8.
    const r = await declare({ ...DECLARATION, quantization: 'fp8', confirm_relock: 'REPLACE THE LOCK' });
    expect(r.status).toBe(200);
    await evaluate('ple-fp8');
    const fp8 = lastEvaluateBody();

    expect(fp8.weights_sha256).toBe(bf16.weights_sha256);                     // the weights digest alone cannot tell them apart
    expect(fp8.lock_declaration_sha256).toBe(r.body.lock_declaration_sha256);
    expect(fp8.lock_declaration_sha256).not.toBe(bf16.lock_declaration_sha256);
    expect(bf16.lock_declaration_sha256).toBe(first);
  });

  test('a rimpl older than this change makes a locked evaluation DEFER, not mis-stamp, and it recovers once rimpl is current', async () => {
    expect((await declare(DECLARATION)).status).toBe(200);
    rimplIsCurrent = false;                                                    // a rollback / out-of-order deploy
    const err = await evaluate('ple-old').catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.code).toBe('lock_declaration_not_stamped');
    expect(lastEvaluateBody().lock_declaration_sha256).toMatch(/^[0-9a-f]{64}$/);   // it WAS sent
    expect(db.saved).toHaveLength(0);                                         // and the weights-only score was not kept

    rimplIsCurrent = true;                                                     // rimpl redeployed: the next attempt saves
    await evaluate('ple-old');
    expect(db.saved).toHaveLength(1);
    expect(db.saved[0].provenance.lock_declaration_sha256).toBe(lockDeclarationDigest(db.locks[0]));
  });

  test('unlocked, an older rimpl changes nothing: the score is saved as today', async () => {
    rimplIsCurrent = false;
    await evaluate('ple-unlocked-old-rimpl');
    expect(db.saved).toHaveLength(1);
  });

  test('a relock with identical values carries the same digest, so one configuration stays one group', async () => {
    const first = (await declare(DECLARATION)).body.lock_declaration_sha256;
    expect((await unlock()).status).toBe(200);
    const again = await declare(DECLARATION);
    expect(again.status).toBe(200);
    expect(db.locks).toHaveLength(2);                                         // two records, append-only
    expect(again.body.lock_declaration_sha256).toBe(first);
    await evaluate('ple-relocked');
    expect(lastEvaluateBody().lock_declaration_sha256).toBe(first);
  });

  describe('a model_id+system_fingerprint lock', () => {
    const FP = 'vllm-0.22.0-tp2-0123abcd';
    beforeEach(() => {
      const expected = { ...EXPECTED, declared: { ...EXPECTED.declared, local: { ...EXPECTED.declared.local, system_fingerprint: FP } } };
      global.fetch = jest.fn(async (url, init) => (String(url).endsWith('/manifest')
        ? respond({ manifest: { schema: 'clics-model-manifest/v1', expected, sha256: MSHA }, sha256: MSHA, claimed_sha256: MSHA,
          file: 'present', code_match: true, live: { last_seen: { local: { model: 'qwen-2.5-72b', engine: 'vllm', runtime: FP } } }, drift: [] })
        : respond({ ...SCORE, provenance: rimplProvenance(JSON.parse(init.body)) })));
    });
    const { weights_sha256: _w, ...noDigest } = DECLARATION;

    test('declared with no digest: the evaluation sends the basis, null weights and the v2 digest of the record, and the score is saved', async () => {
      const r = await declare({ ...noDigest, identity_basis: 'model_id+system_fingerprint' });
      expect(r.status).toBe(200);
      expect(db.locks[0]).toMatchObject({ identity_basis: 'model_id+system_fingerprint', weights_sha256: null, system_fingerprint: FP, model_version: MV });
      expect(db.settings.evaluator_weights_sha256).toBeNull();
      expect(r.body.lock_declaration_sha256).toBe(lockDeclarationDigest(db.locks[0]));
      await evaluate('ple-id');
      expect(lastEvaluateBody()).toMatchObject({ weights_sha256: null, identity_basis: 'model_id+system_fingerprint',
        lock_declaration_sha256: r.body.lock_declaration_sha256 });
      expect(db.saved).toHaveLength(1);
    });

    test('a weights lock over the same declaration carries a different digest and sends no basis', async () => {
      const byId = (await declare({ ...noDigest, identity_basis: 'model_id+system_fingerprint' })).body.lock_declaration_sha256;
      const byWeights = await declare({ ...DECLARATION, confirm_relock: 'REPLACE THE LOCK' });
      expect(byWeights.status).toBe(200);
      expect(byWeights.body.lock_declaration_sha256).not.toBe(byId);
      await evaluate('ple-w');
      expect(lastEvaluateBody()).toMatchObject({ weights_sha256: W });
      expect(lastEvaluateBody()).not.toHaveProperty('identity_basis');
    });
  });
});

// ---- evaluationLockStamp: every way the read can fail is a refusal, never "unlocked" ----------------
// (The deferral each one causes is tests/eval-retry.test.js's: a 503 before rimpl is called.)
describe('evaluationLockStamp fails closed', () => {
  const LOCKED = { evaluator_locked_at: '2026-10-15T09:00:00.000Z', evaluator_weights_sha256: W };
  const settingsRows = (s) => Object.entries(s).map(([key, value_text]) => ({ key, value_text }));
  beforeEach(() => { m.reset(); });

  test('a settings read that THROWS is lock_state_unreadable', async () => {
    m.state.resolve = (table) => { if (table === 'app_settings') throw new Error('socket hang up'); };
    expect(await evaluationLockStamp()).toEqual({ error: 'socket hang up', code: 'lock_state_unreadable' });
  });

  test('a settings read that answers no rows array is lock_state_unreadable, not "unlocked"', async () => {
    m.state.resolve = (table) => (table === 'app_settings' ? { data: null } : undefined);
    expect(await evaluationLockStamp()).toMatchObject({ code: 'lock_state_unreadable' });
  });

  test('a record read that THROWS is lock_record_unreadable', async () => {
    m.state.resolve = (table) => {
      if (table === 'app_settings') return settingsRows(LOCKED);
      throw new Error('relation "evaluator_model_lock" does not exist');
    };
    expect(await evaluationLockStamp()).toMatchObject({ code: 'lock_record_unreadable' });
  });

  test('both settings come from ONE statement, and the record is looked up by the flag', async () => {
    m.state.resolve = (table) => (table === 'app_settings' ? settingsRows(LOCKED) : { ...RECORD, locked_at: LOCKED.evaluator_locked_at });
    expect(await evaluationLockStamp()).toEqual({ weights_sha256: W, lock_declaration_sha256: lockDeclarationDigest(RECORD), identity_basis: null });
    const settingsReads = m.all('app_settings');
    expect(settingsReads).toHaveLength(1);
    expect(settingsReads[0].ins).toEqual([['key', ['evaluator_locked_at', 'evaluator_weights_sha256']]]);
    expect(m.find('evaluator_model_lock').eqs).toEqual([['locked_at', LOCKED.evaluator_locked_at]]);
  });

  test('the weights match is case-insensitive: a hex digest is the same digest in either case', async () => {
    m.state.resolve = (table) => (table === 'app_settings' ? settingsRows(LOCKED) : { ...RECORD, weights_sha256: W.toUpperCase() });
    expect(await evaluationLockStamp()).toMatchObject({ weights_sha256: W });
  });
});
