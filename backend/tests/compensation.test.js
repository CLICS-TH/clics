// Compensation report (CLICS §12): per-physician payout = min(passed PLEs, 3) × ฿500, capped ฿1500.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin'));
const auth = (r) => r.set('Authorization', 'Bearer t');

const SUPER = { id: 'sa', role: 'superadmin', council_id: null, status: 'active', email: 's@t' };

test('caps a physician at 3 PLEs (฿1500) and sums the cohort total', async () => {
  m.reset();
  m.state.caller = SUPER;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'ples' && kind === 'list') {
      // phys-1 passed 4 PLEs (should cap at 3), phys-2 passed 1.
      return [{ physician_id: 'phys-1' }, { physician_id: 'phys-1' }, { physician_id: 'phys-1' }, { physician_id: 'phys-1' }, { physician_id: 'phys-2' }];
    }
    if (table === 'professionals' && kind === 'list') {
      return [{ id: 'phys-1', pseudonym: 'P-001' }, { id: 'phys-2', pseudonym: 'P-002' }];
    }
    return undefined;
  };
  const r = await auth(request(app).get('/admin/compensation'));
  expect(r.status).toBe(200);
  expect(r.body.rate_thb_per_cle).toBe(500);
  const p1 = r.body.recipients.find((x) => x.physician === 'P-001');
  expect(p1).toMatchObject({ completed_cles: 3, amount_thb: 1500 }); // capped from 4
  const p2 = r.body.recipients.find((x) => x.physician === 'P-002');
  expect(p2).toMatchObject({ completed_cles: 1, amount_thb: 500 });
  expect(r.body.total_thb).toBe(2000);
});
