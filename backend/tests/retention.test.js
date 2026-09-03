// Data retention / de-identification (CREC082 DMP §8, ICF §11) and the monthly security review.
//
// This is the most destructive code in the repo: one call clears the identity vault, the national
// IDs, the PII maps and the patient references. Everything below exists to pin the guards, not the
// happy path — the happy path is one line and the guards are the product.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { SUPERADMIN, ADMIN } = require('./helpers/roles');
const retention = require('../src/services/retention');

const app = express();
app.use(express.json());
// Mounted at '/admin' because that is where src/index.js mounts it. A test app free to pick its
// own prefix is how three screens shipped calling a path production does not serve — see
// tests/api-contract.test.js.
app.use('/admin', require('../src/routes/superadmin'));
const auth = r => r.set('Authorization', 'Bearer test');

const PHRASE = retention.CONFIRM_PHRASE;
let settings;
const iso = (d) => d.toISOString().slice(0, 10);
const yearsFromNow = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return iso(d); };

beforeEach(() => {
  m.reset();
  m.state.caller = { ...SUPERADMIN };
  settings = {};   // key -> { value, value_text }
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') {
      const key = (ctx.eqs.find(e => e[0] === 'key') || [])[1];
      return settings[key] ?? null;
    }
    if (table === 'security_reviews') return kind === 'list' ? { data: [], count: 0 } : {};
    return kind === 'list' ? { data: [], count: 0 } : {};   // target counts
  };
});

const setPolicy = (endDate, years = 5) => {
  settings.project_end_date = { value: 0, value_text: endDate };
  settings.retention_years = { value: years, value_text: null };
};
const deidentify = (confirm) => auth(request(app).post('/admin/retention/deidentify')).send({ confirm });

describe('the clock cannot start on its own', () => {
  test('with no project end date, nothing is due and nothing can run', async () => {
    const res = await auth(request(app).get('/admin/retention'));
    expect(res.body).toMatchObject({ project_end_date: null, due_at: null, due: false });

    const run = await deidentify(PHRASE);
    expect(run.status).toBe(409);
    expect(run.body.code).toBe('no_project_end_date');
  });

  test('the due date is project end + retention years', async () => {
    setPolicy('2026-12-31', 5);
    const res = await auth(request(app).get('/admin/retention'));
    expect(res.body).toMatchObject({ project_end_date: '2026-12-31', retention_years: 5, due_at: '2031-12-31', due: false });
  });
});

describe('refusals', () => {
  test('before the deadline it refuses, even with the exact phrase', async () => {
    setPolicy(yearsFromNow(1));   // due in ~6 years
    const res = await deidentify(PHRASE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_yet_due');
    expect(m.all('oauth_identities', 'delete')).toHaveLength(0);
  });

  test('after the deadline it still refuses without the exact phrase', async () => {
    setPolicy('2000-01-01');   // long past due
    for (const bad of ['', 'yes', 'confirm', PHRASE.toLowerCase(), PHRASE + ' ', 'DE-IDENTIFY']) {
      const res = await deidentify(bad);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('confirmation_mismatch');
    }
    // Nothing was touched by any of those attempts.
    expect(m.all('oauth_identities', 'delete')).toHaveLength(0);
    expect(m.all('professionals', 'update')).toHaveLength(0);
  });

  test('the phrase is long and specific — a one-word confirmation cannot reach this endpoint', () => {
    expect(PHRASE.length).toBeGreaterThan(20);
    expect(PHRASE.split(/\s+/).length).toBeGreaterThanOrEqual(4);
  });

  test('an admin cannot reach it at all — superadmin only', async () => {
    m.state.caller = { ...ADMIN };
    setPolicy('2000-01-01');
    expect((await deidentify(PHRASE)).status).toBe(403);
  });
});

describe('what it does when it does run', () => {
  beforeEach(() => setPolicy('2000-01-01'));

  test('the identity vault, national IDs, PII maps and patient refs are deleted', async () => {
    const res = await deidentify(PHRASE);
    expect(res.status).toBe(200);
    for (const t of ['oauth_identities', 'identity_verifications', 'ple_pii_map', 'ple_patient_refs']) {
      expect(m.find(t, 'delete')).toBeDefined();
    }
  });

  test('professionals is NULLIFIED, not deleted — the row is a research variable', async () => {
    await deidentify(PHRASE);
    // Deleting it would cascade the PLEs it owns and destroy the study; clearing the name/email/
    // licence columns while keeping the pseudonym IS "ทำให้ไม่สามารถเชื่อมโยงกลับได้".
    expect(m.find('professionals', 'delete')).toBeUndefined();
    const upd = m.find('professionals', 'update');
    expect(upd.payload).toEqual({ full_name_th: null, full_name_en: null, email: null, license_number: null });
    expect(upd.payload).not.toHaveProperty('pseudonym');   // the pseudonym survives
  });

  test('financial data is NOT swept — §8 puts it under accounting rules, a separate clock', async () => {
    await deidentify(PHRASE);
    for (const t of ['payment_info', 'payouts']) {
      expect(m.find(t, 'delete')).toBeUndefined();
      expect(m.find(t, 'update')).toBeUndefined();
    }
    // ...and the exclusion is documented, not merely absent.
    expect(retention.EXCLUDED_BY_POLICY.map(e => e.table)).toEqual(expect.arrayContaining(['payment_info', 'payouts']));
  });

  test('audit_log is excluded — erasing the record of the operation would defeat it', async () => {
    await deidentify(PHRASE);
    expect(m.find('audit_log', 'delete')).toBeUndefined();
    expect(retention.EXCLUDED_BY_POLICY.map(e => e.table)).toContain('audit_log');
  });

  test('every target carries a written reason, so a later reader can check the decision', () => {
    for (const t of [...retention.IDENTITY_TARGETS, ...retention.EXCLUDED_BY_POLICY]) {
      expect(t.why.length).toBeGreaterThan(40);
    }
    // A nullify target must name its columns, or it would silently do nothing.
    for (const t of retention.IDENTITY_TARGETS.filter(t => t.action === 'nullify')) {
      expect(t.columns.length).toBeGreaterThan(0);
    }
  });
});

describe('there is no scheduler, deliberately', () => {
  test('no scheduler invokes the de-identification', () => {
    // The deadline is ~2031. A cron written now and left unattended for five years, running
    // irreversible deletes against a schema that will have changed repeatedly, is a larger risk
    // than the one it manages. Schedulers live in src/index.js; it must not reach this service.
    //
    // Asserted against index.js rather than by grepping for the word "cron", which matched
    // retention.js itself — the file whose comment explains why there is no cron.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/index.js'), 'utf8');
    expect(src).toMatch(/setInterval/);              // the file really is where schedulers live...
    expect(src).not.toMatch(/retention|deidentify/i); // ...and none of them touches this one.
  });
});

describe('the monthly security review', () => {
  const post = (body) => auth(request(app).post('/admin/security-reviews')).send(body);

  test('records the three parts the Infrastructure Statement names', async () => {
    const res = await post({
      period_month: '2026-08',
      access_review: 'roles checked, 2 dormant accounts disabled',
      audit_review: 'no anomalies in audit_log',
      incident_review: 'none',
    });
    expect(res.status).toBe(200);
    expect(m.find('security_reviews', 'upsert').payload).toMatchObject({
      period_month: '2026-08-01', reviewed_by: SUPERADMIN.id,
      access_review: expect.any(String), audit_review: expect.any(String), incident_review: expect.any(String),
    });
  });

  test('an all-blank review is refused — it would assert a review with no evidence of one', async () => {
    const res = await post({ period_month: '2026-08', incidents_found: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('empty_review');
    expect(m.find('security_reviews', 'upsert')).toBeUndefined();
  });

  test('the month is normalised to its first day, so the unique index enforces one per month', async () => {
    await post({ period_month: '2026-08', access_review: 'x' });
    expect(m.find('security_reviews', 'upsert').payload.period_month).toBe('2026-08-01');
  });

  test('"found nothing" and "did not look" are different facts', async () => {
    await post({ period_month: '2026-08', incident_review: 'reviewed, none found', incidents_found: false });
    expect(m.find('security_reviews', 'upsert').payload).toMatchObject({ incidents_found: false, incident_review: 'reviewed, none found' });
  });

  test('a malformed month is rejected', async () => {
    expect((await post({ period_month: 'August 2026', access_review: 'x' })).status).toBe(400);
  });
});
