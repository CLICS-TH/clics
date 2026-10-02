// Per-turn AI provenance (db/migration-message-provenance.sql, Phase 1.4). Every stored assistant
// reply — physician chat and auditor discussion — records the provider, model and prompt version
// rimpl reports. And the physician's own transcript read must NOT return them: which AI answered is
// research provenance, and showing it would tell a physician which arm they are in.
jest.mock('../src/lib/supabase', () => {
  const base = require('./helpers/supabase-mock').makeSupabaseMock();
  // Reservations succeed; the budget path is tested elsewhere (pricing-provider.test.js).
  base.supabase.rpc = () => Promise.resolve({ data: true, error: null });
  return base;
});
const mockRimplChat = jest.fn();
const mockRimplDiscuss = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({
  rimplChat: (...a) => mockRimplChat(...a),
  rimplAuditDiscuss: (...a) => mockRimplDiscuss(...a),
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { AUDITOR, COUNCIL_A } = require('./helpers/roles');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
app.use('/auditor', require('../src/routes/auditor'));
const auth = (r) => r.set('Authorization', 'Bearer test');

const PROV = { provider: 'local', model: 'deepseek-v4-flash-dspark', prompt_version: 'chat-prompt-1a2b3c4d' };
const reply = (extra = {}) => ({
  content: 'assistant reply', refs: [], socratic_question: null,
  token_count: 120, input_tokens: 100, output_tokens: 20, ...extra,
});

describe('physician chat', () => {
  beforeEach(() => {
    m.reset();
    mockRimplChat.mockReset();
    m.state.caller = {
      id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z',
      usage_limit_usd: 0.5, usage_cost_usd: 0,
    };
    m.state.resolve = (table, kind) => {
      if (table === 'app_settings') return { value: 0 };
      if (table === 'ples' && kind === 'single') {
        return { id: 'ple1', status: 'active', physician_id: 'doc1', turn_count: 0, token_count: 0,
          input_tokens: 0, output_tokens: 0, chief_complaint: 'chest pain' };
      }
      if (table === 'messages' && kind === 'list') return [];
      return undefined;
    };
  });
  const sendTurn = () => auth(request(app).post('/ples/ple1/message')).send({ message: 'hello', language: 'en' });

  test('the assistant turn stores provider, model and prompt version', async () => {
    mockRimplChat.mockResolvedValue(reply(PROV));
    const r = await sendTurn();
    expect(r.status).toBe(200);
    const inserts = m.all('messages', 'insert').map((q) => q.payload);
    const assistant = inserts.find((p) => p.role === 'assistant');
    expect(assistant).toMatchObject(PROV);
    // The physician's own turn was produced by no model.
    expect(inserts.find((p) => p.role === 'physician').provider).toBeUndefined();
  });

  test('an older rimpl that reports nothing stores NULL, never a guess', async () => {
    mockRimplChat.mockResolvedValue(reply());
    await sendTurn();
    const assistant = m.all('messages', 'insert').map((q) => q.payload).find((p) => p.role === 'assistant');
    expect(assistant).toMatchObject({ provider: null, model: null, prompt_version: null });
  });

  test('the turn response is a whitelist: no provider, model, prompt version, fail-over or rescue', async () => {
    // It used to be a spread of rimpl's whole body, so these reached the physician's browser.
    mockRimplChat.mockResolvedValue(reply({ ...PROV, failed_over_from: 'anthropic', rescue: { rescuing: true } }));
    const r = await sendTurn();
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('assistant reply');
    for (const k of ['provider', 'model', 'prompt_version', 'failed_over_from', 'rescue', 'context_tokens']) {
      expect(r.body).not.toHaveProperty(k);
    }
  });

  test("the physician's transcript read names its columns and never includes provenance", async () => {
    await auth(request(app).get('/ples/ple1'));
    const read = m.all('messages').find((q) => q.op === 'select');
    const cols = read.selectArgs[0];
    expect(cols).not.toBe('*');
    for (const c of ['provider', 'model', 'prompt_version']) expect(cols).not.toMatch(new RegExp(`\\b${c}\\b`));
    for (const c of ['id', 'role', 'content', 'refs', 'socratic_question', 'token_count', 'created_at']) {
      expect(cols).toMatch(new RegExp(`\\b${c}\\b`));
    }
  });
});

describe('auditor discussion', () => {
  beforeEach(() => {
    m.reset();
    mockRimplDiscuss.mockReset();
    m.state.caller = AUDITOR;
    m.state.resolve = (table, kind) => {
      if (table === 'app_settings') return { value: 0 };   // reveal lock off
      if (table === 'ples') return { id: 'p1', status: 'evaluated', auditor_id: AUDITOR.id, council_id: COUNCIL_A, physician_id: 'phys-1' };
      if (table === 'audit_scores') return { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 60 };
      if (table === 'ai_evaluations') return { d1: 4, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, composite_score: 64, domain_rationale: {} };
      if (table === 'messages' || table === 'audit_discussions') return kind === 'insert' ? undefined : [];
      return undefined;
    };
  });

  test('the assistant row stores provenance; the auditor row stays NULL', async () => {
    mockRimplDiscuss.mockResolvedValue({ content: 'because…', input_tokens: 50, output_tokens: 10,
      provider: 'anthropic', model: 'claude-sonnet-4-6', prompt_version: 'discuss-prompt-9f8e7d6c' });
    const r = await auth(request(app).post('/auditor/ples/p1/discuss').send({ message: 'why d4?' }));
    expect(r.status).toBe(200);
    const [auditorRow, assistantRow] = m.find('audit_discussions', 'insert').payload;
    expect(assistantRow).toMatchObject({ role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-6',
      prompt_version: 'discuss-prompt-9f8e7d6c' });
    expect(auditorRow.role).toBe('auditor');
    expect(auditorRow.provider).toBeUndefined();
  });
});
