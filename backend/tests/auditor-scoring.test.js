// Auditor scoring seam: queue filter, the server-side BLIND-SCORING invariant, score guards
// (assigned / not-own / same-council), double-submit 409, and the ICC endpoint.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const request = require('supertest');
const express = require('express');
const { __mock: m } = require('../src/lib/supabase');
const { AUDITOR, COUNCIL_A, COUNCIL_B } = require('./helpers/roles');

const auditorRouter = require('../src/routes/auditor');
const app = express();
app.use(express.json());
app.use('/auditor', auditorRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

// The approved assessment form ends with a set of per-assessment confirmations, and the route now
// requires them. Folded into the shared body so every pre-existing case here keeps testing the thing
// it was written to test rather than the new gate.
const ATTEST = {
  all_domains_scored: true, comments_recorded: true, scored_independently: true,
  no_identifiers_found: true, weights_provisional: true,
};
const SCORES = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, attestations: ATTEST }; // composite = 3 * 1.0 * 20 = 60

let cle, existingScore, aiEval, queue, scoredRows, insertError;
beforeEach(() => {
  m.reset();
  m.state.caller = AUDITOR; // aud-1, council A
  cle = { id: 'p1', status: 'evaluated', auditor_id: AUDITOR.id, council_id: COUNCIL_A, physician_id: 'phys-1', turn_count: 5, token_count: 900, ended_at: 't' };
  existingScore = null;
  aiEval = { cle_id: 'p1', d1: 4, composite_score: 70 };
  queue = [{ id: 'p1', status: 'evaluated', ended_at: 't', turn_count: 5, token_count: 900 }];
  scoredRows = [];
  insertError = null;
  m.state.resolve = (table, kind) => {
    if (table === 'cles' && kind === 'list') return queue;             // GET /queue
    if (table === 'cles') return cle;                                  // score / detail lookup = single
    if (table === 'messages') return [];
    if (table === 'audit_scores' && kind === 'list') return scoredRows; // queue scored-flag / icc
    if (table === 'audit_scores' && (kind === 'single' || kind === 'maybeSingle')) return existingScore;
    if (table === 'audit_scores' && kind === 'insert') return { error: insertError };
    if (table === 'ai_evaluations') return aiEval;
    return undefined;
  };
});

test('scoring is blocked until the auditor has recorded consent (confidentiality + COI)', async () => {
  m.state.caller = { ...AUDITOR, consented_at: null }; // not yet consented
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('auditor_consent_required');
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});

test('GET /queue returns assigned evaluated CLEs with a scored flag', async () => {
  scoredRows = []; // none scored yet
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveLength(1);
  expect(r.body[0]).toMatchObject({ id: 'p1', scored: false });
  const q = m.find('cles');
  expect(q.eqs).toContainEqual(['auditor_id', AUDITOR.id]);
  expect(q.eqs).toContainEqual(['status', 'evaluated']);
});

test('BLIND: GET /auditor/cles/:id hides the AI score until the auditor has submitted', async () => {
  existingScore = null; // not yet scored
  const r = await auth(request(app).get('/auditor/cles/p1'));
  expect(r.status).toBe(200);
  expect(r.body.ai_evaluation).toBeNull();   // <- the invariant, enforced server-side
  expect(r.body.audit_score).toBeNull();
});

test('REVEAL: once a score exists, the AI evaluation is returned', async () => {
  existingScore = { id: 's1', cle_id: 'p1', composite_score: 60 };
  const r = await auth(request(app).get('/auditor/cles/p1'));
  expect(r.status).toBe(200);
  expect(r.body.audit_score).toMatchObject({ id: 's1' });
  expect(r.body.ai_evaluation).toMatchObject({ cle_id: 'p1', composite_score: 70 });
});

test('peer_calibration OFF (default): no peer_avg even after submit', async () => {
  existingScore = { id: 's1', cle_id: 'p1', composite_score: 60 };
  const r = await auth(request(app).get('/auditor/cles/p1'));
  expect(r.status).toBe(200);
  expect(r.body.peer_avg).toBeNull();
  expect(r.body.peer_n).toBe(0);
});

test('peer_calibration ON: peer_avg from the OTHER auditors once they have scored', async () => {
  existingScore = { id: 's1', cle_id: 'p1', composite_score: 60 };
  const prev = m.state.resolve;
  m.state.resolve = (table, kind) => {
    if (table === 'app_settings') return { value: 1 };                                   // peer_calibration ON
    if (table === 'audit_scores' && kind === 'list') return [{ d1:5,d2:5,d3:5,d4:5,d5:5,d6:5,d7:5 }]; // one OTHER auditor (self is excluded by .neq in the route)
    return prev(table, kind);
  };
  const r = await auth(request(app).get('/auditor/cles/p1'));
  expect(r.status).toBe(200);
  expect(r.body.peer_n).toBe(1);
  expect(r.body.peer_avg).toMatchObject({ d1: 5, d7: 5 });
});

test('GET /auditor/cles/:id not assigned to me → 404', async () => {
  cle = null; // the eq(auditor_id=me) filter returns nothing
  const r = await auth(request(app).get('/auditor/cles/p1'));
  expect(r.status).toBe(404);
});

test('POST score (happy) → 200 with computed composite; insert carries auditor_id + scores', async () => {
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(200);
  expect(r.body.composite_score).toBe(60);
  const ins = m.find('audit_scores', 'insert');
  expect(ins.payload).toMatchObject({ cle_id: 'p1', auditor_id: AUDITOR.id, d1: 3, composite_score: 60 });
});

test('double-submit (existing score) → 409, no insert', async () => {
  existingScore = { id: 's1' };
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(409);
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});

test('concurrent double-submit surfacing as 23505 from the unique constraint → 409', async () => {
  existingScore = null;          // friendly pre-check passes
  insertError = { code: '23505' }; // the DB unique backstop fires
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(409);
});

test('scoring a session not assigned to me → 403', async () => {
  cle.auditor_id = 'other-auditor';
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/not assigned/i);
});

test('scoring your own session → 403', async () => {
  cle.physician_id = AUDITOR.id;
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/own session/i);
});

test('cross-council scoring → 403', async () => {
  cle.council_id = COUNCIL_B;
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/cross-council/i);
});

test('out-of-range domain score → 400 (zod)', async () => {
  const r = await auth(request(app).post('/auditor/cles/p1/score')).send({ ...SCORES, d1: 9 });
  expect(r.status).toBe(400);
});

test('GET /auditor/icc returns an ICC object over the auditor\'s scored pairs', async () => {
  scoredRows = [{ cle_id: 'p1', composite_score: 60 }];
  aiEval = [{ cle_id: 'p1', composite_score: 62 }]; // ai_evaluations .in() list
  const r = await auth(request(app).get('/auditor/icc'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveProperty('icc');
});


// What the approved assessment form asks for, and what the surface was not capturing.
describe('the assessment form is recorded in full', () => {
  const post = (body) => auth(request(app).post('/auditor/cles/p1/score')).send(body);

  test('per-domain anchor clarity is persisted alongside the score', async () => {
    // Not decoration: the calibration workshop's stated output is a map of where anchors are
    // ambiguous, and the rubric may only be refined after the primary analysis. With nowhere to put
    // the judgement, the workshop produces a conversation and no evidence.
    const r = await post({ ...SCORES, d1_anchor: 'ambiguous', d4_anchor: 'clear' });
    expect(r.status).toBe(200);
    const ins = m.find('audit_scores', 'insert');
    expect(ins.payload).toMatchObject({ d1_anchor: 'ambiguous', d4_anchor: 'clear' });
  });

  test('a value outside the form\'s three choices is rejected', async () => {
    const r = await post({ ...SCORES, d1_anchor: 'very ambiguous indeed' });
    expect(r.status).toBe(400);
  });

  test('omitting anchor clarity does NOT block the rater', async () => {
    // A missing judgement is a missing judgement. Making it required would turn a field that informs
    // later rubric work into one that can stop an assessment being submitted at all.
    const r = await post(SCORES);
    expect(r.status).toBe(200);
  });

  test('the attestations are re-checked server-side, not just in the browser', async () => {
    // The submit control is disabled until every box is ticked. That is a courtesy to the rater; it
    // is not the gate. An assessment that reached the database without these is one the form says
    // was never completed, and no later analysis can tell the difference.
    const { scored_independently: _drop, ...partial } = ATTEST;
    const r = await post({ ...SCORES, attestations: partial });

    expect(r.status).toBe(400);
    expect(r.body.code).toBe('attestations_required');
    expect(r.body.missing).toEqual(['scored_independently']);
    expect(m.find('audit_scores', 'insert')).toBeUndefined();
  });

  test('a body with no attestations at all is refused', async () => {
    const { attestations: _a, ...noAttest } = SCORES;
    const r = await post(noAttest);
    expect(r.status).toBe(400);
    expect(r.body.missing).toHaveLength(5);
  });

  test('what was affirmed is stored, so a later change to the checklist cannot rewrite old records', async () => {
    await post(SCORES);
    expect(m.find('audit_scores', 'insert').payload.attestations).toMatchObject(ATTEST);
  });
});

// The form tells a rater who sees possible patient data to stop and notify the research team. Until
// now the only options were to score it anyway or to say nothing.
describe('reporting a suspected identifier instead of scoring', () => {
  const report = (body) => auth(request(app).post('/auditor/cles/p1/privacy-concern')).send(body);

  test('the session is quarantined, with the reason and the reporter recorded', async () => {
    const r = await report({ note: 'turn 3 names a hospital and a date' });
    expect(r.status).toBe(200);

    const upd = m.find('cles', 'update');
    expect(upd.payload).toMatchObject({
      privacy_review_status: 'quarantined',
      privacy_reviewed_by: AUDITOR.id,
      privacy_review_note: 'turn 3 names a hospital and a date',
    });
  });

  test('no score is created — reporting is instead of scoring, not as well as', async () => {
    await report({ note: 'possible identifier' });
    expect(m.find('audit_scores', 'insert')).toBeUndefined();
  });

  test('quarantine is what removes it from the queue — no second mechanism needed', async () => {
    // whereCleared() withholds anything not passed/redacted, so the session leaves this auditor's
    // queue as a consequence of the clearance change rather than a parallel "hidden" flag.
    const { CLEARED } = require('../src/lib/privacy-review');
    expect(CLEARED).not.toContain('quarantined');
  });

  test('an empty report is refused — a concern with no reason cannot be actioned', async () => {
    expect((await report({ note: '' })).status).toBe(400);
  });
});

// Hardening found by adversarial review of the first cut.
describe('reporting a concern cannot be misused', () => {
  const report = (body) => auth(request(app).post('/auditor/cles/p1/privacy-concern')).send(body);

  test('a dual-role rater cannot quarantine their OWN session', async () => {
    // The score route has always refused this. The report route did not, which made it a way to
    // withdraw a session from the study without withdrawing from the study.
    const prev = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => {
      const r = prev(table, kind, ctx);
      return table === 'cles' && r && !Array.isArray(r) ? { ...r, physician_id: AUDITOR.id } : r;
    };
    expect((await report({ note: 'mine' })).status).toBe(403);
    expect(m.find('cles', 'update')).toBeUndefined();
  });

  test('a session already quarantined is not re-reported over the top', async () => {
    // Re-reporting would overwrite the first reviewer's note and reset the clock on something
    // somebody is already looking at.
    const prev = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => {
      const r = prev(table, kind, ctx);
      return table === 'cles' && r && !Array.isArray(r) ? { ...r, privacy_review_status: 'quarantined' } : r;
    };
    const res = await report({ note: 'again' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_quarantined');
  });

  test('a whitespace-only reason is refused, not stored', async () => {
    // min(1) accepted "   " and quarantined a session with a reason nobody could act on.
    expect((await report({ note: '   ' })).status).toBe(400);
    expect(m.find('cles', 'update')).toBeUndefined();
  });
});

test('an attestation the form never asked for cannot be smuggled into the record', async () => {
  // z.record() accepted any boolean key and the route stored the whole object, so a caller could
  // persist `approved_by_admin: true` beside the real confirmations.
  const r = await auth(request(app).post('/auditor/cles/p1/score'))
    .send({ ...SCORES, attestations: { ...ATTEST, approved_by_admin: true } });
  expect(r.status).toBe(400);
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});
