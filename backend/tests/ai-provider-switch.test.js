// Superadmin AI provider switch — which model serves each purpose, and the lock that freezes the
// scoring instrument for the pilot.
//
// Why this endpoint is guarded at all: `evaluate` is not a preference. It is the measuring
// instrument every PIS-7 score and the ICC >= 0.75 credit gate are defined against, and §10.2
// requires a locked model+prompt+rubric for the pilot. Changing it mid-cohort confounds the primary
// outcome with the instrument, which no analysis can undo afterwards.

// key -> value_text, standing in for the app_settings rows.
const mockSettings = {};
const mockUpserts = [];
const mockEvents = [];

const mockProf = { data: { id: 'sa-1', role: 'superadmin', status: 'active' }, error: null };
const mockUser = { data: { user: { id: 'sa-1', email: 'superadmin@clics.th' } }, error: null };

// logEventStrict is AWAITED by the lock/unlock paths and must answer { ok } — a sync stub returning
// undefined would hide exactly the failure those paths now handle (tests/evaluator-model-lock.test.js).
jest.mock('../src/lib/audit', () => ({
  logEvent: async (e) => { mockEvents.push(e); },
  logEventStrict: async (e) => { mockEvents.push(e); return { ok: true }; },
}));

// The switch now asks RIMPL whether the target can actually serve before pointing traffic at it.
// Default FIT, so every pre-existing case here still exercises what it was written to exercise.
let mockVerdict = { fit: true, code: null, reason: null };
let mockProbeThrows = null;
const mockProbe = jest.fn(async (args) => {
  if (mockProbeThrows) throw new Error(mockProbeThrows);
  return { provider: args.name, purpose: args.purpose, ...mockVerdict };
});
jest.mock('../src/services/rimpl-client', () => ({ probeRimplProvider: (...a) => mockProbe(...a) }));

jest.mock('../src/lib/supabase', () => {
  const settingChain = () => {
    let key = null;
    const c = {
      select: () => c,
      eq: (_col, v) => { key = v; return c; },
      // A single row or an array (the lock settings are written as one pair).
      upsert: (payload) => {
        for (const row of [].concat(payload)) { mockUpserts.push(row); mockSettings[row.key] = row.value_text; }
        return c;
      },
      maybeSingle: () => Promise.resolve({ data: key in mockSettings ? { value_text: mockSettings[key] } : null, error: null }),
      single: () => Promise.resolve({ data: key in mockSettings ? { value_text: mockSettings[key] } : null, error: null }),
      then: (r) => r({ data: null, error: null }),   // bare `await ... .upsert(...)`
    };
    return c;
  };
  const profChain = () => {
    const c = { select: () => c, eq: () => c, update: () => c, single: () => Promise.resolve(mockProf), maybeSingle: () => Promise.resolve(mockProf) };
    return c;
  };
  return {
    supabase: { from: (t) => (t === 'app_settings' ? settingChain() : profChain()), rpc: () => Promise.resolve({ error: null }) },
    authSupabase: { auth: { getUser: () => Promise.resolve(mockUser) } },
  };
});

const request = require('supertest');
const express = require('express');
const superadminRouter = require('../src/routes/superadmin');
const app = express();
app.use(express.json());
app.use('/admin', superadminRouter);
const auth = (r) => r.set('Authorization', 'Bearer test');

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  mockUpserts.length = 0;
  mockEvents.length = 0;
  mockProbe.mockClear();
  mockProbeThrows = null;
  mockVerdict = { fit: true, code: null, reason: null };
});

const patch = (body) => auth(request(app).patch('/admin/ai-providers')).send(body);

describe('GET /admin/ai-providers', () => {
  test('defaults to the current production config — anthropic everywhere, openai for embeddings', async () => {
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(r.status).toBe(200);
    expect(r.body.providers).toEqual({
      chat: 'anthropic', evaluate: 'anthropic', criteria: 'anthropic', discuss: 'anthropic', embed: 'openai',
    });
    expect(r.body.evaluator_locked_at).toBeNull();
  });

  test('publishes the valid choices per purpose so the UI never hardcodes them', async () => {
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(r.body.choices.chat).toEqual(['anthropic', 'local', 'local-tutor']);
    expect(r.body.choices.discuss).toEqual(['anthropic', 'local', 'local-tutor']);
    // The tutor model never scores and never screens (CCME R3: the evaluator is a distinct artifact).
    expect(r.body.choices.evaluate).toEqual(['anthropic', 'local']);
    expect(r.body.choices.criteria).toEqual(['anthropic', 'local']);
    // Anthropic has no embeddings API — offering it here would be a switch that throws on first use.
    expect(r.body.choices.embed).toEqual(['openai', 'local']);
  });
});

describe('an ordinary purpose flips freely', () => {
  test('chat -> local is applied and audit-logged', async () => {
    const r = await patch({ purpose: 'chat', provider: 'local' });

    expect(r.status).toBe(200);
    expect(r.body.providers.chat).toBe('local');
    expect(mockUpserts).toContainEqual(expect.objectContaining({ key: 'ai_provider_chat', value_text: 'local' }));
    expect(mockEvents).toContainEqual(expect.objectContaining({
      action: 'ai_provider_change', metadata: { purpose: 'chat', from: 'anthropic', to: 'local' },
    }));
  });

  test('a provider that cannot serve the purpose is refused', async () => {
    const r = await patch({ purpose: 'embed', provider: 'anthropic' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_provider');
    expect(mockUpserts).toHaveLength(0);
  });

  test('an unknown provider name is refused rather than stored for RIMPL to choke on', async () => {
    const r = await patch({ purpose: 'chat', provider: 'gpt-5' });
    expect(r.status).toBe(400);
    expect(mockUpserts).toHaveLength(0);
  });
});

describe('the evaluator is guarded', () => {
  test('changing it without the typed confirmation is refused', async () => {
    const r = await patch({ purpose: 'evaluate', provider: 'local' });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('confirmation_required');
    expect(r.body.confirm_phrase).toBe('CHANGE EVALUATOR');
    expect(mockUpserts).toHaveLength(0);
  });

  test('with the confirmation it goes through, and is logged', async () => {
    const r = await patch({ purpose: 'evaluate', provider: 'local', confirm: 'CHANGE EVALUATOR' });

    expect(r.status).toBe(200);
    expect(r.body.providers.evaluate).toBe('local');
    expect(mockEvents).toContainEqual(expect.objectContaining({
      action: 'ai_provider_change', metadata: { purpose: 'evaluate', from: 'anthropic', to: 'local' },
    }));
  });

  // A lock is now declared only through POST /admin/evaluator-lock (tests/evaluator-model-lock.test.js),
  // which writes these two settings. Here they are set directly: this suite is about the switch.
  const lockedByDeclaration = () => {
    mockSettings.evaluator_locked_at = '2026-10-15T00:00:00.000Z';
    mockSettings.evaluator_weights_sha256 = 'a'.repeat(64);
  };

  test('once LOCKED the change is REFUSED OUTRIGHT — the confirmation no longer helps', async () => {
    lockedByDeclaration();

    const r = await patch({ purpose: 'evaluate', provider: 'local', confirm: 'CHANGE EVALUATOR' });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('evaluator_locked');
    expect(mockUpserts.some((u) => u.key === 'ai_provider_evaluate')).toBe(false);
  });

  test('the lock does NOT freeze the other purposes — chat can still move on-prem mid-pilot', async () => {
    lockedByDeclaration();
    const r = await patch({ purpose: 'chat', provider: 'local' });
    expect(r.status).toBe(200);
    expect(r.body.providers.chat).toBe('local');
  });

  test('this switch cannot lock: 409 use_model_lock, and an existing lock is left exactly as it was', async () => {
    lockedByDeclaration();
    const first = mockSettings.evaluator_locked_at;
    const r = await patch({ evaluator_locked: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('use_model_lock');
    expect(mockSettings.evaluator_locked_at).toBe(first);
    expect(mockUpserts).toHaveLength(0);
  });

  test('unlocking needs its own typed phrase — the dangerous direction is the harder one', async () => {
    lockedByDeclaration();

    const refused = await patch({ evaluator_locked: false });
    expect(refused.status).toBe(409);
    expect(refused.body.confirm_phrase).toBe('UNLOCK EVALUATOR');
    expect(mockSettings.evaluator_locked_at).toBeTruthy();   // still locked

    const ok = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(ok.status).toBe(200);
    expect(ok.body.evaluator_locked_at).toBeNull();
    // ...and the digest goes with it, or every later score is stamped `locked: true` against no lock.
    expect(mockSettings.evaluator_weights_sha256).toBeNull();
    expect(mockEvents).toContainEqual(expect.objectContaining({ action: 'evaluator_lock' }));
  });

  test('a lock request without a declaration is refused, pointing at the Model Lock — not quietly applied', async () => {
    // It used to be "always allowed without a phrase". It also set the flag with no record, no digest,
    // no agreement gate and no manifest: a lock that only looked real.
    const r = await patch({ evaluator_locked: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'use_model_lock', lock_endpoint: 'POST /admin/evaluator-lock' });
    expect(mockSettings.evaluator_locked_at).toBeUndefined();
  });
});

test('a body that names neither a provider change nor a lock change is a 400', async () => {
  const r = await patch({ confirm: 'CHANGE EVALUATOR' });
  expect(r.status).toBe(400);
});


// A server left on a small context window accepts the switch happily and then fails EVERY
// evaluation, because a creditable transcript runs to 10,000+ tokens. That failure was measured on
// the real box before this gate existed, and its whole cost is that the first person to notice is a
// physician losing a session. These cases pin the gate that makes it a refusal instead.
describe('a provider must be READY before traffic is pointed at it', () => {
  const unfit = (over) => { mockVerdict = { fit: false, ...over }; };

  test('a context window too small to hold a transcript refuses the switch, and says by how much', async () => {
    unfit({ code: 'context_too_small', reason: 'served context 4096 is below the required minimum 16384', measured: 4096, required: 16384 });
    const r = await patch({ purpose: 'evaluate', provider: 'local', confirm: 'CHANGE EVALUATOR' });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('provider_not_ready');
    expect(r.body.provider_code).toBe('context_too_small');
    // Both numbers, so the operator can forward ONE value to whoever administers the server.
    expect(r.body.measured).toBe(4096);
    expect(r.body.required).toBe(16384);
    expect(mockSettings.ai_provider_evaluate).toBeUndefined();
  });

  test('an unreachable provider refuses the switch', async () => {
    unfit({ code: 'provider_down', reason: 'model "x" not served' });
    const r = await patch({ purpose: 'chat', provider: 'local' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('provider_not_ready');
    expect(mockSettings.ai_provider_chat).toBeUndefined();
  });

  test('a probe we could not run counts as UNFIT, not as fit', async () => {
    // The tempting default is to let the switch through when the check itself fails. That is exactly
    // backwards: we cannot verify, so we must not assert.
    mockProbeThrows = 'connect ECONNREFUSED';
    const r = await patch({ purpose: 'chat', provider: 'local' });
    expect(r.status).toBe(409);
    expect(r.body.provider_code).toBe('probe_unreachable');
    expect(mockSettings.ai_provider_chat).toBeUndefined();
  });

  test('the typed phrase overrides the refusal, and the override is on the record', async () => {
    unfit({ code: 'context_too_small', reason: 'too small', measured: 4096, required: 16384 });
    const r = await patch({ purpose: 'chat', provider: 'local', confirm_unfit: 'SWITCH ANYWAY' });

    expect(r.status).toBe(200);
    expect(mockSettings.ai_provider_chat).toBe('local');
    // Overridden, not absent — this is the entry someone needs when explaining why scoring broke.
    expect(mockEvents.map(e => e.action)).toContain('ai_provider_unfit_override');
  });

  test('the wrong phrase does not override', async () => {
    unfit({ code: 'provider_down', reason: 'down' });
    const r = await patch({ purpose: 'chat', provider: 'local', confirm_unfit: 'yes' });
    expect(r.status).toBe(409);
  });

  test('the evaluator needs BOTH phrases — that is why the override has its own field', async () => {
    unfit({ code: 'provider_down', reason: 'down' });
    // Sharing one `confirm` field would make this switch impossible to express at all.
    const r = await patch({ purpose: 'evaluate', provider: 'local', confirm: 'CHANGE EVALUATOR', confirm_unfit: 'SWITCH ANYWAY' });
    expect(r.status).toBe(200);
    expect(mockSettings.ai_provider_evaluate).toBe('local');
  });

  test('a fit provider switches with no extra ceremony', async () => {
    const r = await patch({ purpose: 'chat', provider: 'local' });
    expect(r.status).toBe(200);
    expect(mockProbe).toHaveBeenCalledWith(expect.objectContaining({ name: 'local', purpose: 'chat' }));
  });

  test('a no-op switch does not make a vendor call', async () => {
    // Probing `embed` costs a real embedding request; re-selecting what is already selected must not.
    const r = await patch({ purpose: 'embed', provider: 'openai' });
    expect(r.status).toBe(200);
    expect(mockProbe).not.toHaveBeenCalled();
  });
});

// The on-prem TUTOR model (rimpl providers/local-tutor.js): offered for the conversational purposes,
// refused for the instrument and the screen. rimpl refuses the same routes itself; this is the
// operator-facing half, so the refusal arrives as a 400 at the switch rather than a 500 per call.
describe('local-tutor', () => {
  test.each(['chat', 'discuss'])('%s -> local-tutor goes through the readiness probe and is applied', async (purpose) => {
    const r = await patch({ purpose, provider: 'local-tutor' });
    expect(r.status).toBe(200);
    expect(r.body.providers[purpose]).toBe('local-tutor');
    expect(mockProbe).toHaveBeenCalledWith(expect.objectContaining({ name: 'local-tutor', purpose }));
    expect(mockSettings[`ai_provider_${purpose}`]).toBe('local-tutor');
    expect(mockEvents).toContainEqual(expect.objectContaining({
      action: 'ai_provider_change', metadata: { purpose, from: 'anthropic', to: 'local-tutor' },
    }));
  });

  test.each([
    ['evaluate', { confirm: 'CHANGE EVALUATOR' }],
    ['criteria', {}],
    ['embed', {}],
  ])('%s -> local-tutor is refused 400 invalid_provider, before any probe or write', async (purpose, extra) => {
    const r = await patch({ purpose, provider: 'local-tutor', ...extra });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_provider');
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockUpserts).toHaveLength(0);
  });

  test('an unfit tutor box (e.g. LOCAL_TUTOR_AI_BASE_URL unset) refuses the switch like any other provider', async () => {
    mockVerdict = { fit: false, code: 'provider_down', reason: 'LOCAL_TUTOR_AI_BASE_URL not set' };
    const r = await patch({ purpose: 'chat', provider: 'local-tutor' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('provider_not_ready');
    expect(r.body.error).toMatch(/LOCAL_TUTOR_AI_BASE_URL not set/);
    expect(mockSettings.ai_provider_chat).toBeUndefined();
  });

  test('the defaults are unchanged: nothing routes to the tutor until someone picks it', async () => {
    const r = await auth(request(app).get('/admin/ai-providers'));
    expect(Object.values(r.body.providers)).not.toContain('local-tutor');
  });
});
