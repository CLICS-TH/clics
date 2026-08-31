// The PIS-7 evaluator's d1..d7 drive CME credit and are persisted into smallint CHECK(0..5) columns.
// /evaluate must reject malformed/out-of-range model output (502) rather than pass it through to
// poison the composite (NaN) or trip a CHECK violation downstream that reconcile then retries forever.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
// Hermetic: src/index mounts every route, and the chat route's require chain pulls in
// src/lib/supabase, whose createClient() throws "supabaseUrl is required" with no env.
// Stub it so the suite needs no real Supabase URL/key and makes no network round-trip.
jest.mock('../src/lib/supabase', () => {
  const chain = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = undefined; // not a thenable; tests don't await the builder here
  return {
    supabase: {
      from: jest.fn(() => chain),
      rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
    },
  };
});

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');

const VALID = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: {} };
const body = { ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }] };
// callAI stamps the real provider + model onto every result; /evaluate folds `model` into
// model_version (§10.2 provenance), so the fixture must carry them.
const reply = (obj) => ({
  text: JSON.stringify(obj), inputTokens: 1, outputTokens: 1,
  provider: 'anthropic', model: 'claude-sonnet-4-6',
});

describe('POST /evaluate output validation', () => {
  beforeEach(() => callAI.mockReset());

  test('out-of-range domain score -> 502', async () => {
    callAI.mockResolvedValueOnce(reply({ ...VALID, d2: 9 }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(502);
  });

  test('non-numeric domain score -> 502', async () => {
    callAI.mockResolvedValueOnce(reply({ ...VALID, d2: 'high' }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(502);
  });

  test('missing domain -> 502', async () => {
    const { d5, ...missing } = VALID;
    callAI.mockResolvedValueOnce(reply(missing));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(502);
  });

  test('valid 0-5 scores -> 200 with clean composite', async () => {
    callAI.mockResolvedValueOnce(reply(VALID));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(res.body.d2).toBe(4);
    // (3*.15+4*.20+3*.15+2*.15+5*.15+1*.10+4*.10)*20, rounded 2dp
    expect(res.body.composite_score).toBeGreaterThan(0);
    expect(Number.isFinite(res.body.composite_score)).toBe(true);
    // §10.2 locked-version provenance travels with every evaluation.
    expect(res.body.prompt_version).toMatch(/^pis7-prompt-[0-9a-f]{8}$/);
    expect(res.body.rubric_version).toMatch(/^pis7-weights-[0-9a-f]{8}$/);
    // §10.2 requires the row to name the system that ACTUALLY scored it: model_version is stamped
    // from the model callAI returned, not a module constant, and `provider` travels with it.
    expect(res.body.model_version).toBe('CCME_LLM_v8.0+claude-sonnet-4-6');
    expect(res.body.provider).toBe('anthropic');
    // Provider routing is keyed off `purpose`; scoring must declare 'evaluate'.
    expect(callAI.mock.calls[0][0].purpose).toBe('evaluate');
  });
});
