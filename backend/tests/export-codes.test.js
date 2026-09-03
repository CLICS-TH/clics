// The de-identified research export is the protocol-facing artifact (CLICS §7/§9): sessions must be
// keyed by the PLE-NNN study pseudonym, auditors by EXP-NNN, and the experimental-design fields
// (episode/Socratic) must travel with each row for the Socratic-effect analysis.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const SUPER = { id: 'sa', role: 'superadmin', council_id: null, status: 'active', email: 'sa@test' };

beforeEach(() => {
  m.reset();
  m.state.caller = SUPER;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples') return { data: [{
      id: 'u1', ple_code: 'PLE-001', physician_id: 'phys-1', episode_number: 2,
      socratic_active: true, socratic_reason: 'cle2_examiner', status: 'ple_pass',
      is_test: false, turn_count: 4, token_count: 1000, duration_seconds: 1000, started_at: '2026-01-01T00:00:00Z',
    }], count: 1 };
    if (table === 'professionals') {
      // Two distinct professionals reads: physician pseudonyms vs auditor exp_codes.
      return String(ctx.selectArgs?.[0] ?? '').includes('exp_code')
        ? [{ id: 'aud-1', exp_code: 'EXP-001' }]
        : [{ id: 'phys-1', pseudonym: 'P-001' }];
    }
    if (table === 'ai_evaluations') return [];
    if (table === 'audit_scores') return [{ ple_id: 'u1', auditor_id: 'aud-1', composite_score: 80, d1: 4, d2: 4, d3: 4, d4: 4, d5: 4, d6: 4, d7: 4 }];
    return undefined;
  };
});

test('export keys sessions by PLE-NNN + EXP-NNN and carries the experimental fields', async () => {
  const r = await auth(request(app).get('/admin/export'));
  expect(r.status).toBe(200);
  const s = r.body.sessions[0];
  expect(s.ple_code).toBe('PLE-001');
  expect(s.physician).toBe('P-001');               // physician pseudonym, never a name
  expect(s.episode_number).toBe(2);
  expect(s.socratic_active).toBe(true);
  expect(s.socratic_reason).toBe('cle2_examiner');
  expect(s.auditor_scores[0].auditor).toBe('EXP-001'); // EXP-NNN, not A-<hash>
});
