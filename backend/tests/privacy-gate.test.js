// The 100% human privacy review gate (CREC082 ICF §5-6, Declaration "Privacy gate").
//
// The protocol promises that a person reads every transcript before any expert rater sees it, and
// that anything carrying patient data is quarantined, de-identified, or excluded. rimpl's pii-filter
// is only the automated half; this gate is the human half, and it is the last thing standing between
// a physician's raw stored transcript and a third party.
//
// It is modelled as a clearance COLUMN rather than a lifecycle status, which means it has to be
// applied at each exposure point instead of falling out of one status check. There are four. All
// four are pinned here — a fifth exposure added without a gate is the failure this suite exists to
// catch.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const { __mock: m } = require('../src/lib/supabase');
const { ADMIN, AUDITOR, COUNCIL_A } = require('./helpers/roles');

const request = require('supertest');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin'));
app.use('/auditor', require('../src/routes/auditor'));
const auth = r => r.set('Authorization', 'Bearer test');

let ple, gateOn;
// AssignSchema requires a uuid, so the fixture auditor needs a real one.
const AUD_UUID = '44444444-4444-4444-4444-444444444444';
const AUDITOR_ROW = { id: AUD_UUID, role: 'auditor', status: 'active', council_id: COUNCIL_A, specialty_id: null };

beforeEach(() => {
  m.reset();
  gateOn = 1;
  m.state.caller = { ...ADMIN };
  ple = { id: 'p1', ple_code: 'PLE-001', status: 'evaluated', council_id: COUNCIL_A, specialty_id: null,
          physician_id: 'phys-1', privacy_review_status: 'pending' };
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: gateOn };
    if (table === 'ples') return kind === 'list' ? { data: [ple], count: 1 } : ple;
    if (table === 'professionals') return AUDITOR_ROW;
    return undefined;
  };
});

const assign = () => auth(request(app).post('/admin/ples/p1/assign')).send({ auditor_id: AUD_UUID });

describe('EXPOSURE 1+2 — assignment', () => {
  test('an unreviewed session cannot be assigned to an auditor', async () => {
    const res = await assign();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('privacy_review_pending');
    expect(m.find('audit_assignments', 'upsert')).toBeUndefined(); // and nothing was written
  });

  test.each(['quarantined', 'excluded'])('a %s session cannot be assigned', async (st) => {
    ple.privacy_review_status = st;
    expect((await assign()).status).toBe(409);
  });

  test.each(['passed', 'redacted'])('a %s session assigns normally — redaction IS a clearance', async (st) => {
    ple.privacy_review_status = st;
    expect((await assign()).status).toBe(200);
  });

  test('the write is re-gated, so a clearance revoked mid-request cannot slip through', async () => {
    ple.privacy_review_status = 'passed';
    await assign();
    expect(m.find('ples', 'update').ins).toContainEqual(['privacy_review_status', ['passed', 'redacted']]);
  });

  test('with the gate switched off, an unreviewed session assigns — a recorded deviation, not a bypass', async () => {
    gateOn = 0;
    expect((await assign()).status).toBe(200);
  });
});

describe('EXPOSURE 3 — the stratified sampler', () => {
  test('the pool is filtered to cleared sessions: being sampled IS being handed to a rater', async () => {
    // An EMPTY pool on purpose. The sampler returns early on no rows, which is enough to observe the
    // filters it built — and avoids standing up doubles for ai_evaluations / audit_assignments /
    // ple_integrity_flags / professionals, none of which this test is about.
    m.state.resolve = (table, kind) => {
      if (table === 'app_settings') return { value: gateOn };
      if (table === 'ples') return kind === 'list' ? { data: [], count: 0 } : ple;
      return undefined;
    };
    const res = await auth(request(app).post('/admin/ples/sample')).send({ target: 1 });
    expect(res.status).toBe(200);
    const pool = m.all('ples', 'select').find(q => q.eqs.some(e => e[0] === 'status' && e[1] === 'evaluated'));
    expect(pool.ins).toContainEqual(['privacy_review_status', ['passed', 'redacted']]);
  });
});

describe('EXPOSURE 4 — the auditor queue', () => {
  test('a session quarantined AFTER assignment drops out of the queue', async () => {
    m.state.caller = { ...AUDITOR };
    await auth(request(app).get('/auditor/queue'));
    const q = m.all('ples', 'select').find(x => x.eqs.some(e => e[0] === 'status' && e[1] === 'evaluated'));
    expect(q.ins).toContainEqual(['privacy_review_status', ['passed', 'redacted']]);
  });
});

describe('recording the decision', () => {
  test('a decision stamps who, when, and what — for 100% of sessions, passes included', async () => {
    const res = await auth(request(app).post('/admin/ples/p1/privacy-review')).send({ decision: 'passed' });
    expect(res.status).toBe(200);
    expect(m.find('ples', 'update').payload).toMatchObject({
      privacy_review_status: 'passed', privacy_reviewed_by: ADMIN.id,
    });
    expect(m.find('ples', 'update').payload.privacy_reviewed_at).toEqual(expect.any(String));
  });

  test('anything other than a clean pass requires a note', async () => {
    const res = await auth(request(app).post('/admin/ples/p1/privacy-review')).send({ decision: 'quarantined' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('note_required');
    expect(m.find('ples', 'update')).toBeUndefined();
  });

  test('a quarantine WITH a note is accepted and the note is stored', async () => {
    const res = await auth(request(app).post('/admin/ples/p1/privacy-review'))
      .send({ decision: 'quarantined', note: 'HN visible in turn 3' });
    expect(res.status).toBe(200);
    expect(m.find('ples', 'update').payload).toMatchObject({ privacy_review_note: 'HN visible in turn 3' });
  });

  test('an invalid decision is rejected — the set is closed', async () => {
    expect((await auth(request(app).post('/admin/ples/p1/privacy-review')).send({ decision: 'approved' })).status).toBe(400);
  });

  test('a quarantine can be revisited — an irreversible one would destroy usable data', async () => {
    ple.privacy_review_status = 'quarantined';
    const res = await auth(request(app).post('/admin/ples/p1/privacy-review'))
      .send({ decision: 'redacted', note: 'HN removed' });
    expect(res.status).toBe(200);
    expect(res.body.privacy_review_status).toBe('redacted');
  });
});

describe('the queue', () => {
  test('defaults to pending — the queue is work, not a browsable archive', async () => {
    await auth(request(app).get('/admin/privacy-queue'));
    expect(m.find('ples', 'select').eqs).toContainEqual(['privacy_review_status', 'pending']);
  });

  test('a reviewer can revisit their own earlier decisions', async () => {
    await auth(request(app).get('/admin/privacy-queue?status=quarantined'));
    expect(m.find('ples', 'select').eqs).toContainEqual(['privacy_review_status', 'quarantined']);
  });
});

test('an unrecognised ?status falls back to pending, not to an empty list', async () => {
  // An arbitrary value used to pass straight into .eq(), match no rows, and render as "every session
  // has been reviewed" — the most misleading answer a privacy queue can give.
  await auth(request(app).get('/admin/privacy-queue?status=all-clear'));
  expect(m.find('ples', 'select').eqs).toContainEqual(['privacy_review_status', 'pending']);
});
