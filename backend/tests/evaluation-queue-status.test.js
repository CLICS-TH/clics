// GET /ples/:id/evaluation while the score is still coming: the 202 body names the phase and, for a
// queued session, its position + ETA from eval_enqueued_at order — so a physician under load sees
// "position N, ~M min" instead of a frozen "Evaluating…". Every lookup is fail-soft.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = r => r.set('Authorization', 'Bearer test');
const physician = { id: 'doc1', role: 'physician', status: 'active', consented_at: '2026-06-07T00:00:00Z' };

function wire(ple, { ahead = 0, settings = {} } = {}) {
  m.reset();
  m.state.caller = physician;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples') {
      if (kind === 'list') return { data: null, count: ahead };            // the "rows ahead of me" count
      return { id: 'ple1', physician_id: 'doc1', ...ple };
    }
    if (table === 'app_settings') { const v = settings[ctx.id('key')]; return v == null ? null : { value: v }; }
    return undefined;
  };
}

test("'ended' → 202 phase screening (tier-2 still running)", async () => {
  wire({ status: 'ended' });
  const res = await auth(request(app).get('/ples/ple1/evaluation'));
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ status: 'ended', phase: 'screening' });
});

test('ple_pass, unclaimed → 202 phase queued with position/ahead/eta from the queue order', async () => {
  wire({ status: 'ple_pass', eval_enqueued_at: '2026-09-01T10:00:00Z', eval_claimed_at: null, eval_attempts: 0 },
    { ahead: 3, settings: { eval_drain_concurrency: 2, eval_p50_seconds: 90 } });
  const res = await auth(request(app).get('/ples/ple1/evaluation'));
  expect(res.status).toBe(202);
  expect(res.body.phase).toBe('queued');
  expect(res.body.queue).toEqual({ position: 4, ahead: 3, eta_s: 180, attempts: 0 }); // ceil(4/2)=2 × 90s
  const countQ = m.all('ples', 'select').find((q) => q.selectArgs?.[1]?.count === 'exact');
  expect(countQ.eqs).toEqual(expect.arrayContaining([['status', 'ple_pass']]));
});

test('ple_pass, claimed within the lease → 202 phase scoring', async () => {
  wire({ status: 'ple_pass', eval_enqueued_at: '2026-09-01T10:00:00Z', eval_claimed_at: new Date().toISOString(), eval_attempts: 1 });
  const res = await auth(request(app).get('/ples/ple1/evaluation'));
  expect(res.status).toBe(202);
  expect(res.body.phase).toBe('scoring');
  expect(res.body.queue.attempts).toBe(1);
});

test('ple_pass with a STALE claim (lease expired) reads as queued again', async () => {
  wire({ status: 'ple_pass', eval_enqueued_at: '2026-09-01T10:00:00Z', eval_claimed_at: '2026-01-01T00:00:00Z', eval_attempts: 2 });
  const res = await auth(request(app).get('/ples/ple1/evaluation'));
  expect(res.body.phase).toBe('queued');
});

test('a failing position lookup degrades to the bare phase, never a 500', async () => {
  wire({ status: 'ple_pass', eval_enqueued_at: '2026-09-01T10:00:00Z', eval_claimed_at: null, eval_attempts: 0 });
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'list') throw new Error('db hiccup');
    if (table === 'ples') return { id: 'ple1', physician_id: 'doc1', status: 'ple_pass', eval_enqueued_at: '2026-09-01T10:00:00Z' };
    return undefined;
  };
  const res = await auth(request(app).get('/ples/ple1/evaluation'));
  expect(res.status).toBe(202);
  expect(res.body).toMatchObject({ status: 'ple_pass', phase: 'queued' });
  expect(res.body.queue).toBeUndefined();
});
