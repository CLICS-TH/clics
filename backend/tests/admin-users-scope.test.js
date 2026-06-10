// GET /admin/users — dual-role member list (2026-06-10). An admin (council director) sees ONLY
// their own council's members: scopeToCouncil() must add .eq('council_id', <caller's council>).
// The superadmin spans all councils: NO council_id filter. The list is paginated with a
// count:'exact' select, surfaced as the X-Total-Count header (body stays an array).
//
// Only the Supabase edge is mocked (table-aware, same pattern as auth-flows.test.js): all mutable
// state lives INSIDE the hoisted jest.mock factory and is re-exported as `__mock`. The builder
// RECORDS every query (table, select args, eq calls) into state.queries so tests can assert
// exactly which filters the route applied — not just the response shape.

jest.mock('../src/lib/supabase', () => {
  // Mutable state tests reach in and set (reset by m.reset()).
  const state = {
    caller: null,   // professionals row returned to verifyJwt (.single())
    listRows: [],   // rows the awaited list query resolves with
    listCount: 0,   // count:'exact' total the list query resolves with
    queries: [],    // every builder created: { table, op, selectArgs, eqs: [[col, val], ...] }
  };
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const rec = { table, op: 'select', selectArgs: null, eqs: [] };
    state.queries.push(rec);
    const self = {};
    self.select = (...args) => { rec.selectArgs = args; return self; };
    self.eq = (col, val) => { rec.eqs.push([col, val]); return self; };
    self.insert = (payload) => { rec.op = 'insert'; rec.payload = payload; return self; };
    self.update = (payload) => { rec.op = 'update'; rec.payload = payload; return self; };
    for (const fn of ['order', 'range', 'limit', 'in', 'neq', 'not', 'is', 'gte', 'lte']) self[fn] = () => self;
    self.single = () => (table === 'professionals' ? ok(state.caller) : ok(null));
    self.maybeSingle = () => ok(null);
    // Thenable terminal: GET /users awaits the builder directly and destructures { data, error, count }.
    self.then = (resolve, reject) => {
      const value = table === 'professionals'
        ? { data: state.listRows, error: null, count: state.listCount }
        : { data: [], error: null, count: 0 };
      return Promise.resolve(value).then(resolve, reject);
    };
    return self;
  }

  const mod = {
    supabase: { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) },
    authSupabase: { auth: {
      getUser: () => Promise.resolve(
        state.caller
          ? { data: { user: { id: state.caller.id, email: 'caller@test.local' } }, error: null }
          : { data: { user: null }, error: { message: 'no caller set' } }
      ),
    } },
  };

  mod.__mock = {
    state,
    reset() {
      state.caller = null;
      state.listRows = [];
      state.listCount = 0;
      state.queries.length = 0;
    },
  };
  return mod;
});

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => m.reset());

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
