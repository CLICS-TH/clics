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
// Supabase mock: the shared table-aware recording mock (helpers/supabase-mock) — it records .or()
// expressions (m.state.queries[].ors) and serves the members list from m.state.listRows/listCount.

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
