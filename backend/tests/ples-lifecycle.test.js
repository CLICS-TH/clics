// Physician PLE lifecycle: create (consent + budget + ownsFolder + council denormalization),
// rename/move, delete. (The /end PLE-gate transitions are covered by ple-end.test.js.)
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/lib/usage', () => ({
  // The token ceiling (local AI) and the combined $/token verdict — see lib/usage.js budgetState.
  effectiveTokenLimit: async () => null,
  budgetState: async (user) => { const cost = Number(user?.usage_cost_usd ?? 0); return { over: cost >= 0.5, reason: cost >= 0.5 ? 'cost' : null, limit: 0.5, tokenLimit: null, cost, tokens: 0 }; },
  effectiveLimit: jest.fn(async () => 0.5),
  reserveUsage: jest.fn(async () => ({ ok: true, applied: true })),
  accrueUsage: jest.fn(async () => ({ cost: 0, error: null })), // the message route settles via accrueUsage(costOverride)
  settleUsage: jest.fn(async () => {}),
  refundUsage: jest.fn(async () => {}),
  RESERVE_ESTIMATE_USD: 0.01,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN, COUNCIL_A } = require('./helpers/roles');

const plesRouter = require('../src/routes/ples');
const app = express();
app.use(express.json());
app.use('/ples', plesRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');
const FOLDER_UUID = '33333333-3333-3333-3333-333333333333';

let pleRow, folderOwned, passedCount, pilotFlag, t1RemedFlag;
beforeEach(() => {
  m.reset();
  m.state.caller = { ...PHYSICIAN }; // consented, usage_cost_usd 0
  pleRow = undefined;
  folderOwned = true;
  passedCount = 0;            // # of the physician's prior COMPLETED PLEs (drives episode_number)
  pilotFlag = 0;             // app_settings.pilot_test_mode (0 = off)
  t1RemedFlag = 0;           // app_settings.t1_remediation_enabled (0 = off, the protocol default)
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') {
      // Keyed by name, with an explicit default of 0 for anything unlisted. A catch-all that
      // returned pilotFlag for every key silently switched ON whatever setting was added next —
      // observed: turning on pilot mode also turned on the identity gate, and the failure surfaced
      // as an unrelated 403.
      const key = (ctx.eqs.find(e => e[0] === 'key') || [])[1];
      if (key === 'pilot_test_mode') return { value: pilotFlag };
      if (key === 't1_remediation_enabled') return { value: t1RemedFlag };
      return { value: 0 };
    }
    if (table === 'ples') {
      // The episode-count probe: select(head) filtered to the COMPLETED statuses → return the count.
      // It matches on .in('status', [...]) because 'ple_pass' alone is a transient state that a
      // scored PLE leaves immediately — see backend/src/lib/ple-status.js.
      if (ctx.op === 'select' && kind === 'list' && ctx.ins.some(i => i[0] === 'status')) {
        return { data: [], count: passedCount };
      }
      if (ctx.op === 'insert') return { id: 'p-new', ...ctx.payload };
      if (ctx.op === 'update') return pleRow;                 // PATCH .single()
      if (ctx.op === 'select' && kind === 'single') return pleRow; // fetchOwnedPle (delete)
      return undefined;                                       // delete → ok
    }
    if (table === 'ple_folders') return folderOwned ? { id: FOLDER_UUID } : null; // ownsFolder
    return undefined; // lpdp_snapshots delete / ple_patient_refs insert → ok
  };
});

test('create: denormalizes council_id from the physician and starts active → 201', async () => {
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'Chest pain' });
  expect(r.status).toBe(201);
  const ins = m.find('ples', 'insert');
  expect(ins.payload).toMatchObject({
    physician_id: 'phys-1', council_id: COUNCIL_A, status: 'active',
    chief_complaint: 'Chest pain', title: 'Chest pain',
  });
});

test('create CLE1 (no prior passes) → episode 1, natural (no Socratic)', async () => {
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('ples', 'insert').payload).toMatchObject({
    episode_number: 1, socratic_active: false, socratic_reason: null,
  });
});

test('create CLE3 (2 prior passes) → episode 3, natural again', async () => {
  passedCount = 2;
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('ples', 'insert').payload).toMatchObject({
    episode_number: 3, socratic_active: false, socratic_reason: null,
  });
});

test('3 consecutive Tier-1 fails + remediation ENABLED → Socratic remediation', async () => {
  t1RemedFlag = 1; // off by default; a superadmin has deliberately switched it on
  m.state.caller = { ...PHYSICIAN, consecutive_t1_fails: 3 };
  passedCount = 0; // episode 1, but remediation kicks in
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('ples', 'insert').payload).toMatchObject({
    episode_number: 1, socratic_active: true, socratic_reason: 't1_remediation',
  });
});

test('the episode probe spans BOTH completed statuses, not just the transient ple_pass', async () => {
  // Regression: this counted with .eq('status','ple_pass'). A scored PLE is flipped to 'evaluated'
  // within seconds of screening, so production never had a row resting at 'ple_pass' — the probe
  // counted 0 for everyone, episode_number stuck at 1, and the protocol's <=3 cap never fired.
  // The same filter drove the compensation pipeline, which therefore reported 0 THB owed.
  await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  const probe = m.find('ples', 'select');
  expect(probe.ins).toContainEqual(['status', ['ple_pass', 'evaluated']]);
  expect(probe.eqs).not.toContainEqual(['status', 'ple_pass']);
});

test('no episode opens in Socratic mode — the protocol has no randomised arm', async () => {
  // CREC082 (PLE Instruction Sheet §4, ICF §3): Socratic is a mid-session rescue, "not an
  // experimental arm". An earlier build allocated one of the 3 episodes by hashing the physician id
  // and opened it in examiner mode from turn 1. Every episode must now start natural.
  // No m.reset() in here — it also clears state.resolve, which would strand the next request.
  // The mock accumulates queries, so m.all() gives one insert per episode, in order.
  for (const prior of [0, 1, 2]) {
    passedCount = prior;
    const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
    expect(r.status).toBe(201);
  }
  const inserts = m.all('ples', 'insert');
  expect(inserts).toHaveLength(3);
  inserts.forEach((ins, i) => expect(ins.payload).toMatchObject({
    episode_number: i + 1, socratic_active: false, socratic_reason: null,
  }));
  // ...and nothing is written back to the physician to remember an allocation.
  expect(m.find('professionals', 'update')).toBeUndefined();
});

test('3 consecutive Tier-1 fails with remediation OFF (the default) → still natural', async () => {
  // Not in the approved protocol, so it must not fire unless someone switched it on.
  m.state.caller = { ...PHYSICIAN, consecutive_t1_fails: 5 };
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('ples', 'insert').payload).toMatchObject({ socratic_active: false, socratic_reason: null });
});

test('create a 4th PLE after the 3 study PLEs have passed → 403 ple_limit_reached, no insert', async () => {
  passedCount = 3;
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('ple_limit_reached');
  expect(m.find('ples', 'insert')).toBeUndefined();
});

test('Pilot Test Mode: bypasses the 3-PLE cap, marks is_test, and honors a Socratic override', async () => {
  pilotFlag = 1;        // pilot mode ON
  passedCount = 3;      // would normally be ple_limit_reached
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x', socratic: true });
  expect(r.status).toBe(201);
  expect(m.find('ples', 'insert').payload).toMatchObject({
    is_test: true, socratic_active: true, socratic_reason: 'pilot_test',
  });
});

test('Pilot Test Mode off: the socratic override is ignored (normal episode logic)', async () => {
  pilotFlag = 0;
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x', socratic: true });
  expect(r.status).toBe(201);
  const ins = m.find('ples', 'insert').payload;
  expect(ins.socratic_reason).toBeNull();   // episode 1 natural, override ignored
  expect(ins.is_test).toBeUndefined();
});

test('create without recorded consent → 403 consent_required', async () => {
  m.state.caller = { ...PHYSICIAN, consented_at: null };
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('consent_required');
  expect(m.find('ples', 'insert')).toBeUndefined();
});

test('create when the AI budget is already spent → 403 budget_exceeded', async () => {
  m.state.caller = { ...PHYSICIAN, usage_cost_usd: 1 }; // >= effectiveLimit (0.5)
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('budget_exceeded');
});

test('create with no chief_complaint → 400 (zod)', async () => {
  const r = await auth(request(app).post('/ples')).send({});
  expect(r.status).toBe(400);
});

test('create into a folder the physician does not own → 403', async () => {
  folderOwned = false;
  const r = await auth(request(app).post('/ples')).send({ chief_complaint: 'x', folder_id: FOLDER_UUID });
  expect(r.status).toBe(403);
  expect(m.find('ples', 'insert')).toBeUndefined();
});

test('rename/move an owned PLE → 200, ownership pinned in the query', async () => {
  pleRow = { id: 'p1', title: 'Renamed', folder_id: null, status: 'evaluated' };
  const r = await auth(request(app).patch('/ples/p1')).send({ title: 'Renamed' });
  expect(r.status).toBe(200);
  expect(m.find('ples', 'update').eqs).toContainEqual(['physician_id', 'phys-1']);
});

test("rename a PLE that isn't the caller's → 404", async () => {
  pleRow = null;
  const r = await auth(request(app).patch('/ples/p-foreign')).send({ title: 'x' });
  expect(r.status).toBe(404);
});

test('delete an owned PLE → 200 {ok:true}', async () => {
  pleRow = { id: 'p1' };
  const r = await auth(request(app).delete('/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
});

test('delete a PLE that isn\'t the caller\'s → 404', async () => {
  pleRow = null;
  const r = await auth(request(app).delete('/ples/p-foreign'));
  expect(r.status).toBe(404);
});
