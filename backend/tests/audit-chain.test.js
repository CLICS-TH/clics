// Hash-chained audit_log, read side: GET /oversight/audit-log/verify and the informational
// audit_chain entry in /health/deep. The chain is computed by a database trigger, so what is tested
// here is how the backend reports the database's own verdict — including before the migration is
// applied, which must read `not_installed`, never a pass — and an unanchored pass is `consistent`, never
// `intact`, because a walk alone cannot see a truncated tail or a re-hashed chain. The SQL itself is exercised against a
// real Postgres by scripts/db/audit-chain-tamper-test.sh.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/services/rimpl-client', () => ({ probeRimplDeep: jest.fn() }));
jest.mock('../src/services/eval-drain', () => ({ status: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { supabase, __mock: m } = require('../src/lib/supabase');
const { probeRimplDeep } = require('../src/services/rimpl-client');
const evalDrain = require('../src/services/eval-drain');
const { invalidateScope } = require('../src/lib/eval-scope');

const app = express();
app.use(express.json());
app.use('/oversight', require('../src/routes/oversight'));
app.use('/health', require('../src/routes/health'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const ETHICS = { id: 'eth', role: 'ethics', council_id: null, status: 'active', email: 'e@t' };
const ANALYST = { id: 'an', role: 'analyst', council_id: null, status: 'active', email: 'an@t' };
const SUPER = { id: 'sa', role: 'superadmin', council_id: null, status: 'active', email: 's@t' };
const HASH = 'ab'.repeat(32);
const MISSING = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.audit_log_verify' } };

let rpc;
beforeEach(() => {
  m.reset();
  rpc = jest.spyOn(supabase, 'rpc');
});
afterEach(() => rpc.mockRestore());

describe('GET /oversight/audit-log/verify', () => {
  test('unanchored pass → consistent (NOT intact), with the limit spelled out', async () => {
    m.state.caller = ETHICS;
    rpc.mockResolvedValue({ data: [{ ok: true, checked: 52, first_bad_seq: null, reason: null, head_seq: 52, head_hash: HASH, anchored: false }], error: null });
    const r = await auth(request(app).get('/oversight/audit-log/verify'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'consistent', anchored: false, checked: 52, first_bad_seq: null, head_seq: 52, head_hash: HASH });
    expect(r.body.limits).toMatch(/truncated tail/);
    expect(rpc).toHaveBeenCalledWith('audit_log_verify', {});
  });

  test('anchored pass → intact; the anchor is forwarded lower-cased', async () => {
    m.state.caller = SUPER;
    rpc.mockResolvedValue({ data: [{ ok: true, checked: 60, first_bad_seq: null, reason: null, head_seq: 60, head_hash: HASH, anchored: true }], error: null });
    const r = await auth(request(app).get(`/oversight/audit-log/verify?anchor_seq=52&anchor_hash=${HASH.toUpperCase()}`));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('intact');
    expect(r.body.anchored).toBe(true);
    expect(r.body.limits).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('audit_log_verify', { p_anchor_seq: 52, p_anchor_hash: HASH });
  });

  test('a cut tail against an anchor → broken truncated_below_anchor', async () => {
    m.state.caller = ETHICS;
    rpc.mockResolvedValue({ data: [{ ok: false, checked: 6, first_bad_seq: 7, reason: 'truncated_below_anchor', head_seq: null, head_hash: null, anchored: false }], error: null });
    const r = await auth(request(app).get(`/oversight/audit-log/verify?anchor_seq=9&anchor_hash=${HASH}`));
    expect(r.body).toMatchObject({ status: 'broken', reason: 'truncated_below_anchor', first_bad_seq: 7 });
  });

  test.each([
    ['anchor_seq=0&anchor_hash=' + 'ab'.repeat(32)],
    ['anchor_seq=5&anchor_hash=nothex'],
    ['anchor_seq=5'],
    ['anchor_hash=' + 'ab'.repeat(32)],
  ])('malformed anchor (%s) → 400, no rpc', async (qs) => {
    m.state.caller = ETHICS;
    const r = await auth(request(app).get(`/oversight/audit-log/verify?${qs}`));
    expect(r.status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith('audit_log_verify', expect.anything());
  });

  test('broken chain → still 200, names the first bad row (the finding is the answer)', async () => {
    m.state.caller = SUPER;
    rpc.mockResolvedValue({ data: [{ ok: false, checked: 8, first_bad_seq: 8, reason: 'seq_gap', head_seq: null, head_hash: null, anchored: false }], error: null });
    const r = await auth(request(app).get('/oversight/audit-log/verify'));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('broken');
    expect(r.body.first_bad_seq).toBe(8);
    expect(r.body.reason).toBe('seq_gap');
  });

  test('migration not applied → not_installed, never intact', async () => {
    m.state.caller = ETHICS;
    rpc.mockResolvedValue(MISSING);
    const r = await auth(request(app).get('/oversight/audit-log/verify'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'not_installed' });
  });

  test('a relation/column error is an error, not not_installed', async () => {
    m.state.caller = ETHICS;
    rpc.mockResolvedValue({ data: null, error: { code: '42703', message: 'column "seq" does not exist' } });
    const r = await auth(request(app).get('/oversight/audit-log/verify'));
    expect(r.status).toBe(500);
  });

  test('database error → 500, not a pass', async () => {
    m.state.caller = ETHICS;
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const r = await auth(request(app).get('/oversight/audit-log/verify'));
    expect(r.status).toBe(500);
    expect(r.body.status).toBe('error');
  });

  test('analyst cannot verify (same roles as the log itself)', async () => {
    m.state.caller = ANALYST;
    const r = await auth(request(app).get('/oversight/audit-log/verify'));
    expect(r.status).toBe(403);
    expect(rpc).not.toHaveBeenCalledWith('audit_log_verify', expect.anything());
  });
});

describe('/health/deep audit_chain (informational)', () => {
  const IDLE = { running: false, in_flight: 0, last_tick_at: null, last_error: null,
    counters: { claimed: 0, evaluated: 0, deferred: 0, flagged: 0 }, lease_s: 300, max_attempts: 3, scope: null };
  beforeEach(() => {
    m.state.resolve = (table) => (table === 'professionals' ? { count: 1, error: null } : undefined);
    probeRimplDeep.mockResolvedValue({ httpStatus: 200, body: { status: 'ok', checks: {} } });
    evalDrain.status.mockReturnValue(IDLE);
    invalidateScope();
  });

  test('reports the head seq + hash', async () => {
    rpc.mockImplementation((name) => Promise.resolve(name === 'audit_log_head'
      ? { data: [{ head_seq: 52, head_hash: HASH, head_at: '2026-10-14T08:00:00Z' }], error: null }
      : { data: null, error: null }));
    const r = await request(app).get('/health/deep');
    expect(r.body.checks.audit_chain).toEqual({ status: 'up', head_seq: 52, head_hash: HASH, head_at: '2026-10-14T08:00:00Z' });
    expect(r.status).toBe(200);
  });

  test('not installed or erroring never flips the verdict', async () => {
    rpc.mockImplementation((name) => Promise.resolve(name === 'audit_log_head' ? MISSING : { data: null, error: null }));
    let r = await request(app).get('/health/deep');
    expect(r.body.checks.audit_chain).toEqual({ status: 'not_installed' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');

    rpc.mockImplementation((name) => Promise.resolve(name === 'audit_log_head'
      ? { data: null, error: { code: 'XX000', message: 'boom' } } : { data: null, error: null }));
    r = await request(app).get('/health/deep');
    expect(r.body.checks.audit_chain.status).toBe('error');
    expect(r.status).toBe(200);
  });
});
