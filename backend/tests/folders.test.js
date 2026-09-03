// Folder CRUD route tests (was an uncovered path). Hermetic — Supabase mocked via the shared helper.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN, AUDITOR } = require('./helpers/roles');

const foldersRouter = require('../src/routes/folders');
const app = express();
app.use(express.json());
app.use('/ples/folders', foldersRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

let folderRow; // PATCH .single() result (null → 404)
let delRows;   // DELETE .select('id') result ([] → 404)

beforeEach(() => {
  m.reset();
  m.state.caller = PHYSICIAN;
  folderRow = undefined;
  delRows = undefined;
  m.state.resolve = (table, _kind, ctx) => {
    if (table !== 'ple_folders') return undefined;
    if (ctx.op === 'insert') return { id: 'f-new', name: ctx.payload.name, sort_order: 0, created_at: 't' };
    if (ctx.op === 'update') return folderRow;
    if (ctx.op === 'delete') return delRows;
    return []; // GET list
  };
});

test('POST creates a folder scoped to the caller → 201', async () => {
  const r = await auth(request(app).post('/ples/folders')).send({ name: 'Cardio' });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ id: 'f-new', name: 'Cardio' });
  const ins = m.find('ple_folders', 'insert');
  expect(ins.payload).toEqual({ physician_id: 'phys-1', name: 'Cardio' });
});

test('POST with an empty name → 400 (zod)', async () => {
  const r = await auth(request(app).post('/ples/folders')).send({ name: '' });
  expect(r.status).toBe(400);
  expect(m.find('ple_folders', 'insert')).toBeUndefined();
});

test('GET lists the caller folders → 200', async () => {
  const r = await auth(request(app).get('/ples/folders'));
  expect(r.status).toBe(200);
  expect(Array.isArray(r.body)).toBe(true);
  expect(m.find('ple_folders').eqs).toContainEqual(['physician_id', 'phys-1']);
});

test('PATCH rename of an owned folder → 200, ownership pinned in the query', async () => {
  folderRow = { id: 'f1', name: 'Renamed', sort_order: 0, created_at: 't' };
  const r = await auth(request(app).patch('/ples/folders/f1')).send({ name: 'Renamed' });
  expect(r.status).toBe(200);
  expect(r.body.name).toBe('Renamed');
  const upd = m.find('ple_folders', 'update');
  expect(upd.eqs).toContainEqual(['id', 'f1']);
  expect(upd.eqs).toContainEqual(['physician_id', 'phys-1']);
});

test("PATCH a folder that isn't the caller's → 404", async () => {
  folderRow = null; // not found / not owned
  const r = await auth(request(app).patch('/ples/folders/f-foreign')).send({ name: 'x' });
  expect(r.status).toBe(404);
});

test('DELETE an owned folder → 200 {ok:true}', async () => {
  delRows = [{ id: 'f1' }];
  const r = await auth(request(app).delete('/ples/folders/f1'));
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true });
  expect(m.find('ple_folders', 'delete').eqs).toContainEqual(['physician_id', 'phys-1']);
});

test('DELETE a folder that isn\'t the caller\'s → 404', async () => {
  delRows = [];
  const r = await auth(request(app).delete('/ples/folders/f-foreign'));
  expect(r.status).toBe(404);
});

test('a non-physician (auditor, no can_audit) is blocked by requireRole → 403', async () => {
  m.state.caller = AUDITOR;
  const r = await auth(request(app).get('/ples/folders'));
  expect(r.status).toBe(403);
});
