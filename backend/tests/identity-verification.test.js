// Professional identity verification (CREC082 ICF §4).
//
// "ก่อนเริ่ม PLE ระบบยืนยันตัวตนด้วย ThaID หรือการตรวจสอบเลขประจำตัวประชาชนร่วมกับเลขที่ใบอนุญาต
// ประกอบวิชาชีพเวชกรรม" — and the identity layer must be kept separate from the research dataset.
//
// Two things this suite exists to hold: the national ID never appears in the clear anywhere it could
// escape, and a licence lookup is evidence rather than a verdict.
process.env.IDENTITY_ENC_KEY = 'test-identity-key';
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockVerify = jest.fn(async () => ({ status: 'verified', source: 'stub', checked_at: 't', evidence: { adapter: 'stub' } }));
jest.mock('../src/services/license-verifier', () => ({ getVerifier: () => ({ verify: mockVerify }) }));
// POST /cles also runs requireBudget; unmocked, lib/usage reads through the double and refuses on a
// budget it cannot compute, which surfaces as a 403 indistinguishable from the identity gate's.
jest.mock('../src/lib/usage', () => ({
  effectiveLimit: async () => 0.5,
  reserveUsage: async () => ({ ok: true, applied: true }),
  accrueUsage: async () => ({ cost: 0, error: null }),
  settleUsage: async () => {}, refundUsage: async () => {},
  RESERVE_ESTIMATE_USD: 0.01,
}));

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN, ADMIN, COUNCIL_A } = require('./helpers/roles');
const nationalId = require('../src/lib/national-id');
const { decryptJson, blindIndex } = require('../src/lib/crypto');

const app = express();
app.use(express.json());
app.use('/auth', require('../src/routes/auth'));
app.use('/admin', require('../src/routes/admin'));
app.use('/cles', require('../src/routes/cles'));
const auth = r => r.set('Authorization', 'Bearer test');

// A checksum-valid ID, computed rather than hardcoded so it is obvious this is not a real number.
const VALID_NID = (() => {
  const twelve = '110170012345';
  let s = 0; for (let i = 0; i < 12; i++) s += Number(twelve[i]) * (13 - i);
  return twelve + ((11 - (s % 11)) % 10);
})();

let clash, verifiedRows, gateOn;
beforeEach(() => {
  m.reset();
  mockVerify.mockClear();
  m.state.caller = { ...PHYSICIAN, full_name_th: 'ทดสอบ' };
  clash = [];          // rows returned for the "is this ID already used?" probe
  verifiedRows = [];   // rows returned for the isVerified probe
  gateOn = 0;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') {
      const key = (ctx.eqs.find(e => e[0] === 'key') || [])[1];
      return { value: key === 'identity_verification_required' ? gateOn : 0 };
    }
    if (table === 'identity_verifications') {
      if (ctx.op === 'insert') return { id: 'iv-1', status: 'pending', ...ctx.payload };
      if (ctx.op === 'update') return { id: 'iv-1', professional_id: PHYSICIAN.id, status: 'verified' };
      // Two different selects: the clash probe filters on national_id_index, the isVerified probe
      // filters on professional_id + status.
      if (ctx.ins.some(i => i[0] === 'status' && Array.isArray(i[1]) && i[1].includes('verified'))
          && ctx.eqs.some(e => e[0] === 'professional_id')) return { data: verifiedRows };
      if (ctx.eqs.some(e => e[0] === 'national_id_index')) return { data: clash };
      return { data: [], count: 0 };
    }
    return undefined;
  };
});

const submit = (body) => auth(request(app).post('/auth/identity/national-id')).send(body);
const GOOD = { national_id: VALID_NID, license_number: 'ว.12340' };

describe('the national ID never exists in the clear where it could escape', () => {
  test('what is written is encrypted, blind-indexed, and truncated — never the number itself', async () => {
    expect((await submit(GOOD)).status).toBe(201);
    const row = m.find('identity_verifications', 'insert').payload;

    // The number itself must not appear in ANY field of the row.
    expect(JSON.stringify(row)).not.toContain(VALID_NID);
    expect(row.national_id_encrypted).toEqual(expect.any(String));
    expect(decryptJson(row.national_id_encrypted)).toBe(VALID_NID); // reversible for the team
    expect(row.national_id_index).toBe(blindIndex(VALID_NID, 'national_id'));
    expect(row.national_id_last4).toBe(VALID_NID.slice(-4));
  });

  test('the response body carries no identifier back', async () => {
    const res = await submit(GOOD);
    expect(JSON.stringify(res.body)).not.toContain(VALID_NID);
    expect(JSON.stringify(res.body)).not.toContain(VALID_NID.slice(-4));
  });

  test('the blind index is keyed, not a plain digest — a 13-digit space would fall to brute force', () => {
    const crypto = require('crypto');
    const plain = crypto.createHash('sha256').update(VALID_NID).digest('hex');
    expect(blindIndex(VALID_NID, 'national_id')).not.toBe(plain);
    // ...and domain-separated, so the same number does not collide across columns.
    expect(blindIndex(VALID_NID, 'national_id')).not.toBe(blindIndex(VALID_NID, 'license'));
  });
});

describe('the checksum is enforced before anything is written', () => {
  test('a mistyped digit is rejected with no insert and no licence lookup', async () => {
    const bad = VALID_NID.slice(0, 12) + ((Number(VALID_NID[12]) + 1) % 10);
    const res = await submit({ ...GOOD, national_id: bad });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_national_id');
    expect(m.find('identity_verifications', 'insert')).toBeUndefined();
    expect(mockVerify).not.toHaveBeenCalled(); // no administrator time, no scraper call
  });

  test('the printed card format (spaces and hyphens) is accepted', async () => {
    const printed = `${VALID_NID[0]}-${VALID_NID.slice(1, 5)}-${VALID_NID.slice(5, 10)}-${VALID_NID.slice(10, 12)}-${VALID_NID[12]}`;
    expect((await submit({ ...GOOD, national_id: printed })).status).toBe(201);
    expect(m.find('identity_verifications', 'insert').payload.national_id_index)
      .toBe(blindIndex(VALID_NID, 'national_id'));
  });

  test('one national ID cannot be registered to two accounts', async () => {
    clash = [{ professional_id: 'someone-else' }];
    const res = await submit(GOOD);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('national_id_already_used');
    expect(m.find('identity_verifications', 'insert')).toBeUndefined();
  });
});

describe('a licence lookup is evidence, not a verdict', () => {
  test('even a clean "verified" lookup lands as PENDING — a human decides', async () => {
    mockVerify.mockResolvedValueOnce({ status: 'verified', source: 'stub', checked_at: 't', evidence: {} });
    const res = await submit(GOOD);
    expect(res.body.status).toBe('pending');
    expect(m.find('identity_verifications', 'insert').payload).toMatchObject({
      status: 'pending', license_check_status: 'verified',
    });
  });

  test('a verifier outage still records the submission — it slows review, it does not stop it', async () => {
    mockVerify.mockRejectedValueOnce(new Error('scraper down'));
    const res = await submit(GOOD);
    expect(res.status).toBe(201);
    expect(m.find('identity_verifications', 'insert').payload.license_check_status).toBe('unavailable');
  });

  test('an earlier undecided submission is superseded, so no two pending rows exist', async () => {
    await submit(GOOD);
    const upd = m.find('identity_verifications', 'update');
    expect(upd.payload).toMatchObject({ status: 'rejected' });
    expect(upd.eqs).toContainEqual(['status', 'pending']);
  });
});

describe('the gate on POST /cles', () => {
  // POST /cles needs more of the world than the submission path does: the episode probe, the folder
  // check, and the insert itself.
  beforeEach(() => {
    m.state.resolve = (table, kind, ctx) => {
      if (table === 'app_settings') {
        const key = (ctx.eqs.find(e => e[0] === 'key') || [])[1];
        return { value: key === 'identity_verification_required' ? gateOn : 0 };
      }
      if (table === 'identity_verifications') return { data: verifiedRows };
      if (table === 'cles') {
        if (ctx.op === 'insert') return { id: 'new', ...ctx.payload };
        return { data: [], count: 0 };  // the completed-episode probe
      }
      return undefined;
    };
  });

  test('off (the default): an unverified physician can start a session', async () => {
    gateOn = 0;
    expect((await auth(request(app).post('/cles')).send({ chief_complaint: 'x' })).status).toBe(201);
  });

  test('on: an unverified physician is refused with an actionable code', async () => {
    gateOn = 1;
    verifiedRows = [];
    const res = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('identity_verification_required');
  });

  test('on: a verified physician proceeds', async () => {
    gateOn = 1;
    verifiedRows = [{ id: 'iv-1' }];
    const res = await auth(request(app).post('/cles')).send({ chief_complaint: 'x' });
    expect(res.status).toBe(201);
  });

  test('a pending submission is NOT a verification', async () => {
    gateOn = 1;
    verifiedRows = []; // the isVerified probe filters to status 'verified'; pending never matches
    expect((await auth(request(app).post('/cles')).send({ chief_complaint: 'x' })).status).toBe(403);
  });
});

describe('the administrator decision', () => {
  beforeEach(() => {
    m.state.caller = { ...ADMIN };
    m.state.resolve = (table, kind, ctx) => {
      if (table === 'app_settings') return { value: 0 };
      if (table === 'identity_verifications') {
        if (ctx.op === 'update') return { id: 'iv-1', professional_id: PHYSICIAN.id, status: 'verified' };
        return kind === 'list'
          ? { data: [{ id: 'iv-1', professionals: { council_id: COUNCIL_A } }], count: 1 }
          : { id: 'iv-1', professional_id: PHYSICIAN.id, status: 'pending', professionals: { council_id: COUNCIL_A } };
      }
      return undefined;
    };
  });

  test('rejecting requires a reason — a rejection the physician cannot act on is a dead end', async () => {
    const res = await auth(request(app).post('/admin/identity/iv-1/decide')).send({ decision: 'rejected' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reason_required');
  });

  test('verifying stamps who and when', async () => {
    const res = await auth(request(app).post('/admin/identity/iv-1/decide')).send({ decision: 'verified' });
    expect(res.status).toBe(200);
    expect(m.find('identity_verifications', 'update').payload).toMatchObject({ status: 'verified', decided_by: ADMIN.id });
    expect(m.find('identity_verifications', 'update').payload.decided_at).toEqual(expect.any(String));
  });

  test('the queue never selects the national ID, encrypted or otherwise', async () => {
    await auth(request(app).get('/admin/identity-queue'));
    const cols = String(m.find('identity_verifications', 'select').selectArgs[0]);
    expect(cols).toContain('national_id_last4');
    expect(cols).not.toContain('national_id_encrypted');
    expect(cols).not.toContain('national_id_index');
  });
});

describe('national-id validation in isolation', () => {
  test.each([
    ['a checksum-valid number', VALID_NID, true],
    ['a leading zero', '0' + VALID_NID.slice(1), false],
    ['all the same digit', '1111111111111', false],
    ['too short', '123', false],
    ['letters', 'abcdefghijklm', false],
  ])('%s', (_label, value, expected) => {
    expect(nationalId.isValid(value)).toBe(expected);
  });
});
