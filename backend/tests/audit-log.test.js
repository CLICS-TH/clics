// Audit trail (CLICS §9.4): scoring actions are recorded, and oversight can read the log.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/auditor', require('../src/routes/auditor'));
// Mounted at '/admin' because that is where src/index.js mounts it. A test app free to pick its
// own prefix is how three screens shipped calling a path production does not serve — see
// tests/api-contract.test.js.
app.use('/admin', require('../src/routes/superadmin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const AUDITOR = { id: 'aud1', role: 'auditor', council_id: 'cA', status: 'active', email: 'a@t', consented_at: '2026-01-01T00:00:00Z' };
const SUPER = { id: 'sa', role: 'superadmin', council_id: null, status: 'active', email: 's@t' };
// The route requires the approved form's pre-submit confirmations. Derived from the schema rather
// than duplicated, so a change to the checklist does not incidentally break a suite that is not
// about the checklist at all.
const { SCORE_ATTESTATIONS } = require('../src/lib/schemas');
const ATTEST = Object.fromEntries(SCORE_ATTESTATIONS.map((k) => [k, true]));
const FULL = { ...{ d1: 4, d2: 4, d3: 4, d4: 4, d5: 4, d6: 4, d7: 4 }, attestations: ATTEST };

beforeEach(() => m.reset());

test('submitting an auditor score writes an audit_log row (action audit.score)', async () => {
  m.state.caller = AUDITOR;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples') return { id: 'u1', auditor_id: 'aud1', council_id: 'cA', physician_id: 'phys9' };
    if (table === 'audit_scores' && kind === 'single') return null; // no existing score
    return undefined; // audit_scores insert / audit_log insert → ok
  };
  const r = await auth(request(app).post('/auditor/ples/u1/score')).send(FULL);
  expect(r.status).toBe(200);
  const logged = m.find('audit_log', 'insert');
  expect(logged).toBeDefined();
  expect(logged.payload).toMatchObject({ action: 'audit.score', target_type: 'ple', target_id: 'u1' });
});

test('GET /superadmin/audit-log returns the events newest-first', async () => {
  m.state.caller = SUPER;
  m.state.resolve = (table, kind) => {
    if (table === 'audit_log' && kind === 'list') return { data: [{ id: 'e1', action: 'export' }], count: 1 };
    return undefined;
  };
  const r = await auth(request(app).get('/admin/audit-log'));
  expect(r.status).toBe(200);
  expect(r.body.events[0].action).toBe('export');
  expect(r.body.total).toBe(1);
});

// Two contracts, side by side. logEvent stays fail-soft for its ~40 callers (a logging failure must
// never break the action it records). logEventStrict is for the lock and unlock of the PIS-7
// evaluator, where the entry IS part of the action: it reports the failure so the caller can undo.
describe('logEvent vs logEventStrict', () => {
  const { logEvent, logEventStrict } = require('../src/lib/audit');
  const { supabase } = require('../src/lib/supabase');
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { console.error.mockRestore(); });
  const event = { actorId: 'sa', actorRole: 'superadmin', action: 'evaluator_lock', metadata: { locked: false } };

  test('strict: success is { ok: true }, and the row is the same row logEvent writes', async () => {
    m.state.resolve = () => undefined;
    expect(await logEventStrict(event)).toEqual({ ok: true });
    await logEvent(event);
    const [a, b] = m.all('audit_log', 'insert');
    expect(a.payload).toEqual(b.payload);
    expect(a.payload).toMatchObject({ actor_id: 'sa', actor_role: 'superadmin', action: 'evaluator_lock', target_type: null });
  });

  test('strict: an insert error comes back as { error } — logEvent swallows the same error', async () => {
    m.state.resolve = (t, kind) => (t === 'audit_log' && kind === 'insert' ? { error: { message: 'append-only trigger refused' } } : undefined);
    expect(await logEventStrict(event)).toEqual({ error: { message: 'append-only trigger refused' } });
    await expect(logEvent(event)).resolves.toBeUndefined();
  });

  test('strict: a throw comes back as { error } too, never as a rejection', async () => {
    const real = supabase.from;
    supabase.from = () => { throw new Error('client not initialised'); };
    try {
      expect(await logEventStrict(event)).toEqual({ error: { message: 'client not initialised' } });
      await expect(logEvent(event)).resolves.toBeUndefined();
    } finally { supabase.from = real; }
  });
});
