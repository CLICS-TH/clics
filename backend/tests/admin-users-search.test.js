// GET /admin/users?q= — server-side member search (2026-06-11). The optional ?q= adds ONE
// PostgREST .or() of case-insensitive ilike matches on full_name_th + full_name_en
// (professionals carries NO email column — emails live in auth.users, so email is NOT
// searchable here). Contract under test:
//   - ?q=<term>            → .or('full_name_th.ilike.*<term>*,full_name_en.ilike.*<term>*')
//   - composes with ?status (eq filter) and scopeToCouncil (admin callers)
//   - q is SANITIZED first: , ( ) % would break .or() syntax → replaced with spaces
//   - q that sanitizes to '' → filter skipped entirely (no .or() call)
//   - count:'exact' + X-Total-Count plumbing unchanged (the filter composes with pagination)
//
// Supabase mock follows admin-users-scope.test.js (table-aware; mutable state hoisted inside
// the jest.mock factory, re-exported as `__mock`), extended to RECORD .or() expressions.

jest.mock('../src/lib/supabase', () => {
  // Mutable state tests reach in and set (reset by m.reset()).
  const state = {
    caller: null,   // professionals row returned to verifyJwt (.single())
    listRows: [],   // rows the awaited list query resolves with
    listCount: 0,   // count:'exact' total the list query resolves with
    queries: [],    // every builder created: { table, op, selectArgs, eqs, ors }
  };
  const ok = (data) => Promise.resolve({ data, error: null });

  function builder(table) {
    const rec = { table, op: 'select', selectArgs: null, eqs: [], ors: [] };
    state.queries.push(rec);
    const self = {};
    self.select = (...args) => { rec.selectArgs = args; return self; };
    self.eq = (col, val) => { rec.eqs.push([col, val]); return self; };
    self.or = (expr) => { rec.ors.push(expr); return self; };
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

const searchOr = (term) => `full_name_th.ilike.*${term}*,full_name_en.ilike.*${term}*`;

test('?q=somchai → ONE .or() of ilike on full_name_th + full_name_en (th/en match in one filter)', async () => {
  m.state.caller = SUPERADMIN;
  m.state.listRows = [{ id: 'p-1', full_name_th: 'สมชาย ใจดี', full_name_en: 'Somchai Jaidee' }];
  m.state.listCount = 1;

  const r = await auth(request(app).get('/admin/users').query({ q: 'somchai' }));

  expect(r.status).toBe(200);
  expect(r.headers['x-total-count']).toBe('1'); // filtered count flows through unchanged
  const q = listQuery();
  expect(q).toBeDefined();
  expect(q.ors).toEqual([searchOr('somchai')]);
});

test('?q= composes with ?status AND admin council scoping (all three filters on one query)', async () => {
  m.state.caller = ADMIN_C1;
  m.state.listRows = [];
  m.state.listCount = 0;

  const r = await auth(request(app).get('/admin/users').query({ q: 'doc', status: 'active' }));

  expect(r.status).toBe(200);
  const q = listQuery();
  expect(q.ors).toEqual([searchOr('doc')]);
  expect(q.eqs).toContainEqual(['status', 'active']);
  expect(q.eqs).toContainEqual(['council_id', 'C1']); // scopeToCouncil still applies to searches
});

test('sanitization: commas/parens/% in q are replaced with spaces before the .or()', async () => {
  m.state.caller = SUPERADMIN;

  const r = await auth(request(app).get('/admin/users').query({ q: 'a,b(c)%' }));

  expect(r.status).toBe(200);
  const q = listQuery();
  // 'a,b(c)%' → 'a b c' — the or-syntax-breaking characters never reach PostgREST.
  expect(q.ors).toEqual([searchOr('a b c')]);
});

test('q that sanitizes to EMPTY (only , ( ) % chars) → search filter skipped entirely', async () => {
  m.state.caller = SUPERADMIN;
  m.state.listRows = [{ id: 'p-1' }];
  m.state.listCount = 1;

  const r = await auth(request(app).get('/admin/users').query({ q: ',,(())%%' }));

  expect(r.status).toBe(200);
  const q = listQuery();
  expect(q.ors).toHaveLength(0);          // no broken '.or()' from an all-junk query
  expect(r.body).toHaveLength(1);         // behaves exactly like an unfiltered list
});

test('no ?q= → no .or() at all (existing list behavior untouched)', async () => {
  m.state.caller = SUPERADMIN;
  m.state.listRows = [{ id: 'p-1' }];
  m.state.listCount = 42;

  const r = await auth(request(app).get('/admin/users'));

  expect(r.status).toBe(200);
  expect(r.headers['x-total-count']).toBe('42');
  expect(listQuery().ors).toHaveLength(0);
});
