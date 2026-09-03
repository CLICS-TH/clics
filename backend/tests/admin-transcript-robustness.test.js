// GET /admin/ples/:id/transcript — embed-error robustness (2026-06-22).
//
// The PLE→PLE rename preserved Postgres FK constraint NAMES across the table rename, so prod's `ples`
// kept `ples_physician_id_fkey`. `ples` has two FKs to `professionals` (physician + auditor), so the
// PostgREST embed `professionals!ples_physician_id_fkey` is ambiguous unless that exact constraint
// name exists — it didn't, so the query ERRORED. The transcript handler destructured only
// `{ data: ple }`, IGNORING the error → `ple` was null → it fell through to a 404 "Not found" that the
// dashboard rendered as "outside your council" (a red herring — councils were fine). `/ples` and
// `/ples/flagged` already call sendDbError, so they 500'd correctly; only the transcript masked it.
//
// This suite locks in the fix: a QUERY/EMBED error → 500 (loud), a genuine missing row → 404, the
// real council/specialty scope rejection still → 404, the happy path → 200, and a messages-fetch
// error → 500 (never a silently-empty transcript). Plus a static guard that the embed FK-hint names
// in admin.js still map to inline professionals FKs on the `ples` table in schema.sql, so the next
// table rename fails CI instead of prod. Only the Supabase edge is mocked (helpers/supabase-mock).

jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { ADMIN, SUPERADMIN, COUNCIL_A, COUNCIL_B } = require('./helpers/roles');

const adminRouter = require('../src/routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

const EMBED_ERROR = {
  code: 'PGRST200',
  message: "Could not embed because more than one relationship was found for 'ples' and 'professionals'",
};
const A_CLE = { id: 'ple-1', council_id: COUNCIL_A, specialty_id: null, status: 'evaluated' };

beforeEach(() => { m.reset(); });

describe('transcript embed-error robustness', () => {
  test('embed/query error on the PLE read → 500 (NOT a masked 404)', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = (table) =>
      table === 'ples' ? { data: null, error: EMBED_ERROR } : undefined;

    const r = await auth(request(app).get('/admin/ples/ple-1/transcript'));
    expect(r.status).toBe(500);
  });

  test('genuine missing PLE (no rows, no error) → 404', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = (table) =>
      table === 'ples' ? { data: null, error: null } : undefined;

    const r = await auth(request(app).get('/admin/ples/missing/transcript'));
    expect(r.status).toBe(404);
  });

  test('admin reading another council\'s PLE → 404 (scope), not 500', async () => {
    m.state.caller = ADMIN; // council A
    m.state.resolve = (table) =>
      table === 'ples'
        ? { data: { ...A_CLE, id: 'ple-x', council_id: COUNCIL_B }, error: null }
        : undefined;

    const r = await auth(request(app).get('/admin/ples/ple-x/transcript'));
    expect(r.status).toBe(404);
  });

  test('admin in own council AND own specialty → 200 (in-scope happy path)', async () => {
    m.state.caller = { ...ADMIN, specialty_id: 'spec-A' }; // council A, specialty A
    m.state.resolve = (table) => {
      if (table === 'ples') return { data: { ...A_CLE, specialty_id: 'spec-A' }, error: null };
      if (table === 'messages') return { data: [{ role: 'user', content: 'hi' }], error: null };
      return undefined;
    };

    const r = await auth(request(app).get('/admin/ples/ple-1/transcript'));
    expect(r.status).toBe(200);
    expect(r.body.ple.id).toBe('ple-1');
  });

  test('admin same council but DIFFERENT specialty → 404 (specialty scope), not 500', async () => {
    m.state.caller = { ...ADMIN, specialty_id: 'spec-A' }; // council A, specialty A
    m.state.resolve = (table) =>
      table === 'ples'
        ? { data: { ...A_CLE, specialty_id: 'spec-B' }, error: null } // same council, foreign specialty
        : undefined;

    const r = await auth(request(app).get('/admin/ples/ple-1/transcript'));
    expect(r.status).toBe(404);
  });

  test('valid PLE with zero messages → 200 with [] (empty transcript is not an error)', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = (table) => {
      if (table === 'ples') return { data: A_CLE, error: null };
      if (table === 'messages') return { data: [], error: null };
      return undefined;
    };

    const r = await auth(request(app).get('/admin/ples/ple-1/transcript'));
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([]);
  });

  test('valid PLE → 200 with ple + messages', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = (table) => {
      if (table === 'ples') return { data: A_CLE, error: null };
      if (table === 'messages') return { data: [{ role: 'user', content: 'hi' }], error: null };
      return undefined;
    };

    const r = await auth(request(app).get('/admin/ples/ple-1/transcript'));
    expect(r.status).toBe(200);
    expect(r.body.ple.id).toBe('ple-1');
    expect(r.body.messages).toHaveLength(1);
  });

  test('messages-fetch error → 500 (not a silently-empty transcript)', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = (table) => {
      if (table === 'ples') return { data: A_CLE, error: null };
      if (table === 'messages') return { data: null, error: { message: 'messages boom' } };
      return undefined;
    };

    const r = await auth(request(app).get('/admin/ples/ple-1/transcript'));
    expect(r.status).toBe(500);
  });
});

describe('embed FK-hint ↔ schema consistency guard', () => {
  // Catches the PLE→PLE class of drift: a table rename that leaves the code's embed hint referencing
  // a constraint name Postgres no longer auto-generates. For each `professionals!ples_<col>_fkey` hint
  // in admin.js, schema.sql's `ples` table must define `<col>` as an inline FK to professionals (which
  // Postgres auto-names exactly `ples_<col>_fkey`).
  test('every professionals!ples_*_fkey hint maps to an inline professionals FK on the ples table', () => {
    const adminSrc = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
    const schemaSrc = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');

    const plesBlock = schemaSrc.match(/create table public\.ples \(([\s\S]*?)\n\);/);
    expect(plesBlock).not.toBeNull();
    const body = plesBlock[1];

    const hints = [...adminSrc.matchAll(/professionals!(ples_([a-z_]+?)_fkey)/g)];
    expect(hints.length).toBeGreaterThan(0); // guard-the-guard: we actually parsed some hints

    for (const [, constraint, col] of hints) {
      // The hint's table prefix must be `ples` — a future rename to e.g. `ples_` would break the auto-name.
      expect(constraint.startsWith('ples_')).toBe(true);
      // schema.sql's ples table must define <col> as an inline FK to professionals, so Postgres
      // auto-names the constraint exactly <constraint>. (This is precisely what broke after PLE→PLE.)
      expect(body).toMatch(new RegExp(`${col}\\s+uuid[^,]*references public\\.professionals`));
    }
  });
});
