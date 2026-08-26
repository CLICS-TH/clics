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

jest.mock('../src/lib/audit', () => ({ logEvent: (e) => { mockEvents.push(e); } }));

jest.mock('../src/lib/supabase', () => {
  const settingChain = () => {
    let key = null;
    const c = {
      select: () => c,
      eq: (_col, v) => { key = v; return c; },
      upsert: (payload) => { mockUpserts.push(payload); mockSettings[payload.key] = payload.value_text; return c; },
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
    expect(r.body.choices.chat).toEqual(['anthropic', 'local']);
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

  test('once LOCKED the change is REFUSED OUTRIGHT — the confirmation no longer helps', async () => {
    await patch({ evaluator_locked: true });
    expect(mockSettings.evaluator_locked_at).toBeTruthy();

    const r = await patch({ purpose: 'evaluate', provider: 'local', confirm: 'CHANGE EVALUATOR' });

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('evaluator_locked');
    expect(mockUpserts.some((u) => u.key === 'ai_provider_evaluate')).toBe(false);
  });

  test('the lock does NOT freeze the other purposes — chat can still move on-prem mid-pilot', async () => {
    await patch({ evaluator_locked: true });
    const r = await patch({ purpose: 'chat', provider: 'local' });
    expect(r.status).toBe(200);
    expect(r.body.providers.chat).toBe('local');
  });

  test('locking is idempotent — re-locking keeps the ORIGINAL timestamp', async () => {
    await patch({ evaluator_locked: true });
    const first = mockSettings.evaluator_locked_at;
    await patch({ evaluator_locked: true });
    expect(mockSettings.evaluator_locked_at).toBe(first);
  });

  test('unlocking needs its own typed phrase — the dangerous direction is the harder one', async () => {
    await patch({ evaluator_locked: true });

    const refused = await patch({ evaluator_locked: false });
    expect(refused.status).toBe(409);
    expect(refused.body.confirm_phrase).toBe('UNLOCK EVALUATOR');
    expect(mockSettings.evaluator_locked_at).toBeTruthy();   // still locked

    const ok = await patch({ evaluator_locked: false, confirm: 'UNLOCK EVALUATOR' });
    expect(ok.status).toBe(200);
    expect(ok.body.evaluator_locked_at).toBeNull();
    expect(mockEvents).toContainEqual(expect.objectContaining({ action: 'evaluator_lock' }));
  });

  test('locking is always allowed without a phrase — making the SAFE action harder gets it skipped', async () => {
    const r = await patch({ evaluator_locked: true });
    expect(r.status).toBe(200);
    expect(r.body.evaluator_locked_at).toBeTruthy();
  });
});

test('a body that names neither a provider change nor a lock change is a 400', async () => {
  const r = await patch({ confirm: 'CHANGE EVALUATOR' });
  expect(r.status).toBe(400);
});
