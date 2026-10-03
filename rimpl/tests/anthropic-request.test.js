// The claude-sonnet-5-5 move (2026-10-03): what the pinned model accepts (lib/anthropic-request.js),
// and how the decoding ACTUALLY SENT reaches §10.2 provenance (lib/provenance.js, routes/evaluate.js).
//
// Why each block exists:
//   * Sonnet 5.5 returns a 400 on a non-default temperature. The evaluator asks for 0, so sending it
//     would turn every scored evaluation into a 502. It must be dropped, and provenance must then
//     say null rather than restate the 0 that was asked for.
//   * Omitting `thinking` on Sonnet 5.5 runs ADAPTIVE thinking (4.6 ran none), sharing max_tokens
//     with reasoning. rimpl sends `between_tools`, and that mode is recorded because it changes the
//     instrument.
//   * Adding the thinking slot must not move a single fingerprint written before it existed, or every
//     stored local score stops being comparable.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/lib/supabase', () => {
  const chain = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = undefined;
  return { supabase: { from: jest.fn(() => chain), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) } };
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { requestShape, SHAPES } = require('../src/lib/anthropic-request');
const { buildProvenance } = require('../src/lib/provenance');

describe('lib/anthropic-request — what the pinned model accepts', () => {
  test('the pinned MODEL has a declared shape (boot would otherwise throw)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/providers/anthropic.js'), 'utf8');
    const pinned = src.match(/const MODEL = '(claude-[a-z0-9.-]+)'/)[1];
    expect(pinned).toBe('claude-sonnet-5-5');
    expect(SHAPES).toHaveProperty(pinned);
  });

  test('sonnet-5-5: temperature is dropped and reported as dropped; thinking is between_tools, alone', () => {
    const s = requestShape('claude-sonnet-5-5', { temperature: 0 });
    expect(s.fields).toEqual({ thinking: { type: 'between_tools' } });
    expect(s.sent).toEqual({ temperature: null, thinking: 'between_tools' });
    expect(s.dropped).toEqual(['temperature']);
  });

  test('sonnet-5-5 with no temperature requested drops nothing', () => {
    expect(requestShape('claude-sonnet-5-5').dropped).toEqual([]);
  });

  test('sonnet-4-6 (rollback) keeps its old shape: temperature sent, no thinking field', () => {
    const s = requestShape('claude-sonnet-4-6', { temperature: 0 });
    expect(s.fields).toEqual({ temperature: 0 });   // 0 survives (falsy but meaningful)
    expect(s.sent).toEqual({ temperature: 0, thinking: null });
  });

  test('an undeclared model is refused, never guessed at', () => {
    expect(() => requestShape('claude-sonnet-9-9')).toThrow(/No Anthropic request shape/);
  });

  test('the returned fields are a copy: a caller mutating them cannot change the table', () => {
    requestShape('claude-sonnet-5-5').fields.thinking.type = 'adaptive';
    expect(requestShape('claude-sonnet-5-5').fields.thinking).toEqual({ type: 'between_tools' });
  });
});

describe('lib/provenance — the thinking slot', () => {
  const base = { provider: 'local', model: 'qwen-test', promptVersion: 'p', rubricVersion: 'r', temperature: 0, maxTokens: 4096 };

  test('absent thinking leaves both the record and the fingerprint exactly as before', () => {
    const p = buildProvenance(base);
    expect(p.decoding).not.toHaveProperty('thinking');
    expect(buildProvenance({ ...base, thinking: null }).config_fingerprint).toBe(p.config_fingerprint);
  });

  test('a sent thinking mode is recorded and moves the fingerprint', () => {
    const a = buildProvenance({ ...base, provider: 'anthropic', model: 'claude-sonnet-5-5', temperature: null });
    const b = buildProvenance({ ...base, provider: 'anthropic', model: 'claude-sonnet-5-5', temperature: null, thinking: 'between_tools' });
    expect(b.decoding.thinking).toBe('between_tools');
    expect(b.config_fingerprint).not.toBe(a.config_fingerprint);
  });
});

describe('POST /evaluate records the decoding the provider SENT, not what it asked for', () => {
  const app = require('../src/index');
  const { callAI, resolveProviderName } = require('../src/services/ai');
  const VALID = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: {} };
  const body = { ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }] };
  const reply = (extra) => ({ text: JSON.stringify(VALID), inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ...extra });

  beforeEach(() => { callAI.mockReset(); resolveProviderName.mockReset(); });

  test('anthropic on sonnet-5-5: temperature null, thinking between_tools, though 0 was still requested', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValueOnce(reply({ provider: 'anthropic', model: 'claude-sonnet-5-5', decoding: { temperature: null, thinking: 'between_tools' } }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(callAI.mock.calls[0][0].temperature).toBe(0);            // the route's request is unchanged
    expect(res.body.provenance.decoding.temperature).toBeNull();     // ...but 0 was not sent, so 0 is not recorded
    expect(res.body.provenance.decoding.thinking).toBe('between_tools');
    expect(res.body.model_version).toBe('CCME_LLM_v8.0+claude-sonnet-5-5');
  });

  test('local: temperature 0 as sent, no thinking slot', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValueOnce(reply({ provider: 'local', model: 'qwen-test', decoding: { temperature: 0, thinking: null } }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(res.body.provenance.decoding.temperature).toBe(0);
    expect(res.body.provenance.decoding).not.toHaveProperty('thinking');
  });

  test('a provider that reports nothing is recorded as null, never as the requested value', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValueOnce(reply({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(res.body.provenance.decoding.temperature).toBeNull();
  });
});
