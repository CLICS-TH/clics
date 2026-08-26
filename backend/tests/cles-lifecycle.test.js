// Physician CLE lifecycle: create (consent + budget + ownsFolder + council denormalization),
// rename/move, delete. (The /end CLE-gate transitions are covered by cle-end.test.js.)
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/lib/usage', () => ({
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

const clesRouter = require('../src/routes/cles');
const app = express();
app.use(express.json());
app.use('/cles', clesRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');
const FOLDER_UUID = '33333333-3333-3333-3333-333333333333';

let cleRow, folderOwned, passedCount, pilotFlag;
beforeEach(() => {
  m.reset();
  // Pin the Socratic allocation so these tests assert the RULE ("the drawn episode runs Socratic")
  // rather than the allocation itself. Unpinned, the episode is derived from the physician's id —
  // 'phys-1' hashes to episode 1 — which would silently change what several of these tests mean.
  // The allocation itself is covered by its own test below.
  m.state.caller = { ...PHYSICIAN, socratic_episode: 2 }; // consented, usage_cost_usd 0
  cleRow = undefined;
  folderOwned = true;
  passedCount = 0;            // # of the physician's prior PASSED CLEs (drives episode_number)
  pilotFlag = 0;             // app_settings.pilot_test_mode (0 = off)
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: pilotFlag }; // pilotTestMode()
    if (table === 'cles') {
      // The episode-count probe: select(head) filtered by status='cle_pass' → return the count.
      if (ctx.op === 'select' && kind === 'list' && ctx.eqs.some(e => e[0] === 'status' && e[1] === 'cle_pass')) {
        return { data: [], count: passedCount };
      }
      if (ctx.op === 'insert') return { id: 'p-new', ...ctx.payload };
      if (ctx.op === 'update') return cleRow;                 // PATCH .single()
      if (ctx.op === 'select' && kind === 'single') return cleRow; // fetchOwnedPle (delete)
      return undefined;                                       // delete → ok
    }
    if (table === 'cle_folders') return folderOwned ? { id: FOLDER_UUID } : null; // ownsFolder
    return undefined; // lpdp_snapshots delete / cle_patient_refs insert → ok
  };
});

test('create: denormalizes council_id from the physician and starts active → 201', async () => {
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'Chest pain' });
  expect(r.status).toBe(201);
  const ins = m.find('cles', 'insert');
  expect(ins.payload).toMatchObject({
    physician_id: 'phys-1', council_id: COUNCIL_A, status: 'active',
    chief_complaint: 'Chest pain', title: 'Chest pain',
  });
});

test('create CLE1 (no prior passes) → episode 1, natural (no Socratic)', async () => {
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('cles', 'insert').payload).toMatchObject({
    episode_number: 1, socratic_active: false, socratic_reason: null,
  });
});

test('create the physician\'s ALLOCATED episode → Socratic examiner from start', async () => {
  passedCount = 1; // caller is pinned to socratic_episode 2, so episode 2 is the Socratic one
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('cles', 'insert').payload).toMatchObject({
    episode_number: 2, socratic_active: true, socratic_reason: 'randomised_examiner',
  });
});

test('create CLE3 (2 prior passes) → episode 3, natural again', async () => {
  passedCount = 2;
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('cles', 'insert').payload).toMatchObject({
    episode_number: 3, socratic_active: false, socratic_reason: null,
  });
});

test('create a natural CLE after 3 consecutive Tier-1 fails → Socratic remediation', async () => {
  // socratic_episode 2 so episode 1 is NOT the allocated one — otherwise this would assert the
  // allocation rather than the remediation path it is named for.
  m.state.caller = { ...PHYSICIAN, consecutive_t1_fails: 3, socratic_episode: 2 };
  passedCount = 0; // episode 1, but remediation kicks in
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);
  expect(m.find('cles', 'insert').payload).toMatchObject({
    episode_number: 1, socratic_active: true, socratic_reason: 't1_remediation',
  });
});

test('unallocated physician: episode is derived from their id, persisted, and stable', async () => {
  m.state.caller = { ...PHYSICIAN, socratic_episode: null }; // never allocated
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(201);

  // 'phys-1' hashes to episode 1, so their FIRST episode is the Socratic one.
  expect(m.find('cles', 'insert').payload).toMatchObject({
    episode_number: 1, socratic_active: true, socratic_reason: 'randomised_examiner',
  });

  // ...and the allocation is written back, so it survives a hash change or a replay.
  const upd = m.find('professionals', 'update');
  expect(upd.payload).toMatchObject({ socratic_episode: 1 });
  // Guarded by .is(socratic_episode, null) so a concurrent request cannot reallocate.
  expect(upd.iss).toContainEqual(['socratic_episode', null]);
});

test('create a 4th CLE after the 3 study CLEs have passed → 403 cle_limit_reached, no insert', async () => {
  passedCount = 3;
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('cle_limit_reached');
  expect(m.find('cles', 'insert')).toBeUndefined();
});

test('Pilot Test Mode: bypasses the 3-CLE cap, marks is_test, and honors a Socratic override', async () => {
  pilotFlag = 1;        // pilot mode ON
  passedCount = 3;      // would normally be cle_limit_reached
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x', socratic: true });
  expect(r.status).toBe(201);
  expect(m.find('cles', 'insert').payload).toMatchObject({
    is_test: true, socratic_active: true, socratic_reason: 'pilot_test',
  });
});

test('Pilot Test Mode off: the socratic override is ignored (normal episode logic)', async () => {
  pilotFlag = 0;
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x', socratic: true });
  expect(r.status).toBe(201);
  const ins = m.find('cles', 'insert').payload;
  expect(ins.socratic_reason).toBeNull();   // episode 1 natural, override ignored
  expect(ins.is_test).toBeUndefined();
});

test('create without recorded consent → 403 consent_required', async () => {
  m.state.caller = { ...PHYSICIAN, consented_at: null };
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('consent_required');
  expect(m.find('cles', 'insert')).toBeUndefined();
});

test('create when the AI budget is already spent → 403 budget_exceeded', async () => {
  m.state.caller = { ...PHYSICIAN, usage_cost_usd: 1 }; // >= effectiveLimit (0.5)
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('budget_exceeded');
});

test('create with no chief_complaint → 400 (zod)', async () => {
  const r = await auth(request(app).post('/cles')).send({});
  expect(r.status).toBe(400);
});

test('create into a folder the physician does not own → 403', async () => {
  folderOwned = false;
  const r = await auth(request(app).post('/cles')).send({ chief_complaint: 'x', folder_id: FOLDER_UUID });
  expect(r.status).toBe(403);
  expect(m.find('cles', 'insert')).toBeUndefined();
});

test('rename/move an owned CLE → 200, ownership pinned in the query', async () => {
  cleRow = { id: 'p1', title: 'Renamed', folder_id: null, status: 'evaluated' };
  const r = await auth(request(app).patch('/cles/p1')).send({ title: 'Renamed' });
  expect(r.status).toBe(200);
  expect(m.find('cles', 'update').eqs).toContainEqual(['physician_id', 'phys-1']);
});

test("rename a CLE that isn't the caller's → 404", async () => {
  cleRow = null;
  const r = await auth(request(app).patch('/cles/p-foreign')).send({ title: 'x' });
  expect(r.status).toBe(404);
});

test('delete an owned CLE → 200 {ok:true}', async () => {
  cleRow = { id: 'p1' };
  const r = await auth(request(app).delete('/cles/p1'));
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
});

test('delete a CLE that isn\'t the caller\'s → 404', async () => {
  cleRow = null;
  const r = await auth(request(app).delete('/cles/p-foreign'));
  expect(r.status).toBe(404);
});
