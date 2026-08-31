// GET /admin/integrity-queue — the surface that makes the detector readable.
//
// Until this endpoint the integrity detector was WRITE-ONLY: it ran on every /end, wrote flags, and
// forced flagged sessions into the audit sample, but nothing could read the evidence back. These
// tests pin the two properties that make the queue safe to look at — it is scoped to the caller's
// council, and it carries the evidence rather than just a count.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { ADMIN, SUPERADMIN, COUNCIL_A } = require('./helpers/roles');

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin'));
const auth = (r) => r.set('Authorization', 'Bearer test');

const FLAGS = [
  { cle_id: 'cle-a', signal: 'F3_PASTE_BURST', severity: 'low', created_at: '2026-08-01T00:00:00Z',
    evidence: { turn_index: 4, token_count: 900, gap_seconds: 3.1,
      genre: { chars: 1800, digit_density: 0.2, clinical_density: 0, discourse_density: 2.6, markdown_marks: 7 } } },
  { cle_id: 'cle-a', signal: 'F5_LATENCY_UNIFORMITY', severity: 'high', created_at: '2026-08-01T00:01:00Z',
    evidence: { turns: 9, coefficient_of_variation: 0.01 } },
  { cle_id: 'cle-b', signal: 'F1_NEAR_DUPLICATE', severity: 'medium', created_at: '2026-08-02T00:00:00Z',
    evidence: { turn_a: 1, turn_b: 3, similarity: 0.97 } },
];

/*
 * The flag table's mock HONOURS whatever .eq('severity', …) the route applied.
 *
 * It did not, at first, and that made the two filter tests below vacuous: they asserted a 200 and a
 * non-empty body, which the route returns whether or not it filters. Proved by mutation — replacing
 * the route's `SEVERITIES.includes(...)` guard with `severity !== undefined`, so an empty string was
 * passed straight to the query, changed nothing and both tests still passed. A test that cannot fail
 * is worse than no test: it reports the property as covered.
 */
function wire({ flags = FLAGS, cles }) {
  m.reset();
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'cle_integrity_flags') {
      const sev = (ctx.eqs.find((e) => e[0] === 'severity') || [])[1];
      return { data: sev === undefined ? flags : flags.filter((f) => f.severity === sev) };
    }
    // ...and the CLE list honours the route's .in('id', flaggedIds). Without this the suite hands
    // back every wired CLE whatever the route asked for, so a severity filter looks like it did
    // nothing — which is how the test above first failed on a route that was in fact correct.
    if (table === 'cles' && kind === 'list') {
      const ids = (ctx.ins.find((i) => i[0] === 'id') || [])[1];
      return { data: ids ? cles.filter((c) => ids.includes(c.id)) : cles };
    }
    return undefined;
  };
}

/** The severity the route actually filtered on, or undefined if it applied no filter. */
const filteredSeverity = () => (m.find('cle_integrity_flags').eqs.find((e) => e[0] === 'severity') || [])[1];

const CLE_A = { id: 'cle-a', cle_code: 'CLE-101', council_id: COUNCIL_A, status: 'evaluated', ended_at: '2026-08-01T00:00:00Z' };
const CLE_B = { id: 'cle-b', cle_code: 'CLE-102', council_id: COUNCIL_A, status: 'evaluated', ended_at: '2026-08-02T00:00:00Z' };

test('returns flagged CLEs with their evidence attached', async () => {
  wire({ cles: [CLE_A, CLE_B] });
  m.state.caller = SUPERADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue'));
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(2);
  const a = res.body.cles.find(c => c.id === 'cle-a');
  expect(a.flags).toHaveLength(2);
  // The genre counters are the whole point of reading a paste flag — they must survive the trip.
  expect(a.flags.find(f => f.signal === 'F3_PASTE_BURST').evidence.genre.markdown_marks).toBe(7);
});

test('worst severity first — the queue is work, not an archive', async () => {
  wire({ cles: [CLE_A, CLE_B] });
  m.state.caller = SUPERADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue'));
  expect(res.body.cles[0].id).toBe('cle-a');   // carries the 'high'
});

// The scoping property. The flag table has no council column, so filtering it directly would leak
// that another council has flagged sessions; the filter has to happen on the CLE rows.
test("a CLE the caller's council cannot see is not returned", async () => {
  wire({ cles: [CLE_A] });                      // the scoped CLE query returns only cle-a
  m.state.caller = ADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue'));
  expect(res.body.cles.map(c => c.id)).toEqual(['cle-a']);
  expect(res.body.total).toBe(1);
});

test('a valid ?severity really filters — the guard is not a no-op', async () => {
  wire({ cles: [CLE_A, CLE_B] });
  m.state.caller = SUPERADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue?severity=medium'));
  expect(res.status).toBe(200);
  expect(filteredSeverity()).toBe('medium');
  // FLAGS has exactly one medium, on cle-b.
  expect(res.body.cles.map((c) => c.id)).toEqual(['cle-b']);
});

test('an unrecognised ?severity falls back to everything, not to an empty queue', async () => {
  wire({ cles: [CLE_A, CLE_B] });
  m.state.caller = SUPERADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue?severity=banana'));
  expect(res.status).toBe(200);
  // The property is that NO filter was applied — not merely that something came back.
  expect(filteredSeverity()).toBeUndefined();
  expect(res.body.cles).toHaveLength(2);
});

// The dashboard's "All" filter sends `?severity=` — an EMPTY value, not an absent parameter, because
// the query string is built with the `?` ahead of the interpolation (see the note in the page). Were
// that treated as "match severity ''", the DEFAULT view would render an empty queue and look exactly
// like "nothing has ever been flagged".
test('an empty ?severity= is the All filter, not a filter for the empty string', async () => {
  wire({ cles: [CLE_A, CLE_B] });
  m.state.caller = SUPERADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue?severity='));
  expect(res.status).toBe(200);
  expect(filteredSeverity()).toBeUndefined();
  expect(res.body.cles).toHaveLength(2);
});

test('no flags at all → an empty queue, not an error', async () => {
  wire({ flags: [], cles: [] });
  m.state.caller = SUPERADMIN;
  const res = await auth(request(app).get('/admin/integrity-queue'));
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ cles: [], limit: expect.any(Number), offset: 0, total: 0 });
});
