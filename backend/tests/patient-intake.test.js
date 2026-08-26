// Structured patient-identifier intake (real-PII). The identifier must be stored in the PHYSICALLY
// SEPARATE cle_patient_refs table — read only by the owning physician — and must NEVER land on the
// `cles` row, which the cloud-AI path, the auditor blind queue, and the de-identified export all
// read. This test pins that isolation (the load-bearing boundary for real patient PII).
let mockProf, mockUser;
const mockInserts = {}; // table -> last insert payload (mock-prefixed so the jest factory may close over it)

jest.mock('../src/lib/supabase', () => {
  const chain = (table, getVal) => ({
    select() { return this; },
    eq() { return this; },
    // PostgREST filters the route chains onto an update (e.g. the Socratic allocation's
    // .is('socratic_episode', null) guard). Missing here they throw inside the async handler,
    // which never answers the request — the suite times out instead of failing readably.
    is() { return this; },
    not() { return this; },
    order: () => Promise.resolve({ data: [], error: null }),
    insert(payload) { mockInserts[table] = payload; return this; },
    update() { return this; },
    single: () => Promise.resolve(getVal()),
    maybeSingle: () => Promise.resolve(getVal()),
    then: (res) => res({ data: null, error: null }), // bare `await from().insert()` resolves cleanly
  });
  return {
    supabase: {
      from: (table) => {
        if (table === 'cles') return chain(table, () => ({ data: { id: 'ple1', physician_id: 'doc1', status: 'active', chief_complaint: 'chest pain', title: 'chest pain' }, error: null }));
        if (table === 'cle_patient_refs') return chain(table, () => ({ data: null, error: null }));
        return chain(table, () => mockProf);
      },
      rpc: () => Promise.resolve({ error: null }),
    },
    authSupabase: { auth: { getUser: () => Promise.resolve(mockUser) } },
  };
});

const request = require('supertest');
const express = require('express');
const clesRouter = require('../src/routes/cles');
const app = express();
app.use(express.json());
app.use('/cles', clesRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  mockProf = { data: { id: 'doc1', role: 'physician', status: 'active', council_id: 'c1', consented_at: '2026-06-07T00:00:00Z', usage_limit_usd: 0.5, usage_cost_usd: 0.1 }, error: null };
  mockUser = { data: { user: { id: 'doc1', email: 'doc@clics.th' } }, error: null };
  for (const k in mockInserts) delete mockInserts[k];
});

test('POST /cles stores patient_ref in the ISOLATED table, never on the cles row, and returns it to the owner', async () => {
  const ID = 'HN 12345 — สมชาย ใจดี';
  const res = await auth(request(app).post('/cles')).send({ chief_complaint: 'chest pain in a 58yo', patient_ref: ID });

  expect(res.status).toBe(201);
  expect(res.body.patient_ref).toBe(ID);                          // owner sees their own identifier
  // CRITICAL boundary: the identifier must NOT be on the `cles` row (admin/auditor/export read that).
  expect(mockInserts.cles).toBeDefined();
  expect(mockInserts.cles).not.toHaveProperty('patient_ref');
  // It lives ONLY in the physically-isolated, owner-scoped table.
  expect(mockInserts.cle_patient_refs).toMatchObject({ cle_id: 'ple1', physician_id: 'doc1', patient_ref: ID });
});

test('POST /cles without patient_ref writes nothing to the identifier table', async () => {
  const res = await auth(request(app).post('/cles')).send({ chief_complaint: 'fever, de-identified' });
  expect(res.status).toBe(201);
  expect(res.body.patient_ref).toBeNull();
  expect(mockInserts.cle_patient_refs).toBeUndefined();
});

test('a blank/whitespace patient_ref is treated as none', async () => {
  const res = await auth(request(app).post('/cles')).send({ chief_complaint: 'cough', patient_ref: '   ' });
  expect(res.status).toBe(201);
  expect(res.body.patient_ref).toBeNull();
  expect(mockInserts.cle_patient_refs).toBeUndefined();
});
