// The Primary Evaluator Model Lock.
//
// Scores already carried a configuration fingerprint. What was missing is the DECLARATION of the
// parts a running system cannot read for itself — the weights checksum above all, which is not
// obtainable over an inference API and has to be stated by someone with filesystem access. Until it
// is, the lock is an assertion rather than a checkable fact.
//
// The gate is the point of this suite: a configuration may not be frozen against a number that never
// touched a human judgement, and it may not be frozen against a number the data cannot support.

const mockSettings = {};
const mockUpserts = [];
const mockEvents = [];
const mockInserts = [];
let mockGate;

const SA = { id: 'sa-1', role: 'superadmin', status: 'active' };

jest.mock('../src/lib/audit', () => ({ logEvent: (e) => { mockEvents.push(e); } }));
jest.mock('../src/services/agreement', () => ({ decisiveVerdict: async () => mockGate }));
jest.mock('../src/services/rimpl-client', () => ({ probeRimplProvider: async () => ({ fit: true }), probeRimplDeep: async () => ({ body: {} }) }));

jest.mock('../src/lib/supabase', () => {
  const chain = (table) => {
    let key = null;
    const c = {
      select: () => c,
      order: () => c,
      limit: () => c,
      eq: (_col, v) => { key = v; return c; },
      insert: (p) => { mockInserts.push({ table, payload: p }); return c; },
      upsert: (p) => {
        for (const row of [].concat(p)) { mockUpserts.push(row); mockSettings[row.key] = row.value_text; }
        return c;
      },
      maybeSingle: () => Promise.resolve({
        data: table === 'app_settings'
          ? (key in mockSettings ? { value_text: mockSettings[key] } : null)
          : (table === 'evaluator_model_lock' ? (mockInserts.at(-1)?.payload ?? null) : null),
        error: null,
      }),
      single: () => Promise.resolve({ data: { id: SA.id, role: 'superadmin', status: 'active' }, error: null }),
      then: (r) => r({ data: null, error: null }),
    };
    return c;
  };
  return {
    supabase: { from: (t) => chain(t), rpc: () => Promise.resolve({ error: null }) },
    authSupabase: { auth: { getUser: () => Promise.resolve({ data: { user: { id: SA.id, email: 'sa@t' } }, error: null }) } },
  };
});

const request = require('supertest');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/superadmin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const DIGEST = 'a'.repeat(64);
const DECLARATION = {
  weights_sha256: DIGEST,
  inference_engine: 'ollama 0.12.0',
  quantization: 'Q8_0',
  system_prompt_version: 'sys-v3',
  evaluator_prompt_version: 'eval-v7',
  rubric_version: '2.0',
  decoding: { temperature: 0, top_p: 1, max_tokens: 1500, seed: 7 },
  environment: { os: 'ubuntu 24.04', cuda: '12.4' },
};
const verdict = (state, over = {}) => ({
  ok: true,
  verdict: { state, threshold: 0.75, icc: 0.82, lower: 0.77, upper: 0.9, n: 60, why: 'the whole interval is at or above 0.75', ...over },
  candidate: { provider: 'local', model_version: 'qwen-2.5-72b' },
});

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  mockUpserts.length = 0; mockEvents.length = 0; mockInserts.length = 0;
  mockGate = verdict('pass');
});

const declare = (body = DECLARATION) => auth(request(app).post('/admin/evaluator-lock')).send(body);
const lockRows = () => mockInserts.filter((i) => i.table === 'evaluator_model_lock');

describe('the gate on declaring', () => {
  test('a candidate that has not cleared the decisive bar cannot be frozen', async () => {
    mockGate = verdict('fail', { why: 'the whole interval is below 0.75' });
    const r = await declare();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('gate_not_passed');
    expect(lockRows()).toHaveLength(0);
    expect(mockSettings.evaluator_locked_at).toBeUndefined();
  });

  test('INSUFFICIENT is refused too — not knowing is not permission', async () => {
    // The tempting reading is that only an outright `fail` should block. It is exactly backwards:
    // freezing on a number the data cannot support is the failure mode the third state exists for.
    mockGate = verdict('insufficient', { why: '3 pairs cannot support a confidence interval' });
    const r = await declare();
    expect(r.status).toBe(409);
    expect(lockRows()).toHaveLength(0);
  });

  test('the refusal says which state and why, so it is actionable', async () => {
    mockGate = verdict('insufficient', { why: 'the interval spans 0.75 — more pairs are needed to decide' });
    const r = await declare();
    expect(r.body.error).toMatch(/insufficient/);
    expect(r.body.gate.why).toMatch(/more pairs/);
  });
});

describe('declaring', () => {
  test('writes ONE record carrying everything the system could not read for itself', async () => {
    const r = await declare();
    expect(r.status).toBe(200);
    expect(lockRows()).toHaveLength(1);
    expect(lockRows()[0].payload).toMatchObject({
      weights_sha256: DIGEST,
      inference_engine: 'ollama 0.12.0',
      evaluator_prompt_version: 'eval-v7',
      rubric_version: '2.0',
      locked_by: SA.id,
      provider: 'local', model_version: 'qwen-2.5-72b',
    });
  });

  test('stores the verdict that PERMITTED the freeze, beside the freeze', async () => {
    // Otherwise "was this frozen against a number that had cleared the bar?" is answerable only by
    // reconstructing the corpus as it stood that day, which nobody will do.
    await declare();
    expect(lockRows()[0].payload.gate).toMatchObject({ state: 'pass', threshold: 0.75, n: 60 });
  });

  test('sets the flag the provider switch refuses on, and the digest every later score is stamped with', async () => {
    await declare();
    expect(mockSettings.evaluator_locked_at).toEqual(expect.any(String));
    expect(mockSettings.evaluator_weights_sha256).toBe(DIGEST);
  });

  test('is one audit entry, naming what was frozen', async () => {
    await declare();
    const locks = mockEvents.filter((e) => e.action === 'evaluator_model_lock');
    expect(locks).toHaveLength(1);
    expect(locks[0].metadata).toMatchObject({ weights_sha256: DIGEST, model_version: 'qwen-2.5-72b' });
  });

  test('a checksum that is not a SHA-256 digest is refused', async () => {
    // A checksum nobody can verify the shape of is a string, not evidence.
    for (const bad of ['not-a-digest', 'abc123', 'z'.repeat(64), '']) {
      expect((await declare({ ...DECLARATION, weights_sha256: bad })).status).toBe(400);
    }
    expect(lockRows()).toHaveLength(0);
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
    mockGate = verdict('insufficient', { why: '3 pairs cannot support a confidence interval' });
    const r = await auth(request(app).get('/admin/evaluator-lock'));
    expect(r.status).toBe(200);
    expect(r.body.can_declare).toBe(false);
    expect(r.body.gate).toMatchObject({ state: 'insufficient' });
  });

  test('opens only on a pass', async () => {
    const r = await auth(request(app).get('/admin/evaluator-lock'));
    expect(r.body.can_declare).toBe(true);
    expect(r.body.candidate).toMatchObject({ model_version: 'qwen-2.5-72b' });
  });
});

test('once declared, the evaluator provider is refused outright', async () => {
  // The lock is only worth having if it actually stops the thing it names. This is the existing
  // refusal; the point here is that DECLARING is what arms it.
  await declare();
  const r = await auth(request(app).patch('/admin/ai-providers'))
    .send({ purpose: 'evaluate', provider: 'anthropic', confirm: 'CHANGE EVALUATOR' });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('evaluator_locked');
});
