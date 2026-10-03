// The claude-sonnet-5-5 move (2026-10-03): what the pinned model accepts PER PURPOSE
// (lib/anthropic-request.js), the evaluator's per-provider budget (lib/eval-decoding.js), and how the
// decoding ACTUALLY SENT reaches §10.2 provenance (lib/provenance.js, routes/evaluate.js).
//
// Why each block exists:
//   * Sonnet 5.5 returns a 400 on a non-default temperature. The evaluator asks for 0, so sending it
//     would turn every scored evaluation into a 502. It must be dropped, and provenance must then say
//     null rather than restate the 0 that was asked for.
//   * The evaluator runs ADAPTIVE thinking at effort high (the prompting guide: "Use adaptive thinking
//     for reasoning tasks without tools"). Both are recorded and both enter the fingerprint, because
//     they change the instrument.
//   * Adding those slots must not move a single fingerprint written before they existed, or every
//     stored local score stops being comparable.
//   * The 16000 ceiling is anthropic-only. On local it would move every fingerprint and could overrun
//     the served context window.
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
const { requestShape, declaredPurposes, SHAPES } = require('../src/lib/anthropic-request');
const { EVAL_DECODING, evalMaxTokensFor } = require('../src/lib/eval-decoding');
const { buildProvenance } = require('../src/lib/provenance');

describe('lib/anthropic-request — what the pinned model accepts, per purpose', () => {
  test('the pinned MODEL declares a shape for every purpose rimpl sends it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/providers/anthropic.js'), 'utf8');
    const pinned = src.match(/const MODEL = '(claude-[a-z0-9.-]+)'/)[1];
    expect(pinned).toBe('claude-sonnet-5-5');
    expect(SHAPES).toHaveProperty(pinned);
    expect(declaredPurposes(pinned).sort()).toEqual(['chat', 'criteria', 'discuss', 'evaluate', 'shadow']);
  });

  test('evaluate: adaptive + effort high; temperature dropped and reported as dropped', () => {
    const s = requestShape('claude-sonnet-5-5', { temperature: 0, purpose: 'evaluate' });
    expect(s.fields).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(s.sent).toEqual({ temperature: null, thinking: 'adaptive', effort: 'high' });
    expect(s.dropped).toEqual(['temperature']);
  });

  test('shadow is scored with the evaluate shape', () => {
    expect(requestShape('claude-sonnet-5-5', { purpose: 'shadow' }).fields)
      .toEqual(requestShape('claude-sonnet-5-5', { purpose: 'evaluate' }).fields);
  });

  test.each(['chat', 'criteria'])('%s: between_tools + effort low (timeout budget), nothing else inside `thinking`', (purpose) => {
    const s = requestShape('claude-sonnet-5-5', { purpose });
    expect(s.fields).toEqual({ thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
    expect(s.dropped).toEqual([]);
  });

  test('discuss: adaptive + effort low', () => {
    expect(requestShape('claude-sonnet-5-5', { purpose: 'discuss' }).sent).toEqual({ temperature: null, thinking: 'adaptive', effort: 'low' });
  });

  test('no shape ever sends between_tools above effort high (a 400)', () => {
    for (const p of declaredPurposes('claude-sonnet-5-5')) {
      const { fields } = requestShape('claude-sonnet-5-5', { purpose: p });
      if (fields.thinking?.type === 'between_tools') expect(['low', 'medium', 'high']).toContain(fields.output_config.effort);
    }
  });

  test('sonnet-4-6 (rollback) keeps its old shape for every purpose: temperature sent, no thinking, no effort', () => {
    for (const purpose of ['evaluate', 'chat', undefined]) {
      const s = requestShape('claude-sonnet-4-6', { temperature: 0, purpose });
      expect(s.fields).toEqual({ temperature: 0 });   // 0 survives (falsy but meaningful)
      expect(s.sent).toEqual({ temperature: 0, thinking: null, effort: null });
    }
  });

  test('an undeclared model, or an undeclared purpose on a per-purpose model, is refused, never guessed at', () => {
    expect(() => requestShape('claude-sonnet-9-9', { purpose: 'chat' })).toThrow(/No Anthropic request shape/);
    expect(() => requestShape('claude-sonnet-5-5')).toThrow(/purpose "undefined"/);
    expect(() => requestShape('claude-sonnet-5-5', { purpose: 'embed' })).toThrow(/purpose "embed"/);
  });

  test('the returned fields are a copy: a caller mutating them cannot change the table', () => {
    const f = requestShape('claude-sonnet-5-5', { purpose: 'evaluate' }).fields;
    f.thinking.type = 'between_tools';
    f.output_config.effort = 'max';
    expect(requestShape('claude-sonnet-5-5', { purpose: 'evaluate' }).fields)
      .toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  });
});

describe('lib/eval-decoding — the evaluator ceiling is per provider', () => {
  test('anthropic 16000 (thinking shares it); local and unknown keep 4096', () => {
    expect(evalMaxTokensFor('anthropic')).toBe(16000);
    expect(evalMaxTokensFor('local')).toBe(4096);
    expect(evalMaxTokensFor(undefined)).toBe(4096);
    expect(EVAL_DECODING).toEqual({ temperature: 0, maxTokens: 4096 });
  });
});

describe('lib/provenance — the thinking and effort slots', () => {
  const base = { provider: 'local', model: 'qwen-test', promptVersion: 'p', rubricVersion: 'r', temperature: 0, maxTokens: 4096 };

  test('absent thinking/effort leave both the record and the fingerprint exactly as before', () => {
    const p = buildProvenance(base);
    expect(p.decoding).not.toHaveProperty('thinking');
    expect(p.decoding).not.toHaveProperty('effort');
    expect(buildProvenance({ ...base, thinking: null, effort: null }).config_fingerprint).toBe(p.config_fingerprint);
  });

  test('a sent thinking mode and a sent effort are each recorded and each move the fingerprint', () => {
    const cloud = { ...base, provider: 'anthropic', model: 'claude-sonnet-5-5', temperature: null, maxTokens: 16000 };
    const none = buildProvenance(cloud);
    const thinking = buildProvenance({ ...cloud, thinking: 'adaptive' });
    const both = buildProvenance({ ...cloud, thinking: 'adaptive', effort: 'high' });
    const other = buildProvenance({ ...cloud, thinking: 'adaptive', effort: 'xhigh' });
    expect(both.decoding).toMatchObject({ thinking: 'adaptive', effort: 'high' });
    expect(new Set([none, thinking, both, other].map((p) => p.config_fingerprint)).size).toBe(4);
  });
});

describe('POST /evaluate records the decoding the provider SENT, and sends the per-provider ceiling', () => {
  const app = require('../src/index');
  const { callAI, resolveProviderName } = require('../src/services/ai');
  const VALID = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: {} };
  const body = { ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }] };
  const reply = (extra) => ({ text: JSON.stringify(VALID), inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ...extra });

  beforeEach(() => { callAI.mockReset(); resolveProviderName.mockReset(); });

  test('anthropic on sonnet-5-5: max_tokens 16000; temperature null, thinking adaptive, effort high, though 0 was still requested', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValueOnce(reply({ provider: 'anthropic', model: 'claude-sonnet-5-5', decoding: { temperature: null, thinking: 'adaptive', effort: 'high' } }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(callAI.mock.calls[0][0]).toMatchObject({ temperature: 0, maxTokens: 16000 });   // the request
    expect(res.body.provenance.decoding).toMatchObject({ temperature: null, max_tokens: 16000, thinking: 'adaptive', effort: 'high' });
    expect(res.body.model_version).toBe('CCME_LLM_v8.0+claude-sonnet-5-5');
  });

  test('local: max_tokens 4096, temperature 0 as sent, no thinking or effort slot (fingerprint unchanged)', async () => {
    resolveProviderName.mockResolvedValue('local');
    callAI.mockResolvedValueOnce(reply({ provider: 'local', model: 'qwen-test', decoding: { temperature: 0, thinking: null, effort: null } }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(callAI.mock.calls[0][0].maxTokens).toBe(4096);
    expect(res.body.provenance.decoding.temperature).toBe(0);
    expect(res.body.provenance.decoding.max_tokens).toBe(4096);
    expect(res.body.provenance.decoding).not.toHaveProperty('thinking');
    expect(res.body.provenance.decoding).not.toHaveProperty('effort');
  });

  test('a provider that reports nothing is recorded as null, never as the requested value', async () => {
    resolveProviderName.mockResolvedValue('anthropic');
    callAI.mockResolvedValueOnce(reply({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(res.body.provenance.decoding.temperature).toBeNull();
  });
});
