// POST /ples/:id/messages/:messageId/report — a physician reports an unsafe or wrong AI tutor reply.
//
// This is the "safety event log" CREC082's Risk & Incident Plan commits to, built on the integrity-flag
// table. The properties that matter, each pinned below:
//   - only the PLE's owner can report, and only an ASSISTANT message of THAT PLE
//   - it is idempotent per message (the first report stands) and merges, not overwrites, across messages
//   - the flag carries the reply's provider / model / prompt_version, read server-side...
//   - ...and NONE of that, nor the new-vs-repeat distinction, reaches the physician
//   - the free-text note (possible PII) is bounded, sanitised, kept off the audit log, and no AI is called
//   - it is rate limited per physician, and it never steers the audit sample
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const mockRimpl = { rimplChat: jest.fn(), rimplAuditDiscuss: jest.fn() };
jest.mock('../src/services/rimpl-client', () => mockRimpl);

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { PHYSICIAN, ADMIN, COUNCIL_A } = require('./helpers/roles');
const { REPORT_REASONS, REPORT_NOTE_MAX } = require('../src/lib/schemas');
const {
  DETECTOR_SIGNALS, REPORTED_REPLY_SIGNAL, REPORT_SEVERITY, MAX_REPORTS_PER_PLE,
} = require('../src/services/integrity-scan');

const app = express();
app.use(express.json());
app.use('/ples', require('../src/routes/ples'));
app.use('/admin', require('../src/routes/admin'));
const auth = (r) => r.set('Authorization', 'Bearer test');

const PLE_ID = 'ple-1';
const OTHER_PLE_ID = 'ple-2';
const AI_ID = '11111111-1111-4111-8111-111111111111';
const AI_ID_2 = '22222222-2222-4222-8222-222222222222';
// A fresh physician id per test: the report limiter keeps its counters in memory for the life of the
// module, so a shared id would burn the 20-per-window allowance across unrelated tests.
let PHYS_ID;
let seq = 0;
const OWN_MSG_ID = '55555555-5555-4555-8555-555555555555';
const FOREIGN_ID = '44444444-4444-4444-8444-444444444444';
const PROV = { provider: 'local', model: 'deepseek-v4-flash-dspark', prompt_version: 'chat-prompt-1a2b3c4d' };

// A stateful stand-in for the three tables the route touches. ownedBy / ple_id are honoured the way
// PostgREST would honour the route's .eq() filters — a double that returns the row regardless of the
// filter would make the ownership tests pass on a route that checked nothing.
let store;
function wire(over = {}) {
  seq += 1;
  PHYS_ID = `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`;
  store = {
    ples: [{ id: PLE_ID, physician_id: PHYS_ID, council_id: COUNCIL_A }, { id: OTHER_PLE_ID, physician_id: 'someone-else', council_id: COUNCIL_A }],
    messages: [
      { id: AI_ID, ple_id: PLE_ID, role: 'assistant', created_at: '2026-10-01T10:00:02Z', ...PROV },
      { id: AI_ID_2, ple_id: PLE_ID, role: 'assistant', created_at: '2026-10-01T10:01:02Z', provider: 'anthropic', model: 'claude-x', prompt_version: 'chat-prompt-ffff0000' },
      { id: OWN_MSG_ID, ple_id: PLE_ID, role: 'physician', created_at: '2026-10-01T10:00:01Z' },
      { id: FOREIGN_ID, ple_id: OTHER_PLE_ID, role: 'assistant', created_at: '2026-10-01T09:00:00Z', ...PROV },
    ],
    flag: null,               // the single (ple, signal) row
    assistantCount: 2,
    dropNextFlagWrite: false, // simulate a concurrent writer clobbering our upsert once
    ...over,
  };
  m.reset();
  m.state.caller = { ...PHYSICIAN, id: PHYS_ID };
  m.state.resolve = (table, kind, ctx) => {
    const eq = (c) => (ctx.eqs.find((e) => e[0] === c) || [])[1];
    if (table === 'ples') {
      const row = store.ples.find((p) => p.id === eq('id') && p.physician_id === eq('physician_id'));
      return row ?? { data: null, error: { message: 'no rows' } };
    }
    if (table === 'messages') {
      if (ctx.selectArgs?.[1]?.head) return { data: null, count: store.assistantCount };
      return store.messages.find((x) => x.id === eq('id') && x.ple_id === eq('ple_id')) ?? null;
    }
    if (table === 'ple_integrity_flags') {
      if (ctx.op === 'upsert') {
        if (store.dropNextFlagWrite) { store.dropNextFlagWrite = false; return undefined; }
        store.flag = ctx.payload;
        return undefined;
      }
      return store.flag ?? null;
    }
    return undefined;
  };
}

const report = (body = { reason: 'wrong_fact' }, { ple = PLE_ID, msg = AI_ID } = {}) =>
  auth(request(app).post(`/ples/${ple}/messages/${msg}/report`)).send(body);
const upserts = () => m.all('ple_integrity_flags', 'upsert');

beforeEach(() => { wire(); jest.clearAllMocks(); });

describe('recording a report', () => {
  test('writes ONE integrity flag carrying the reason, the note and the reply\'s provenance', async () => {
    const r = await report({ reason: 'unsafe_advice', note: 'dose is 10x too high' });
    expect(r.status).toBe(200);
    expect(upserts()).toHaveLength(1);
    expect(upserts()[0].payload).toMatchObject({ ple_id: PLE_ID, signal: REPORTED_REPLY_SIGNAL, severity: 'high' });
    expect(store.flag.evidence.report_count).toBe(1);
    expect(store.flag.evidence.reports[0]).toMatchObject({
      message_id: AI_ID, reason: 'unsafe_advice', note: 'dose is 10x too high', turn: 2, ...PROV,
    });
    expect(store.flag.evidence.reports[0].reported_at).toEqual(expect.any(String));
  });

  test('upserts on (ple_id, signal) like the rescue flag, so a re-run never accumulates rows', async () => {
    await report();
    // The row key is what makes "one row per PLE" true; losing it would turn this into an INSERT
    // that violates the unique constraint on the second report.
    expect(m.find('ple_integrity_flags', 'upsert')).toBeDefined();
  });

  test('a report with no note stores null, not an empty string', async () => {
    await report({ reason: 'other', note: '   ' });
    expect(store.flag.evidence.reports[0].note).toBeNull();
  });

  test('is audit-logged with the provenance — and WITHOUT the note, which may carry PII', async () => {
    await report({ reason: 'wrong_language', note: 'patient name is Somchai' });
    const log = m.find('audit_log', 'insert').payload;
    expect(log).toMatchObject({ actor_id: PHYS_ID, action: 'ple.reply_reported', target_type: 'ple', target_id: PLE_ID, council_id: COUNCIL_A });
    expect(log.metadata).toMatchObject({ message_id: AI_ID, reason: 'wrong_language', has_note: true, ...PROV });
    expect(JSON.stringify(log)).not.toContain('Somchai');
  });

  test('never calls an AI — the note is physician-typed and may contain PII', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('network is off limits'); });
    try {
      expect((await report({ reason: 'other', note: 'x' })).status).toBe(200);
      expect(mockRimpl.rimplChat).not.toHaveBeenCalled();
      expect(mockRimpl.rimplAuditDiscuss).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('is not behind the consent or budget gates: a physician who has hit the cap can still report', async () => {
    m.state.caller = { ...PHYSICIAN, id: PHYS_ID, consented_at: null, usage_cost_usd: 99 };
    expect((await report()).status).toBe(200);
  });
});

describe('the response leaks nothing', () => {
  test('is exactly { ok: true } — no provenance, no flag, no severity', async () => {
    const r = await report({ reason: 'unsafe_advice', note: 'n' });
    expect(r.body).toEqual({ ok: true });
    const wire_ = JSON.stringify(r.body) + JSON.stringify(r.headers);
    for (const secret of [PROV.model, PROV.provider, PROV.prompt_version, 'severity', REPORTED_REPLY_SIGNAL]) {
      expect(wire_).not.toContain(secret);
    }
  });

  test('a repeat report answers identically, so the physician cannot probe what was stored', async () => {
    const first = await report({ reason: 'wrong_fact' });
    const second = await report({ reason: 'unsafe_advice' });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });
});

describe('ownership and message validity', () => {
  test('a PLE the physician does not own is 404 — and no message or flag is touched', async () => {
    const r = await report({ reason: 'wrong_fact' }, { ple: OTHER_PLE_ID, msg: FOREIGN_ID });
    expect(r.status).toBe(404);
    expect(upserts()).toHaveLength(0);
    expect(m.all('messages')).toHaveLength(0);
    // The ownership filter must actually be in the query, not merely in the double.
    const q = m.find('ples');
    expect(q.eqs).toContainEqual(['physician_id', PHYS_ID]);
  });

  test('a message from ANOTHER session is 404, even one the physician could name', async () => {
    const r = await report({ reason: 'wrong_fact' }, { ple: PLE_ID, msg: FOREIGN_ID });
    expect(r.status).toBe(404);
    expect(upserts()).toHaveLength(0);
    expect(m.find('messages').eqs).toContainEqual(['ple_id', PLE_ID]);
  });

  test('a physician message cannot be reported — only an AI reply — 400 not_ai_reply', async () => {
    const r = await report({ reason: 'wrong_fact' }, { msg: OWN_MSG_ID });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('not_ai_reply');
    expect(upserts()).toHaveLength(0);
  });

  test('a message id that does not exist is 404', async () => {
    const r = await report({ reason: 'wrong_fact' }, { msg: '99999999-9999-4999-8999-999999999999' });
    expect(r.status).toBe(404);
    expect(upserts()).toHaveLength(0);
  });

  test('a malformed message id is 404 without touching the database', async () => {
    const r = await report({ reason: 'wrong_fact' }, { msg: 'not-a-uuid' });
    expect(r.status).toBe(404);
    expect(m.all('ples')).toHaveLength(0);
    expect(m.all('messages')).toHaveLength(0);
  });

  test('a database error reading the message is a 500, never a silent success', async () => {
    const base = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => (table === 'messages' && !ctx.selectArgs?.[1]?.head ? { data: null, error: { message: 'boom' } } : base(table, kind, ctx));
    expect((await report()).status).toBe(500);
    expect(upserts()).toHaveLength(0);
  });

  test('a failure writing the flag is a 500 the physician is told about — a lost safety report must not look saved', async () => {
    const base = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => (table === 'ple_integrity_flags' && ctx.op === 'upsert' ? { data: null, error: { message: 'boom' } } : base(table, kind, ctx));
    const r = await report();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/try again/i);
    expect(m.find('audit_log')).toBeUndefined();   // nothing was recorded, so nothing is logged
  });
});

describe('input validation', () => {
  test.each(REPORT_REASONS)('accepts the reason %s', async (reason) => {
    expect((await report({ reason })).status).toBe(200);
  });

  test('rejects an unknown or missing reason with 400 and writes nothing', async () => {
    expect((await report({ reason: 'rude' })).status).toBe(400);
    expect((await report({})).status).toBe(400);
    expect((await report({ note: 'only a note' })).status).toBe(400);
    expect(upserts()).toHaveLength(0);
  });

  test('caps the note at REPORT_NOTE_MAX characters', async () => {
    expect((await report({ reason: 'other', note: 'x'.repeat(REPORT_NOTE_MAX) })).status).toBe(200);
    wire();
    expect((await report({ reason: 'other', note: 'x'.repeat(REPORT_NOTE_MAX + 1) })).status).toBe(400);
    expect(upserts()).toHaveLength(0);
  });

  test('strips control characters — a NUL is legal JSON but Postgres jsonb refuses it', async () => {
    await report({ reason: 'other', note: 'a\u0000b\u0007c\nline two\tend' });
    expect(store.flag.evidence.reports[0].note).toBe('abc\nline two\tend');
  });

  test('keeps Thai text intact', async () => {
    await report({ reason: 'wrong_fact', note: 'ขนาดยาผิด' });
    expect(store.flag.evidence.reports[0].note).toBe('ขนาดยาผิด');
  });
});

describe('idempotency and merging', () => {
  test('a second report on the SAME reply changes nothing — the first reason and note stand', async () => {
    await report({ reason: 'wrong_fact', note: 'first' });
    const before = JSON.stringify(store.flag);
    const r = await report({ reason: 'unsafe_advice', note: 'second' });
    expect(r.status).toBe(200);
    expect(upserts()).toHaveLength(1);                 // no second write
    expect(JSON.stringify(store.flag)).toBe(before);
    expect(m.all('audit_log', 'insert')).toHaveLength(1); // and no second audit event
  });

  test('a report on a DIFFERENT reply is merged into the same row, not overwritten', async () => {
    await report({ reason: 'wrong_fact' }, { msg: AI_ID });
    await report({ reason: 'fabricated_reference' }, { msg: AI_ID_2 });
    expect(store.flag.evidence.report_count).toBe(2);
    expect(store.flag.evidence.reports.map((x) => x.message_id)).toEqual([AI_ID, AI_ID_2]);
    // Each entry keeps the provenance of ITS OWN reply — a hybrid session has more than one model.
    expect(store.flag.evidence.reports.map((x) => x.provider)).toEqual(['local', 'anthropic']);
  });

  test('the row carries the WORST severity across its reports, and never lowers it', async () => {
    await report({ reason: 'unsafe_advice' }, { msg: AI_ID });
    expect(store.flag.severity).toBe('high');
    await report({ reason: 'other' }, { msg: AI_ID_2 });
    expect(store.flag.severity).toBe('high');
  });

  test('severity by reason: only unsafe advice is high', () => {
    expect(REPORT_SEVERITY).toEqual({
      unsafe_advice: 'high', wrong_fact: 'medium', fabricated_reference: 'medium', wrong_language: 'low', other: 'low',
    });
    expect(Object.keys(REPORT_SEVERITY).sort()).toEqual([...REPORT_REASONS].sort());
  });

  test('a write clobbered by a concurrent report is detected by the read-back and retried', async () => {
    store.dropNextFlagWrite = true;
    const r = await report({ reason: 'wrong_fact' });
    expect(r.status).toBe(200);
    expect(upserts()).toHaveLength(2);
    expect(store.flag.evidence.reports.map((x) => x.message_id)).toEqual([AI_ID]);
  });

  test('if every retry is clobbered the physician is told it failed, not that it worked', async () => {
    const base = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => (table === 'ple_integrity_flags' && ctx.op === 'upsert' ? undefined : base(table, kind, ctx));
    expect((await report()).status).toBe(500);
  });

  test('a session at the report cap answers 429 report_limit_reached and writes nothing more', async () => {
    const reports = Array.from({ length: MAX_REPORTS_PER_PLE }, (_, i) => ({ message_id: `m-${i}`, reason: 'other' }));
    store.flag = { severity: 'low', evidence: { reports } };
    const r = await report();
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('report_limit_reached');
    expect(upserts()).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  test('is capped per physician: the 21st report inside the window is 429 report_rate_limited', async () => {
    // wire() gave this test a physician nobody else has used, so the counter starts at zero.
    const statuses = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await report({ reason: 'other' })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  test("one physician's volume does not throttle another", async () => {
    for (let i = 0; i < 21; i += 1) await report({ reason: 'other' }, { msg: AI_ID });   // exhaust this physician
    const first = PHYS_ID;
    wire();                                                                                 // a different physician
    expect(PHYS_ID).not.toBe(first);
    expect((await report()).status).toBe(200);
  });
});

describe('it is a safety event, not a gaming flag', () => {
  test('the detector\'s wholesale replace never deletes it', () => {
    expect(DETECTOR_SIGNALS).not.toContain(REPORTED_REPLY_SIGNAL);
  });

  test('the audit sampler excludes it from the forced-inclusion set', async () => {
    m.state.caller = ADMIN;
    m.state.resolve = (table, kind) => {
      if (table === 'app_settings') return { value: 0 };
      if (table === 'ples' && kind === 'list') {
        return { data: [{ id: PLE_ID, ple_code: 'PLE-1', council_id: COUNCIL_A, specialty_id: null, physician_id: PHYS_ID, auditor_id: null, is_test: false }] };
      }
      return undefined;
    };
    await auth(request(app).post('/admin/ples/sample')).send({ target: 1 });
    const q = m.find('ple_integrity_flags');
    expect(q).toBeDefined();
    expect(q.neqs).toContainEqual(['signal', REPORTED_REPLY_SIGNAL]);
  });
});

describe('vocabulary mirrors', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

  test('physician-ui offers exactly the reasons the API accepts, in the same order', () => {
    const src = read('physician-ui', 'public', 'js', 'ple-chat.js');
    const block = /const REPORT_REASONS = \[([\s\S]*?)\n\];/.exec(src);
    expect(block).not.toBeNull();
    const keys = [...block[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((x) => x[1]);
    expect(keys).toEqual(REPORT_REASONS);
  });

  test('physician-ui caps the note at the length the API enforces', () => {
    const src = read('physician-ui', 'public', 'js', 'ple-chat.js');
    expect(new RegExp(`REPORT_NOTE_MAX = ${REPORT_NOTE_MAX}\\b`).test(src)).toBe(true);
  });

  test('every reason has a severity, so no report can reach the queue unranked', () => {
    for (const reason of REPORT_REASONS) expect(['low', 'medium', 'high']).toContain(REPORT_SEVERITY[reason]);
  });
});
