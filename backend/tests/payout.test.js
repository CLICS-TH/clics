// Compensation payout pipeline: superadmin /payouts owed math + pay guards (overpayment, not-found),
// and physician self-service /auth/payment-info (encrypt round-trip + physician-only guard).
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { encryptJson } = require('../src/lib/crypto');
const { SUPERADMIN, ADMIN, PHYSICIAN, AUDITOR } = require('./helpers/roles');

const superadminRouter = require('../src/routes/superadmin');
const authRouter = require('../src/routes/auth');
const app = express();
app.use(express.json());
app.use('/admin', superadminRouter);
app.use('/auth', authRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => { m.reset(); });

describe('GET /admin/payouts (superadmin owed math)', () => {
  test('owed = min(completed, cap) × rate; outstanding = owed − paid', async () => {
    m.state.caller = SUPERADMIN;
    // 4 ple_pass for phys-1; default cap 3, rate 500 → owed 1500. One ฿500 payout already → outstanding 1000.
    m.state.resolve = (table, kind) => {
      if (table === 'ples' && kind === 'list') return [{ physician_id: 'phys-1' }, { physician_id: 'phys-1' }, { physician_id: 'phys-1' }, { physician_id: 'phys-1' }];
      if (table === 'professionals' && kind === 'list') return [{ id: 'phys-1', full_name_th: 'หมอ', pseudonym: 'P-001' }];
      if (table === 'payment_info' && kind === 'list') return [];
      if (table === 'payouts' && kind === 'list') return [{ physician_id: 'phys-1', amount_thb: 500 }];
      return undefined; // app_settings reads → defaults (rate 500 / cap 3)
    };
    const r = await auth(request(app).get('/admin/payouts'));
    expect(r.status).toBe(200);
    expect(r.body.rate_thb_per_cle).toBe(500);
    expect(r.body.recipients).toHaveLength(1);
    expect(r.body.recipients[0]).toMatchObject({ completed_cles: 3, owed_thb: 1500, paid_thb: 500, outstanding_thb: 1000, has_payment_info: false });
  });

  test('admin (non-superadmin) is blocked by the router guard → 403', async () => {
    m.state.caller = ADMIN;
    const r = await auth(request(app).get('/admin/payouts'));
    expect(r.status).toBe(403);
  });
});

describe('POST /admin/payouts/:id/pay', () => {
  const baseResolve = (table, kind) => {
    if (table === 'ples' && kind === 'list') return [{ id: 'c1' }, { id: 'c2' }]; // 2 completed → owed 1000
    if (table === 'payouts' && kind === 'list') return []; // nothing paid yet
    if (table === 'payouts' && kind === 'single') return { id: 'po-1' }; // the insert().select('id').single() return
    if (table === 'professionals' && kind === 'maybeSingle') return { id: 'phys-1' }; // exists
    return undefined;
  };

  test('unknown physician → 404', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = (table, kind) => (table === 'professionals' && kind === 'maybeSingle' ? null : baseResolve(table, kind));
    const r = await auth(request(app).post('/admin/payouts/nope/pay')).send({ amount_thb: 100 });
    expect(r.status).toBe(404);
  });

  test('overpayment (amount > outstanding) → 400', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = baseResolve; // owed 1000, paid 0 → outstanding 1000
    const r = await auth(request(app).post('/admin/payouts/phys-1/pay')).send({ amount_thb: 1500 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('over_outstanding');
  });

  test('valid payment within outstanding → 200, ledger insert', async () => {
    m.state.caller = SUPERADMIN;
    m.state.resolve = baseResolve;
    const r = await auth(request(app).post('/admin/payouts/phys-1/pay')).send({ amount_thb: 1000, paid_ref: 'TXN-9' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const ins = m.find('payouts', 'insert');
    expect(ins.payload).toMatchObject({ physician_id: 'phys-1', amount_thb: 1000, paid_ref: 'TXN-9' });
  });
});

describe('/auth/payment-info (physician self-service, encrypted)', () => {
  test('physician saves details → 200 ok, upsert carries an encrypted blob (not plaintext)', async () => {
    m.state.caller = PHYSICIAN;
    m.state.resolve = () => undefined;
    const body = { account_name: 'หมอ ก', bank: 'KBank', account_no: '1234567890' };
    const r = await auth(request(app).post('/auth/payment-info')).send(body);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const up = m.find('payment_info', 'upsert');
    expect(up.payload.physician_id).toBe(PHYSICIAN.id);
    expect(typeof up.payload.enc).toBe('string');
    expect(up.payload.enc).not.toContain('1234567890'); // encrypted at rest
  });

  test('physician reads back their decrypted details', async () => {
    m.state.caller = PHYSICIAN;
    const enc = encryptJson({ account_name: 'หมอ ก', bank: 'KBank', account_no: '1234567890', promptpay: '' });
    m.state.resolve = (table, kind) => (table === 'payment_info' && kind === 'maybeSingle' ? { enc, updated_at: 't' } : undefined);
    const r = await auth(request(app).get('/auth/payment-info'));
    expect(r.status).toBe(200);
    expect(r.body.payment_info).toMatchObject({ account_name: 'หมอ ก', account_no: '1234567890' });
  });

  test('requires an account number or PromptPay → 400', async () => {
    m.state.caller = PHYSICIAN;
    const r = await auth(request(app).post('/auth/payment-info')).send({ account_name: 'หมอ ก' });
    expect(r.status).toBe(400);
  });

  test('non-physician (auditor) is blocked → 403, no write', async () => {
    m.state.caller = AUDITOR;
    const r = await auth(request(app).post('/auth/payment-info')).send({ account_name: 'X', account_no: '1' });
    expect(r.status).toBe(403);
    expect(m.find('payment_info', 'upsert')).toBeUndefined();
  });
});
