// The integrity detector runs AUTOMATICALLY now, and its findings are DATA rather than log lines.
//
// Both halves of this shipped broken in the same way: the code existed and nothing invoked it.
// services/integrity.js scored copy-paste and machine rhythm perfectly, but the only caller was an
// admin button, so production held zero flag rows and zero scanned sessions — CREC082 §1's exclusion
// of "passive copying of AI answers" was, in practice, unenforced. And the rescue post-check
// (CREC082 §4: 1-2 non-leading questions, no diagnosis) reported violations to console.error, which
// answers the ethics committee's question only for as long as the host keeps its logs.
//
// So this suite pins the WIRING, not the detection — tests/integrity-signals.test.js owns the
// arithmetic. What matters here: it runs unprompted, it cannot cost a physician their session, and
// a re-scan does not erase the flags it did not raise.

jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/middleware/auth', () => ({
  verifyJwt: (req, _res, next) => { req.user = { id: 'doc1', role: 'physician', consented_at: '2026-01-01T00:00:00Z', usage_cost_usd: 0 }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/lib/db-helpers', () => ({
  fetchOwnedPle: () => Promise.resolve({ data: mockPle }),
  ownsFolder: () => Promise.resolve(true),
  sendDbError: () => false,
}));
jest.mock('../src/lib/settings', () => ({
  transcriptCap: async () => ({ limit: 64000, warnPct: 80 }),
  pilotTestMode: async () => false,
  clinicalArtifactsEnabled: async () => false,
  chatEvidenceMarkerEnabled: async () => false,
  chatRouterEnabled: async () => false,
  holdResultUntilAudited: async () => false,
  t1RemediationEnabled: async () => false,
  identityVerificationRequired: async () => false,
  reflectionRequired: async () => false,   // finalise inline; the reflection gate has its own suite
  creditSettings: async () => ({}),
}));
jest.mock('../src/services/ple-finalize', () => ({
  finalizeScreening: async () => ({ status: 'ple_pass' }),
  toPassCols: (crit) => Object.fromEntries(Object.entries(crit).map(([k, v]) => [`${k}_pass`, v])),
}));
const mockChat = jest.fn();
jest.mock('../src/services/rimpl-client', () => ({ rimplChat: (...a) => mockChat(...a) }));
jest.mock('../src/lib/usage', () => ({
  // The token ceiling (local AI) and the combined $/token verdict — see lib/usage.js budgetState.
  effectiveTokenLimit: async () => null,
  budgetState: async (user) => { const cost = Number(user?.usage_cost_usd ?? 0); return { over: cost >= 1, reason: cost >= 1 ? 'cost' : null, limit: 1, tokenLimit: null, cost, tokens: 0 }; },
  effectiveLimit: async () => 1,
  reserveUsage: async () => ({ ok: true, applied: true }),
  refundUsage: async () => {}, accrueUsage: async () => ({ cost: 0, error: null }),
  RESERVE_ESTIMATE_USD: 0.02,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { DETECTOR_SIGNALS } = require('../src/services/integrity-scan');
const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));

let mockPle;
let flagsError;   // forced failure on the flag write, to prove /end survives it

// Long enough to clear F1's 40-char floor, and identical, so the detector has something to find.
const PASTED = 'The patient presents with acute chest pain radiating to the left arm, diaphoresis and dyspnoea.';
const t = (n) => new Date(Date.UTC(2026, 7, 27, 10, n)).toISOString();

beforeEach(() => {
  m.reset();
  mockChat.mockReset();
  flagsError = null;
  mockPle = { id: 'ple1', status: 'active', physician_id: 'doc1', council_id: 'c1',
    started_at: t(0), turn_count: 4, token_count: 4000, ple_code: 'PLE-001' };

  m.state.caller = { id: 'doc1', role: 'physician', status: 'active', consented_at: t(0), usage_cost_usd: 0 };
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples' && kind === 'update') return [{ id: 'ple1' }];           // the atomic claim
    if (table === 'ples' && kind === 'single') return mockPle;
    if (table === 'ples' && kind === 'list') return [{ id: 'ple2' }];             // the F2 corpus
    if (table === 'messages' && ctx.ins.length) return [{ ple_id: 'ple2', content: 'unrelated prior turn' }];
    if (table === 'messages' && kind === 'list') return [
      { role: 'physician', content: PASTED,       created_at: t(1), token_count: 30 },
      { role: 'assistant', content: 'And then?',  created_at: t(2), token_count: 20 },
      { role: 'physician', content: PASTED,       created_at: t(3), token_count: 30 },
    ];
    if (table === 'ple_integrity_flags') return flagsError ? { error: { message: 'flags table is down' } } : {};
    return undefined;
  };
});

const end = () => request(app).post('/ples/ple1/end').set('Authorization', 'Bearer t').send({ active_seconds: 900 });
const written = () => m.all('ple_integrity_flags', 'upsert').flatMap(q => [].concat(q.payload));

describe('POST /ples/:id/end scans the session without being asked', () => {
  test('a transcript with a pasted duplicate is flagged, and the flag is persisted', async () => {
    expect((await end()).status).toBe(200);
    expect(written().map(f => f.signal)).toContain('F1_NEAR_DUPLICATE');
    expect(written()[0]).toMatchObject({ ple_id: 'ple1' });
  });

  test('an unscorable session is scanned too — "every ended session was scanned" stays true', async () => {
    m.state.resolve = ((prev) => (table, kind, ctx) =>
      (table === 'messages' && kind === 'list' && !ctx.ins.length) ? [] : prev(table, kind, ctx))(m.state.resolve);
    expect((await end()).body.status).toBe('ple_fail_t1');
    expect(m.all('ple_integrity_flags', 'delete').length).toBe(1);   // the scan ran; it just found nothing
  });

  test('a detector fault does NOT cost the physician the session they just finished', async () => {
    flagsError = true;
    const res = await end();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ple_pass');
  });

  test('the physician\'s OWN test sessions are excluded from the cross-session corpus', async () => {
    // Every cross-session duplicate seen in production came from the pilot team rehearsing with a
    // scripted prompt. Including those would flag the team's own testing as physician misconduct.
    await end();
    const corpus = m.all('ples', 'select').find(q => q.eqs.some(([c]) => c === 'physician_id'));
    expect(corpus.eqs).toContainEqual(['is_test', false]);
  });
});

describe('a re-scan replaces its own findings and nothing else', () => {
  test('the delete is scoped to the five detector signals, never to the whole PLE', async () => {
    await end();
    const del = m.all('ple_integrity_flags', 'delete')[0];
    expect(del.eqs).toContainEqual(['ple_id', 'ple1']);
    // A bare delete-by-ple_id would take the rescue breach below with it on every re-scan.
    expect(del.ins).toContainEqual(['signal', DETECTOR_SIGNALS]);
    expect(DETECTOR_SIGNALS).not.toContain('R1_RESCUE_REPLY_BREACH');
  });
});

describe('a rescue reply that breaks CREC082 §4 becomes a row, not a log line', () => {
  const reply = (reply_check) => ({
    content: 'You have an MI. Also: a, b, c?', refs: [], socratic_question: null,
    token_count: 100, input_tokens: 50, output_tokens: 50, provider: 'anthropic', model: 'm',
    rescue: { activated: true, reason: 'off_topic', exchanges_before: 4, qualifying: false, reply_check },
  });
  const msg = () => request(app).post('/ples/ple1/message').set('Authorization', 'Bearer t')
    .send({ message: 'hi', language: 'en' });

  test('a diagnosing, three-question rescue reply is recorded against the PLE', async () => {
    mockChat.mockResolvedValue(reply({ ok: false, questions: 3, tooManyQuestions: true, diagnostic: true }));
    expect((await msg()).status).toBe(200);   // the physician keeps the turn — the fault is ours
    expect(written()).toEqual([expect.objectContaining({
      ple_id: 'ple1', signal: 'R1_RESCUE_REPLY_BREACH', severity: 'medium',
      evidence: expect.objectContaining({ question_count: 3, too_many_questions: true, diagnostic: true }),
    })]);
  });

  test('the reply text itself is not copied into the flag — it is already in messages', async () => {
    mockChat.mockResolvedValue(reply({ ok: false, questions: 0, noQuestion: true, diagnostic: false }));
    await msg();
    expect(JSON.stringify(written()[0].evidence)).not.toContain('You have an MI');
  });

  test('a conforming rescue reply writes no flag at all', async () => {
    mockChat.mockResolvedValue(reply({ ok: true, questions: 2, diagnostic: false }));
    expect((await msg()).status).toBe(200);
    expect(written()).toEqual([]);
  });
});
