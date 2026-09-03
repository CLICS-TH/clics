// Shared, configurable Supabase mock for hermetic route-level tests.
//
// ADDITIVE: this is for the NEW cross-role integration suites. The existing per-file mocks are left
// as-is (a future cleanup can DRY them onto this — see docs/TESTING.md). It generalizes the
// table-aware recording builder from tests/auditor-request.test.js: the chaining + query recording
// live here; the per-table DATA is supplied by a test-provided `resolve(table, kind, ctx)`.
//
// Usage (the jest.mock factory must be self-contained, but it MAY require this module):
//   jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
//   const { __mock: m } = require('../src/lib/supabase');
//   beforeEach(() => m.reset());
//   m.state.caller = ADMIN;                       // the row verifyJwt sees for the Bearer token
//   m.state.resolve = (table, kind, ctx) => ...;  // return a row | array | {data,error}
//
// kind: 'single' | 'maybeSingle' | 'list' (a select awaited directly) | 'insert' | 'update' | 'delete'
// ctx : { op, eqs:[[col,val],...], payload, selectArgs, id(col='id') }
// professionals.single() filtered by the caller's own id auto-returns `state.caller` (so verifyJwt
// works without the test having to special-case it); any other read falls through to `resolve`.
function makeSupabaseMock() {
  const state = { caller: null, resolve: () => undefined, queries: [] };

  const wrap = (v, isList = false) => {
    // ADDITIVE: a resolve() return of { data, error, count } passes `count` through unchanged (for
    // count:'exact' list endpoints that surface it as X-Total-Count). Resolves that omit `count`
    // behave exactly as before (the key is simply absent). Non-list/legacy returns are untouched.
    if (v && typeof v === 'object' && !Array.isArray(v) && ('data' in v || 'error' in v)) {
      const r = { data: v.data ?? null, error: v.error ?? null };
      if ('count' in v) r.count = v.count;
      return Promise.resolve(r);
    }
    if (v === undefined) return Promise.resolve({ data: isList ? [] : null, error: null });
    return Promise.resolve({ data: v, error: null });
  };

  function builder(table) {
    const rec = { table, op: 'select', selectArgs: null, eqs: [], ors: [], iss: [], nots: [], ins: [], payload: undefined };
    state.queries.push(rec);
    const ctx = () => ({
      op: rec.op, eqs: rec.eqs, ors: rec.ors, iss: rec.iss, nots: rec.nots, ins: rec.ins, payload: rec.payload, selectArgs: rec.selectArgs,
      id: (col = 'id') => (rec.eqs.find((e) => e[0] === col) || [])[1],
    });
    const self = {};
    self.select = (...a) => { rec.selectArgs = a.length ? a : ['*']; return self; };
    self.insert = (p) => { rec.op = 'insert'; rec.payload = p; return self; };
    self.update = (p) => { rec.op = 'update'; rec.payload = p; return self; };
    self.upsert = (p) => { rec.op = 'upsert'; rec.payload = p; return self; };
    self.delete = () => { rec.op = 'delete'; return self; };
    self.eq = (c, v) => { rec.eqs.push([c, v]); return self; };
    // ADDITIVE: record .or() expressions (rec.ors) so search-filter suites can assert them; still
    // chainable. Suites that never call .or() are unaffected (rec.ors stays []).
    self.or = (expr) => { rec.ors.push(expr); return self; };
    // ADDITIVE: record .is() / .not() (rec.iss / rec.nots) so a suite can tell two otherwise-identical
    // count queries apart (e.g. `.is('error', null)` vs `.not('error','is',null)`). Still chainable;
    // suites that never read them are unaffected.
    self.is = (c, v) => { rec.iss.push([c, v]); return self; };
    self.not = (c, op, v) => { rec.nots.push([c, op, v]); return self; };
    // ADDITIVE: record .in() (rec.ins). It used to be a silent no-op in the chainable list below,
    // which is how a real bug stayed invisible: a suite could only recognise a query by its .eq()s,
    // so switching a filter from .eq('status','ple_pass') to .in('status', [...]) made the query
    // unrecognisable to the double rather than making a test fail. Recording it lets a suite match
    // on set membership the same way it matches on equality.
    self.in = (c, vals) => { rec.ins.push([c, vals]); return self; };
    for (const fn of ['order', 'range', 'limit', 'neq', 'gte', 'lte', 'lt', 'gt', 'contains']) self[fn] = () => self;

    const read = (kind) => {
      const c = ctx();
      if (table === 'professionals' && state.caller && c.id('id') === state.caller.id) return wrap(state.caller);
      return wrap(state.resolve(table, kind, c));
    };
    self.single = () => read('single');
    self.maybeSingle = () => read('maybeSingle');
    // A select/insert/update/delete awaited directly (no .single()).
    self.then = (resolve, reject) => {
      const kind = rec.op === 'select' ? 'list' : rec.op;
      return wrap(state.resolve(table, kind, ctx()), rec.op === 'select').then(resolve, reject);
    };
    return self;
  }

  return {
    supabase: { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) },
    authSupabase: {
      auth: {
        getUser: () => Promise.resolve(
          state.caller
            ? { data: { user: { id: state.caller.id, email: state.caller.email || 'caller@test.local' } }, error: null }
            : { data: { user: null }, error: { message: 'no caller set' } }
        ),
      },
    },
    authAnon: {
      auth: {
        signInWithOtp: () => Promise.resolve({ error: null }),
        verifyOtp: () => Promise.resolve({ data: null, error: { message: 'not set' } }),
        resetPasswordForEmail: () => Promise.resolve({ error: null }),
      },
    },
    __mock: {
      state,
      reset() { state.caller = null; state.resolve = () => undefined; state.queries.length = 0; },
      find(table, op) { return state.queries.find((q) => q.table === table && (op ? q.op === op : true)); },
      all(table, op) { return state.queries.filter((q) => q.table === table && (op ? q.op === op : true)); },
    },
  };
}

module.exports = { makeSupabaseMock };
