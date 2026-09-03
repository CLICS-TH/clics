// PROVIDER_SETTINGS_SOURCE=env — the dev-only override that makes a laptop stack IGNORE the shared
// database's app_settings.ai_provider_* without writing them. The sandbox smoke runs `npm run dev`
// against PROD Supabase, whose settings say `anthropic`; every purpose on the laptop must go to
// `local`, and the smoke aborts unless /health/deep proves the override is active.
//
// HERMETIC: providers and the Supabase client are mocked at the module boundary. The source is read
// ONCE at module load (like IS_PROD in src/index.js), so every test loads a fresh module instance.
//
// What must not regress:
//   1. ZERO database reads under the override — not "reads that are ignored". The client module is
//      never even required, so there is nothing to leak, nothing to write, nothing to time out on.
//   2. REFUSED IN PRODUCTION at module load, by the same predicate src/index.js uses for "prod".
//   3. A typo throws. `PROVIDER_SETTINGS_SOURCE=evn` must not quietly mean "database".
//   4. Unset is today's behaviour byte for byte (tests/provider-switch.test.js still holds), with
//      status().override === false added so the two env-sourced states can be told apart.

const mockAnthropic = {
  name: 'anthropic',
  call: jest.fn(async () => ({ text: 'A', inputTokens: 1, outputTokens: 2, tokenCount: 3, stopReason: 'end_turn', model: 'claude-sonnet-4-6' })),
  model: jest.fn(() => 'claude-sonnet-4-6'),
  ready: jest.fn(() => ({ checks: { anthropic_key: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'anthropic', active: 0, queued: 0 })),
};
const mockLocal = {
  name: 'local',
  call: jest.fn(async () => ({ text: 'L', inputTokens: 10, outputTokens: 20, tokenCount: 30, stopReason: 'end_turn', model: 'qwen3-32b-medical' })),
  model: jest.fn(() => 'qwen3-32b-medical'),
  embed: jest.fn(async () => Array(1536).fill(0.1)),
  embedModel: jest.fn(() => 'bge-m3'),
  ready: jest.fn(async () => ({ checks: { local_ai: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'local', active: 0, queued: 0 })),
};
const mockOpenaiEmbed = {
  name: 'openai',
  embed: jest.fn(async () => Array(1536).fill(0.2)),
  embedModel: jest.fn(() => 'text-embedding-3-small'),
  model: jest.fn(() => 'text-embedding-3-small'),
  ready: jest.fn(() => ({ checks: { openai_embeddings: { status: 'up' } } })),
};

jest.mock('../src/services/providers/anthropic', () => mockAnthropic);
jest.mock('../src/services/providers/local', () => mockLocal);
jest.mock('../src/services/providers/openai-embed', () => mockOpenaiEmbed);

// The fake app_settings table. `clientLoads` counts how many times the client MODULE is constructed
// (the factory runs once per fresh registry); `selects` how many reads it serves. Under the override
// both must stay at zero — the proof is structural, not "a read happened and was ignored".
const mockDb = { rows: [], selects: 0, clientLoads: 0 };

jest.mock('../src/lib/supabase', () => {
  mockDb.clientLoads++;
  return {
    supabase: {
      from: () => ({
        select: () => ({
          in: async () => { mockDb.selects++; return { data: mockDb.rows, error: null }; },
        }),
      }),
    },
  };
});

const ENV = [
  'PROVIDER_SETTINGS_SOURCE', 'NODE_ENV', 'RAILWAY_ENVIRONMENT', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS',
  'AI_PROVIDER_EMBED', 'EMBED_PROVIDER', 'LOCAL_AI_MIN_CONTEXT', 'SHADOW_EVAL_PROVIDER', 'PROVIDER_SETTINGS_TTL_MS',
];
let savedEnv;
let warnSpy;

const SECRET = 'service-role-secret-never-logged';
const row = (purpose, provider) => ({ key: `ai_provider_${purpose}`, value_text: provider });
// What the shared PRODUCTION database says: everything on Anthropic, a raised context floor, a locked evaluator.
const PROD_ROWS = [
  row('chat', 'anthropic'), row('evaluate', 'anthropic'), row('criteria', 'anthropic'), row('discuss', 'anthropic'),
  { key: 'ai_provider_embed', value_text: 'openai' },
  { key: 'local_ai_min_context', value_text: '65536' },
  { key: 'evaluator_locked_at', value_text: '2026-08-28T00:00:00Z' },
];
const args = (purpose) => ({ purpose, systemPrompt: 's', messages: [{ role: 'user', content: 'u' }] });

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.NODE_ENV = 'test';
  // Credentials PRESENT and rows PRESENT: the override has to win against a live, populated database.
  process.env.SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  mockDb.rows = [...PROD_ROWS];
  mockDb.selects = 0;
  mockDb.clientLoads = 0;
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

// Fresh module instances — the source is read at load.
function load() {
  jest.resetModules();
  const settings = require('../src/services/provider-settings');
  const ai = require('../src/services/ai');
  return { settings, ai };
}

// ---------------------------------------------------------------------------
describe('PROVIDER_SETTINGS_SOURCE=env — the override', () => {
  beforeEach(() => { process.env.PROVIDER_SETTINGS_SOURCE = 'env'; });

  test('every purpose follows env while the database says anthropic — and the database is never read', async () => {
    process.env.AI_PROVIDER = 'local';
    const { ai } = load();

    for (const p of ai.PURPOSES) expect((await ai.callAI(args(p))).provider).toBe('local');

    expect(mockLocal.call).toHaveBeenCalledTimes(4);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(mockDb.selects).toBe(0);
    expect(mockDb.clientLoads).toBe(0);           // the client module was never even required
  });

  test('the env chain itself is intact: AI_PROVIDER_<PURPOSE> still beats AI_PROVIDER', async () => {
    process.env.AI_PROVIDER = 'local';
    process.env.AI_PROVIDER_EVALUATE = 'anthropic';
    mockDb.rows = [row('chat', 'anthropic'), row('evaluate', 'local')];   // the OPPOSITE of env
    const { ai } = load();

    expect((await ai.callAI(args('chat'))).provider).toBe('local');
    expect((await ai.callAI(args('evaluate'))).provider).toBe('anthropic');
    expect(ai.modelsByPurpose()).toMatchObject({
      chat: { provider: 'local', model: 'qwen3-32b-medical' },
      evaluate: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    });
    expect(mockDb.selects).toBe(0);
  });

  test('ensureFresh() and refresh() are no-ops; overrideFor / numberFor / evaluatorLockedAt see nothing', async () => {
    const { settings, ai } = load();

    await settings.ensureFresh(ai.SETTING_PURPOSES);
    expect(await settings.refresh(ai.SETTING_PURPOSES)).toBe(false);

    expect(mockDb.selects).toBe(0);
    expect(settings.overrideFor('chat')).toBeUndefined();
    expect(settings.numberFor('local_ai_min_context')).toBeUndefined();   // the 65536 row is not seen
    expect(settings.evaluatorLockedAt()).toBeNull();
  });

  test('embeddings follow env too (EMBED_PROVIDER), not the ai_provider_embed row', async () => {
    process.env.EMBED_PROVIDER = 'local';
    const { ai } = load();
    await ai.embedText('chest pain');
    expect(mockLocal.embed).toHaveBeenCalledTimes(1);
    expect(mockOpenaiEmbed.embed).not.toHaveBeenCalled();
    expect(mockDb.selects).toBe(0);
  });

  test('status() reports the override — the field the sandbox smoke gates on', () => {
    const { settings, ai } = load();
    expect(settings.status()).toEqual({ source: 'env', override: true, reason: 'PROVIDER_SETTINGS_SOURCE=env' });
    expect(ai.providerSettingsStatus()).toEqual({
      source: 'env', override: true, reason: 'PROVIDER_SETTINGS_SOURCE=env', evaluator_locked_at: null,
    });
  });

  test('one loud boot line, naming the variable, carrying no secret', () => {
    load();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0];
    expect(line).toMatch(/PROVIDER_SETTINGS_SOURCE=env/);
    expect(line).toMatch(/refused in production/);
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('supabase.test');
  });

  test('the value is trimmed and case-insensitive ("  ENV " is env)', () => {
    process.env.PROVIDER_SETTINGS_SOURCE = '  ENV ';
    const { settings } = load();
    expect(settings.status().override).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('refused in production — the same predicate as src/index.js', () => {
  test('NODE_ENV=production + env → the module throws at load, before anything can route', () => {
    process.env.NODE_ENV = 'production';
    process.env.PROVIDER_SETTINGS_SOURCE = 'env';
    expect(() => load()).toThrow(/PROVIDER_SETTINGS_SOURCE=env is refused in production/);
    expect(mockDb.clientLoads).toBe(0);
  });

  test('RAILWAY_ENVIRONMENT set (the other half of the predicate) + env → throws too', () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    process.env.PROVIDER_SETTINGS_SOURCE = 'env';
    expect(() => load()).toThrow(/refused in production/);
  });

  test('production WITHOUT the override boots normally — the guard is on the combination, not on prod', async () => {
    process.env.NODE_ENV = 'production';
    const { settings, ai } = load();
    expect((await ai.callAI(args('chat'))).provider).toBe('anthropic');   // the database row, honoured
    expect(settings.status().override).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('typo guard', () => {
  test('an unknown value throws and names the two valid values', () => {
    process.env.PROVIDER_SETTINGS_SOURCE = 'evn';
    expect(() => load()).toThrow(/PROVIDER_SETTINGS_SOURCE="evn" is not valid/);
    expect(() => load()).toThrow(/"database".*"env"/);
  });

  test('an empty string is "unset" — the default (database) applies', async () => {
    process.env.PROVIDER_SETTINGS_SOURCE = '';
    process.env.AI_PROVIDER = 'local';
    const { settings, ai } = load();
    expect((await ai.callAI(args('chat'))).provider).toBe('anthropic');   // the row wins, as today
    expect(mockDb.selects).toBe(1);
    expect(settings.status().override).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('unset / database — today\'s behaviour, plus override:false', () => {
  test.each([undefined, 'database'])('PROVIDER_SETTINGS_SOURCE=%s: rows are read and honoured over env', async (value) => {
    if (value !== undefined) process.env.PROVIDER_SETTINGS_SOURCE = value;
    process.env.AI_PROVIDER = 'local';
    const { settings, ai } = load();

    expect((await ai.callAI(args('chat'))).provider).toBe('anthropic');
    expect(mockDb.selects).toBe(1);
    expect(mockDb.clientLoads).toBe(1);
    expect(settings.numberFor('local_ai_min_context')).toBe(65536);
    expect(settings.evaluatorLockedAt()).toBe('2026-08-28T00:00:00Z');
    expect(settings.status()).toEqual({
      source: 'database', override: false, age_ms: expect.any(Number),
      overrides: {
        ai_provider_chat: 'anthropic', ai_provider_evaluate: 'anthropic', ai_provider_criteria: 'anthropic',
        ai_provider_discuss: 'anthropic', ai_provider_embed: 'openai', local_ai_min_context: 65536,
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();   // no boot line when nothing is overridden
  });

  test('with no credentials: override:false, reason "no database credentials"', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { settings } = load();
    expect(settings.status()).toEqual({ source: 'env', override: false, reason: 'no database credentials' });
  });

  test('before the first read lands: override:false, reason "not yet read"', () => {
    const { settings } = load();
    expect(settings.status()).toEqual({ source: 'env', override: false, reason: 'not yet read' });
  });
});
