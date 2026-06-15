// GET /admin/users — dual-role member list (2026-06-10). An admin (council director) sees ONLY
// their own council's members: scopeToCouncil() must add .eq('council_id', <caller's council>).
// The superadmin spans all councils: NO council_id filter. The list is paginated with a
// count:'exact' select, surfaced as the X-Total-Count header (body stays an array).
//
// Only the Supabase edge is mocked, via the shared table-aware recording mock (helpers/supabase-mock):
// the builder RECORDS every query (table, select args, eq calls) into m.state.queries so tests can
// assert exactly which filters the route applied — not just the response shape. The members-list read
// is served from m.state.listRows / m.state.listCount (the awaited professionals list query).

jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  m.reset();
  m.state.listRows = [];
  m.state.listCount = 0;
  // The GET /admin/users members list is the only awaited professionals read; serve it from
  // listRows/listCount. (verifyJwt's own caller lookup is a .single() → auto-returns m.state.caller.)
  m.state.resolve = (table, kind) =>
    (table === 'professionals' && kind === 'list')
      ? { data: m.state.listRows, error: null, count: m.state.listCount }
      : undefined;
});

const ADMIN_C1 = { id: 'adm-1', role: 'admin', status: 'active', council_id: 'C1' };
const SUPERADMIN = { id: 'sa-1', role: 'superadmin', status: 'active', council_id: null };

// The members-list query is the professionals select carrying count:'exact'; verifyJwt's own
// professionals lookup is select('*') with no options object, so this discriminates cleanly.
const listQuery = () =>
  m.state.queries.find((q) => q.table === 'professionals' && q.selectArgs?.[1]?.count === 'exact');

test('admin caller → list is council-scoped: .eq(council_id, <own council>) + 200 with X-Total-Count', async () => {
  m.state.caller = ADMIN_C1;
  m.state.listRows = [{ id: 'p-1', role: 'physician', council_id: 'C1' }];
  m.state.listCount = 1;

  const r = await auth(request(app).get('/admin/users'));

  expect(r.status).toBe(200);
  expect(r.headers['x-total-count']).toBe('1');
  expect(Array.isArray(r.body)).toBe(true);

  const q = listQuery();
  expect(q).toBeDefined();
  expect(q.eqs).toContainEqual(['council_id', 'C1']);
});

test('superadmin caller → list is UNscoped: no council_id filter on the query', async () => {
  m.state.caller = SUPERADMIN;
  m.state.listRows = [
    { id: 'p-1', role: 'physician', council_id: 'C1' },
    { id: 'p-2', role: 'auditor', council_id: 'C2' },
  ];
  m.state.listCount = 2;

  const r = await auth(request(app).get('/admin/users'));

  expect(r.status).toBe(200);
  expect(r.body).toHaveLength(2);

  const q = listQuery();
  expect(q).toBeDefined();
  expect(q.eqs.map(([col]) => col)).not.toContain('council_id');
});

test('list select uses count:"exact" and the mocked count lands in X-Total-Count', async () => {
  m.state.caller = SUPERADMIN;
  m.state.listRows = [{ id: 'p-1' }];
  m.state.listCount = 81234; // header reflects the COUNT, not the page size

  const r = await auth(request(app).get('/admin/users'));

  expect(r.status).toBe(200);
  const q = listQuery();
  expect(q).toBeDefined();
  expect(q.selectArgs[1]).toEqual({ count: 'exact' });
  expect(r.headers['x-total-count']).toBe('81234');
  expect(r.body).toHaveLength(1);
});
