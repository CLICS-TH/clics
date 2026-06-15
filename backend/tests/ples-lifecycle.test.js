// Physician PLE lifecycle: create (consent + budget + ownsFolder + council denormalization),
// rename/move, delete. (The /end CLE-gate transitions are covered by ple-end.test.js.)
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
jest.mock('../src/lib/usage', () => ({
  effectiveLimit: jest.fn(async () => 0.5),
  reserveUsage: jest.fn(async () => ({ ok: true, applied: true })),
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

let pleRow, folderOwned;
beforeEach(() => {
  m.reset();
  m.state.caller = PHYSICIAN; // consented, usage_cost_usd 0
  pleRow = undefined;
  folderOwned = true;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples') {
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
