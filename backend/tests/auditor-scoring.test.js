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

let ple, existingScore, aiEval, queue, scoredRows, insertError;
beforeEach(() => {
  m.reset();
  m.state.caller = AUDITOR; // aud-1, council A
  ple = {
    id: 'p1', status: 'evaluated', auditor_id: AUDITOR.id, council_id: COUNCIL_A,
    physician_id: 'phys-1', turn_count: 5, token_count: 900, ended_at: 't',
    privacy_review_status: 'passed', privacy_concern_open: false,
  };
  existingScore = null;
  aiEval = { ple_id: 'p1', d1: 4, composite_score: 70 };
  queue = [{ id: 'p1', status: 'evaluated', ended_at: 't', turn_count: 5, token_count: 900 }];
  scoredRows = [];
  insertError = null;
  m.state.resolve = (table, kind) => {
    if (table === 'ples' && kind === 'list') return queue;             // GET /queue
    if (table === 'ples') return ple;                                  // score / detail lookup = single
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
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('auditor_consent_required');
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});

test('GET /queue returns assigned evaluated PLEs with a scored flag', async () => {
  scoredRows = []; // none scored yet
  const r = await auth(request(app).get('/auditor/queue'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveLength(1);
  expect(r.body[0]).toMatchObject({ id: 'p1', scored: false });
  const q = m.find('ples');
  expect(q.eqs).toContainEqual(['auditor_id', AUDITOR.id]);
  expect(q.eqs).toContainEqual(['status', 'evaluated']);
});

test('BLIND: GET /auditor/ples/:id hides the AI score until the auditor has submitted', async () => {
  existingScore = null; // not yet scored
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.ai_evaluation).toBeNull();   // <- the invariant, enforced server-side
  expect(r.body.audit_score).toBeNull();
});

test('REVEAL: once a score exists, the AI evaluation is returned', async () => {
  existingScore = { id: 's1', ple_id: 'p1', composite_score: 60 };
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.audit_score).toMatchObject({ id: 's1' });
  expect(r.body.ai_evaluation).toMatchObject({ ple_id: 'p1', composite_score: 70 });
});

test('peer_calibration OFF (default): no peer_avg even after submit', async () => {
  existingScore = { id: 's1', ple_id: 'p1', composite_score: 60 };
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.peer_avg).toBeNull();
  expect(r.body.peer_n).toBe(0);
});

test('peer_calibration ON: peer_avg from the OTHER auditors once they have scored', async () => {
  existingScore = { id: 's1', ple_id: 'p1', composite_score: 60 };
  const prev = m.state.resolve;
  m.state.resolve = (table, kind, ctx) => {
    // Key-aware, not blanket: a stub that answers 1 to EVERY setting also switches on any future
    // gate this route learns to read, and the test then passes or fails for the wrong reason.
    if (table === 'app_settings') return { value: ctx.eqs.some(([c, v]) => c === 'key' && v === 'peer_calibration') ? 1 : 0 };
    if (table === 'audit_scores' && kind === 'list') return [{ d1:5,d2:5,d3:5,d4:5,d5:5,d6:5,d7:5 }]; // one OTHER auditor (self is excluded by .neq in the route)
    return prev(table, kind);
  };
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(200);
  expect(r.body.peer_n).toBe(1);
  expect(r.body.peer_avg).toMatchObject({ d1: 5, d7: 5 });
});

test('GET /auditor/ples/:id not assigned to me → 404', async () => {
  ple = null; // the eq(auditor_id=me) filter returns nothing
  const r = await auth(request(app).get('/auditor/ples/p1'));
  expect(r.status).toBe(404);
});

test('POST score (happy) → 200 with computed composite; insert carries auditor_id + scores', async () => {
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(200);
  expect(r.body.composite_score).toBe(60);
  const ins = m.find('audit_scores', 'insert');
  expect(ins.payload).toMatchObject({ ple_id: 'p1', auditor_id: AUDITOR.id, d1: 3, composite_score: 60 });
});

test('double-submit (existing score) → 409, no insert', async () => {
  existingScore = { id: 's1' };
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(409);
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});

test('concurrent double-submit surfacing as 23505 from the unique constraint → 409', async () => {
  existingScore = null;          // friendly pre-check passes
  insertError = { code: '23505' }; // the DB unique backstop fires
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(409);
});

test('scoring a session not assigned to me → 403', async () => {
  ple.auditor_id = 'other-auditor';
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/not assigned/i);
});

test('scoring your own session → 403', async () => {
  ple.physician_id = AUDITOR.id;
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/own session/i);
});

test('cross-council scoring → 403', async () => {
  ple.council_id = COUNCIL_B;
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send(SCORES);
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/cross-council/i);
});

test('out-of-range domain score → 400 (zod)', async () => {
  const r = await auth(request(app).post('/auditor/ples/p1/score')).send({ ...SCORES, d1: 9 });
  expect(r.status).toBe(400);
});

test('GET /auditor/icc returns an ICC object over the auditor\'s scored pairs', async () => {
  scoredRows = [{ ple_id: 'p1', composite_score: 60 }];
  aiEval = [{ ple_id: 'p1', composite_score: 62 }]; // ai_evaluations .in() list
  const r = await auth(request(app).get('/auditor/icc'));
  expect(r.status).toBe(200);
  expect(r.body).toHaveProperty('icc');
});


// What the approved assessment form asks for, and what the surface was not capturing.
describe('the assessment form is recorded in full', () => {
  const post = (body) => auth(request(app).post('/auditor/ples/p1/score')).send(body);

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
  const report = (body) => auth(request(app).post('/auditor/ples/p1/privacy-concern')).send(body);

  test('the report goes to the reviewer\'s WORK queue, with the reporter recorded as the reporter', async () => {
    const r = await report({ note: 'turn 3 names a hospital and a date' });
    expect(r.status).toBe(200);

    const upd = m.find('ples', 'update');
    expect(upd.payload).toMatchObject({
      // 'pending' is the reviewer's default tab — the work list. Writing 'quarantined' filed the
      // report into the already-decided bucket, where the default view reads "every session has
      // been reviewed".
      privacy_review_status: 'pending',
      privacy_concern_open: true,
      privacy_concern_by: AUDITOR.id,
      privacy_concern_note: 'turn 3 names a hospital and a date',
    });
  });

  test('reporting writes NO reviewer field — the reporter is not the reviewer', async () => {
    await report({ note: 'turn 3 names a hospital and a date' });
    const { payload } = m.find('ples', 'update');
    expect(payload).not.toHaveProperty('privacy_reviewed_by');
    expect(payload).not.toHaveProperty('privacy_reviewed_at');
    // And the reviewer's own note is never overwritten by a rater's statement.
    expect(payload).not.toHaveProperty('privacy_review_note');
  });

  test('no score is created — reporting is instead of scoring, not as well as', async () => {
    await report({ note: 'possible identifier' });
    expect(m.find('audit_scores', 'insert')).toBeUndefined();
  });

  test('the session leaves the queue whether or not the privacy gate is on', async () => {
    // whereCleared() is a NO-OP when privacy_review_required is off, so relying on the clearance
    // alone left a reported session sitting in the queue on exactly the deployments where nobody
    // was reviewing transcripts. The queue therefore filters privacy_concern_open unconditionally.
    m.reset();
    m.state.caller = AUDITOR;
    m.state.resolve = (table, kind) => {
      if (table === 'app_settings') return { value: 0, value_text: 'false' };   // gate OFF
      if (table === 'audit_assignments') return [];
      if (table === 'ples' && kind === 'list') return [];
      return undefined;
    };
    await auth(request(app).get('/auditor/queue'));
    const reads = m.state.queries.filter((q) => q.table === 'ples');
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) {
      expect(q.eqs).toContainEqual(['privacy_concern_open', false]);
    }
  });

  test('an empty report is refused — a concern with no reason cannot be actioned', async () => {
    expect((await report({ note: '' })).status).toBe(400);
  });
});

// Hardening found by adversarial review of the first cut.
describe('reporting a concern cannot be misused', () => {
  const report = (body) => auth(request(app).post('/auditor/ples/p1/privacy-concern')).send(body);

  test('a dual-role rater cannot quarantine their OWN session', async () => {
    // The score route has always refused this. The report route did not, which made it a way to
    // withdraw a session from the study without withdrawing from the study.
    const prev = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => {
      const r = prev(table, kind, ctx);
      return table === 'ples' && r && !Array.isArray(r) ? { ...r, physician_id: AUDITOR.id } : r;
    };
    expect((await report({ note: 'mine' })).status).toBe(403);
    expect(m.find('ples', 'update')).toBeUndefined();
  });

  test('a session with a concern already open is not re-reported over the top', async () => {
    // Re-reporting would overwrite the first reporter's statement and reset the clock on something
    // somebody is already looking at.
    const prev = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => {
      const r = prev(table, kind, ctx);
      return table === 'ples' && r && !Array.isArray(r) ? { ...r, privacy_concern_open: true } : r;
    };
    const res = await report({ note: 'again' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('concern_already_open');
  });

  test('a whitespace-only reason is refused, not stored', async () => {
    // min(1) accepted "   " and quarantined a session with a reason nobody could act on.
    expect((await report({ note: '   ' })).status).toBe(400);
    expect(m.find('ples', 'update')).toBeUndefined();
  });
});

test('an attestation the form never asked for cannot be smuggled into the record', async () => {
  // z.record() accepted any boolean key and the route stored the whole object, so a caller could
  // persist `approved_by_admin: true` beside the real confirmations.
  const r = await auth(request(app).post('/auditor/ples/p1/score'))
    .send({ ...SCORES, attestations: { ...ATTEST, approved_by_admin: true } });
  expect(r.status).toBe(400);
  expect(m.find('audit_scores', 'insert')).toBeUndefined();
});

// The per-PLE blind holds until THIS auditor submits THIS session. A calibration ROUND needs more
// than that: a rater who scores one session, sees the AI three points below them, and then scores the
// next is no longer scoring independently — and independence is the assumption the round's whole
// output rests on. calibration_reveal_locked closes every reveal for the duration of the round.
//
// Four routes hand an auditor the AI comparison. A lock covering only the obvious one is theatre,
// so each is asserted separately here.
describe('calibration_reveal_locked closes every reveal for the round', () => {
  const lockOn = (on) => {
    const prev = m.state.resolve;
    m.state.resolve = (table, kind, ctx) => {
      if (table === 'app_settings') {
        const key = (ctx.eqs.find(([c]) => c === 'key') ?? [])[1];
        return { value: key === 'calibration_reveal_locked' && on ? 1 : 0 };
      }
      return prev(table, kind, ctx);
    };
  };

  beforeEach(() => { existingScore = { id: 's1', ple_id: 'p1', composite_score: 60 }; });

  test('1/4 the reveal pane returns no AI score and no peer average, and SAYS why', async () => {
    lockOn(true);
    const r = await auth(request(app).get('/auditor/ples/p1'));
    expect(r.status).toBe(200);
    expect(r.body.ai_evaluation).toBeNull();
    expect(r.body.peer_avg).toBeNull();
    expect(r.body.peer_n).toBe(0);
    // The auditor still sees their own submitted score — the lock withholds the comparison, not their work.
    expect(r.body.audit_score).toMatchObject({ id: 's1' });
    // Without this flag an empty pane is indistinguishable from a bug.
    expect(r.body.reveal_locked).toBe(true);
  });

  test('2/4 AI discussion is refused with reveal_locked, not score_required', async () => {
    lockOn(true);
    const r = await auth(request(app).post('/auditor/ples/p1/discuss').send({ message: 'why d3?' }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('reveal_locked');
  });

  test('3/4 the auditor ICC is withheld as locked, not as an empty result', async () => {
    lockOn(true);
    scoredRows = [{ ple_id: 'p1', composite_score: 60 }];
    const r = await auth(request(app).get('/auditor/icc'));
    expect(r.status).toBe(200);
    expect(r.body.icc).toBeNull();
    // "withheld" must not look like "nothing scored yet".
    expect(r.body.locked).toBe(true);
  });

  test('4/4 the calibration radar is withheld as locked', async () => {
    lockOn(true);
    scoredRows = [{ ple_id: 'p1', d1: 4, d2: 4, d3: 4, d4: 4, d5: 4, d6: 4, d7: 4 }];
    const r = await auth(request(app).get('/auditor/calibration'));
    expect(r.status).toBe(200);
    expect(r.body.ai).toBeNull();
    expect(r.body.locked).toBe(true);
  });

  test('lock OFF: the reveal returns as before, so the lock is what changed and not the route', async () => {
    lockOn(false);
    const r = await auth(request(app).get('/auditor/ples/p1'));
    expect(r.status).toBe(200);
    expect(r.body.ai_evaluation).toMatchObject({ ple_id: 'p1', composite_score: 70 });
    expect(r.body.reveal_locked).toBe(false);
  });
});
