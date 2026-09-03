// Brief acceptability questionnaire (CREC082 ICF §3 step 4, Protocol objective 5).
//
// A named SECONDARY OUTCOME in the SAP: without it there is nothing to report on acceptability,
// time burden, or the privacy experience. One response per physician, at the end of participation.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN } = require('./helpers/roles');
const acceptability = require('../src/lib/acceptability');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
const auth = r => r.set('Authorization', 'Bearer test');

let completed, existing;
beforeEach(() => {
  m.reset();
  m.state.caller = { ...PHYSICIAN };
  completed = 2;
  existing = null;
  m.state.resolve = (table, kind, ctx) => {
    if (table === 'app_settings') return { value: 0 };
    if (table === 'ples') return { data: [], count: completed };
    if (table === 'acceptability_responses') return ctx.op === 'upsert' ? {} : existing;
    return undefined;
  };
});

const post = (body) => auth(request(app).post('/ples/acceptability')).send(body);

describe('routing', () => {
  test('GET /ples/acceptability is not swallowed by GET /ples/:id', async () => {
    // Express matches in definition order. Registered after the /:id route, this resolves as
    // id='acceptability' and the questionnaire is simply unreachable — a failure that looks like a
    // missing feature rather than a routing bug.
    const res = await auth(request(app).get('/ples/acceptability'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe('the instrument travels with the request', () => {
  test('items, scale, and version come from the server — the portal keeps no second copy', async () => {
    const res = await auth(request(app).get('/ples/acceptability'));
    expect(res.body.items).toHaveLength(acceptability.ITEMS.length);
    expect(res.body.scale).toEqual({ min: 1, max: 5 });
    expect(res.body.instrument_version).toBe(acceptability.INSTRUMENT_VERSION);
    // Every item is bilingual and carries its protocol domain.
    for (const i of res.body.items) {
      expect(i).toMatchObject({ key: expect.any(String), domain: expect.any(String), th: expect.any(String), en: expect.any(String) });
    }
  });

  test('the stored answers carry the instrument version, so wordings are never pooled', async () => {
    await post({ answers: { acceptable: 5 } });
    expect(m.find('acceptability_responses', 'upsert').payload.answers)
      .toMatchObject({ acceptable: 5, _instrument_version: acceptability.INSTRUMENT_VERSION });
  });
});

describe('eligibility follows the protocol, not the 3-PLE cap', () => {
  test('one completed PLE is enough — an early withdrawal may still answer', async () => {
    completed = 1;
    const res = await auth(request(app).get('/ples/acceptability'));
    expect(res.body.eligible).toBe(true);
    expect((await post({ answers: { acceptable: 4 } })).status).toBe(200);
  });

  test('no completed PLE → not eligible, and the post is refused', async () => {
    completed = 0;
    expect((await auth(request(app).get('/ples/acceptability'))).body.eligible).toBe(false);
    const res = await post({ answers: { acceptable: 4 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_completed_ple');
  });

  test('completed counts BOTH terminal statuses, not the transient ple_pass alone', async () => {
    await auth(request(app).get('/ples/acceptability'));
    expect(m.find('ples', 'select').ins).toContainEqual(['status', ['ple_pass', 'evaluated']]);
  });
});

describe('answering is voluntary and partial answers are kept', () => {
  test('a blank item is dropped, not rejected — the rest of the response survives', async () => {
    const res = await post({ answers: { acceptable: 5, fair: '', would_use: 3 } });
    expect(res.status).toBe(200);
    const stored = m.find('acceptability_responses', 'upsert').payload.answers;
    expect(stored).toMatchObject({ acceptable: 5, would_use: 3 });
    expect(stored).not.toHaveProperty('fair');
  });

  test('skipping the whole questionnaire is recorded, with no answers kept', async () => {
    const res = await post({ skipped: true, answers: { acceptable: 5 }, comments: 'ignored' });
    expect(res.status).toBe(200);
    const p = m.find('acceptability_responses', 'upsert').payload;
    expect(p).toMatchObject({ skipped: true, comments: null });
    expect(p.answers).toEqual({ _instrument_version: acceptability.INSTRUMENT_VERSION });
  });

  test('free-text comments are stored — "ข้อเสนอแนะ" is a named secondary outcome', async () => {
    await post({ answers: {}, comments: '  ควรมีเวลามากกว่านี้  ' });
    expect(m.find('acceptability_responses', 'upsert').payload.comments).toBe('ควรมีเวลามากกว่านี้');
  });
});

describe('validation', () => {
  test.each([
    ['out of scale', { acceptable: 9 }, 'out_of_scale'],
    ['non-integer',  { acceptable: 2.5 }, 'out_of_scale'],
    ['unknown item', { made_up: 3 }, 'unknown_item'],
  ])('%s → 400 %s, nothing stored', async (_l, answers, code) => {
    const res = await post({ answers });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(m.find('acceptability_responses', 'upsert')).toBeUndefined();
  });

  test('resubmitting corrects the one response rather than adding a second', async () => {
    await post({ answers: { acceptable: 3 } });
    await post({ answers: { acceptable: 5 } });
    // Unique on physician_id: the questionnaire is about the SYSTEM, not a session.
    expect(m.all('acceptability_responses', 'upsert')).toHaveLength(2);
    expect(m.find('acceptability_responses', 'upsert').payload.physician_id).toBe(PHYSICIAN.id);
  });

  test('no answer content reaches the audit log — responses belong in one place', async () => {
    await post({ answers: { acceptable: 5 }, comments: 'secret feedback' });
    const logged = m.all('audit_log', 'insert');
    for (const l of logged) expect(JSON.stringify(l.payload)).not.toContain('secret feedback');
  });
});
