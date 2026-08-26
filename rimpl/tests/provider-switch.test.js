// The DB-backed provider switch: app_settings.ai_provider_<purpose> layered OVER the env chain.
//
// HERMETIC: both providers and the Supabase client are mocked at the module boundary.
//
// What must not regress, in priority order:
//   1. FAIL-SOFT TO ENV, never to a hardcoded default. A database blip must leave the deployment
//      exactly where its env says. Falling back to 'anthropic' would silently relocate PIS-7 scoring
//      to a different model mid-cohort — the one outcome this whole design exists to prevent.
//   2. THE SYNC ACCESSOR SEES THE OVERRIDE. shadow.js asks providerNameFor('evaluate') to decide
//      whether the shadow model differs from the served one. If the override resolved anywhere other
//      than inside providerNameFor, that guard reads env while traffic follows the database, and the
//      shadow arm scores with the very model it is supposed to be compared against — producing a
//      confident, meaningless comparison in the corpus a model-swap decision would rest on.
//   3. AN UNKNOWN NAME STILL THROWS, wherever it came from.
//   4. NO DATABASE READ PER CALL. Every physician turn resolves a provider.

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

// The fake app_settings table. One `mock`-prefixed object, because jest.mock factories are hoisted
// above the file's other declarations and may only close over names beginning with "mock".
const mockDb = { rows: [], error: null, selects: 0 };

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: async () => {
          mockDb.selects++;
          if (mockDb.error) return { data: null, error: { message: mockDb.error } };
          return { data: mockDb.rows, error: null };
        },
      }),
    }),
  },
}));

const AI_ENV = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA',
  'AI_PROVIDER_DISCUSS', 'AI_PROVIDER_EMBED', 'EMBED_PROVIDER', 'PROVIDER_SETTINGS_TTL_MS', 'RAG_EMBED_DIM'];
let savedEnv;

const ai = require('../src/services/ai');
const settings = require('../src/services/provider-settings');
const { shadowTarget } = require('../src/services/shadow');

const row = (purpose, provider) => ({ key: `ai_provider_${purpose}`, value_text: provider });
const args = (purpose) => ({ purpose, systemPrompt: 's', messages: [{ role: 'user', content: 'u' }] });

let warnSpy;
beforeEach(() => {
  savedEnv = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
  for (const k of AI_ENV) delete process.env[k];
  // Credentials present → the override layer is live. Without them it is env-only by design.
  process.env.SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  process.env.SHADOW_EVAL_PROVIDER = '';
  mockDb.rows = [];
  mockDb.error = null;
  mockDb.selects = 0;
  settings.__resetForTests();
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  for (const k of AI_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('the database layer sits ON TOP of env', () => {
  test('an app_settings override beats both AI_PROVIDER_<PURPOSE> and AI_PROVIDER', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_PROVIDER_CHAT = 'anthropic';
    mockDb.rows = [row('chat', 'local')];

    const r = await ai.callAI(args('chat'));

    expect(r.provider).toBe('local');
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });

  test('env still decides when no override is stored', async () => {
    process.env.AI_PROVIDER_CHAT = 'local';
    mockDb.rows = [row('evaluate', 'anthropic')];        // a row for a DIFFERENT purpose

    expect((await ai.callAI(args('chat'))).provider).toBe('local');
  });

  test('an EMPTY value_text means "hand it back to env", not "anthropic"', async () => {
    process.env.AI_PROVIDER_CHAT = 'local';
    mockDb.rows = [{ key: 'ai_provider_chat', value_text: '   ' }];

    expect((await ai.callAI(args('chat'))).provider).toBe('local');
  });

  test('purposes are independent — the shipping hybrid is expressible entirely in the database', async () => {
    mockDb.rows = [row('chat', 'local'), row('criteria', 'local'), row('discuss', 'local'), row('evaluate', 'anthropic')];
    await ai.callAI(args('chat'));

    expect(ai.providerNameFor('chat')).toBe('local');
    expect(ai.providerNameFor('criteria')).toBe('local');
    expect(ai.providerNameFor('discuss')).toBe('local');
    expect(ai.providerNameFor('evaluate')).toBe('anthropic');
    expect(ai.activeProviders().sort()).toEqual(['anthropic', 'local']);
  });

  test('an unknown provider name in the DATABASE throws exactly like an unknown one in env', async () => {
    mockDb.rows = [row('evaluate', 'antropic')];
    await expect(ai.callAI(args('evaluate'))).rejects.toThrow(/Unknown AI provider "antropic"/);
  });
});

describe('fail-soft: a database outage leaves env in force', () => {
  test('a failed read keeps the ENV provider, never a hardcoded default', async () => {
    process.env.AI_PROVIDER_EVALUATE = 'local';
    mockDb.error = 'connection terminated';

    const r = await ai.callAI(args('evaluate'));

    expect(r.provider).toBe('local');            // NOT 'anthropic'
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/provider-settings/));
  });

  test('an outage AFTER a good read keeps the LAST KNOWN GOOD override, not env', async () => {
    process.env.PROVIDER_SETTINGS_TTL_MS = '1000';
    process.env.AI_PROVIDER_CHAT = 'anthropic';
    mockDb.rows = [row('chat', 'local')];
    expect((await ai.callAI(args('chat'))).provider).toBe('local');

    // The database goes away; the cache goes stale and the background refresh fails.
    mockDb.error = 'connection terminated';
    await new Promise((r) => setTimeout(r, 1100));
    await ai.callAI(args('chat'));
    await new Promise((r) => setTimeout(r, 10));  // let the background refresh settle

    // Still local. Reverting to env here would move traffic without anyone asking.
    expect(ai.providerNameFor('chat')).toBe('local');
  });

  test('with no database credentials the layer is inert and env decides', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.AI_PROVIDER_CHAT = 'local';
    mockDb.rows = [row('chat', 'anthropic')];

    expect((await ai.callAI(args('chat'))).provider).toBe('local');
    expect(mockDb.selects).toBe(0);
    expect(ai.providerSettingsStatus().source).toBe('env');
  });
});

describe('a misconfigured local box fails LOUDLY', () => {
  test('switching to local with the box unreachable errors — it does not quietly serve Anthropic', async () => {
    mockDb.rows = [row('chat', 'local')];
    mockLocal.call.mockRejectedValueOnce(new Error('LOCAL_AI_BASE_URL is not set (AI_PROVIDER=local requires it)'));

    await expect(ai.callAI(args('chat'))).rejects.toThrow(/LOCAL_AI_BASE_URL/);

    // The whole point. A fallback here would bill cloud rates while an operator believed the traffic
    // was on-prem — and for `evaluate`, would score under a model nobody chose.
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });
});

describe('the SYNC accessor sees the override — shadow.js depends on it', () => {
  test('providerNameFor() reflects the database once the cache is warm', async () => {
    mockDb.rows = [row('evaluate', 'local')];
    expect(ai.providerNameFor('evaluate')).toBe('anthropic');  // cold: env only
    await ai.callAI(args('evaluate'));                          // warms it
    expect(ai.providerNameFor('evaluate')).toBe('local');
  });

  test('shadowTarget() does NOT shadow local with local when the DB moved evaluate on-prem', async () => {
    process.env.SHADOW_EVAL_PROVIDER = 'local';
    mockDb.rows = [row('evaluate', 'local')];
    await ai.callAI(args('evaluate'));   // warm the cache the way a real evaluation would

    // Without the DB layer inside providerNameFor, this would read env ('anthropic'), see a
    // difference that isn't there, and shadow local with local — scoring the same transcript twice
    // with the same model and recording it as a cross-model comparison.
    expect(shadowTarget()).toBeNull();
  });

  test('…and still shadows when the two genuinely differ', async () => {
    process.env.SHADOW_EVAL_PROVIDER = 'local';
    mockDb.rows = [row('evaluate', 'anthropic')];
    await ai.callAI(args('evaluate'));
    expect(shadowTarget()).toBe('local');
  });

  test('modelsByPurpose() reports the DB-resolved model — §10.2 provenance', async () => {
    mockDb.rows = [row('evaluate', 'local')];
    await ai.callAI(args('evaluate'));
    expect(ai.modelsByPurpose().evaluate).toEqual({ provider: 'local', model: 'qwen3-32b-medical' });
  });
});

describe('caching: the database is not on the hot path', () => {
  test('one read serves many calls within the TTL', async () => {
    process.env.PROVIDER_SETTINGS_TTL_MS = '60000';
    mockDb.rows = [row('chat', 'local')];

    for (let i = 0; i < 25; i++) await ai.callAI(args('chat'));

    expect(mockLocal.call).toHaveBeenCalledTimes(25);
    expect(mockDb.selects).toBe(1);
  });

  test('a pinned provider skips resolution entirely (routes/chat.js retry)', async () => {
    mockDb.rows = [row('chat', 'local')];
    await ai.callAI(args('chat'));            // 1 read
    const before = mockDb.selects;

    // Mid-turn the toggle flips to anthropic. The pinned retry must still hit local, or one
    // physician turn is written half by each model with nothing recording it.
    mockDb.rows = [row('chat', 'anthropic')];
    settings.__resetForTests();
    const r = await ai.callAI({ ...args('chat'), provider: 'local' });

    expect(r.provider).toBe('local');
    expect(mockDb.selects).toBe(before);         // no read at all
  });
});

describe('embeddings move with everything else', () => {
  test('default is OpenAI — unchanged behaviour until someone switches it', async () => {
    const v = await ai.embedText('chest pain');
    expect(mockOpenaiEmbed.embed).toHaveBeenCalledWith('chest pain');
    expect(v).toHaveLength(1536);
  });

  test('app_settings.ai_provider_embed moves retrieval on-prem', async () => {
    mockDb.rows = [{ key: 'ai_provider_embed', value_text: 'local' }];
    await ai.embedText('chest pain');
    expect(mockLocal.embed).toHaveBeenCalledTimes(1);
    expect(mockOpenaiEmbed.embed).not.toHaveBeenCalled();
  });

  test('anthropic is not a valid embedding provider — it has no embeddings API', async () => {
    mockDb.rows = [{ key: 'ai_provider_embed', value_text: 'anthropic' }];
    await expect(ai.embedText('x')).rejects.toThrow(/Unknown AI provider "anthropic"/);
  });

  test('a dimension mismatch fails LOUDLY instead of returning confident nonsense', async () => {
    mockDb.rows = [{ key: 'ai_provider_embed', value_text: 'local' }];
    mockLocal.embed.mockResolvedValueOnce(Array(1024).fill(0.1)); // bge-m3 is 1024, the corpus is 1536
    await expect(ai.embedText('x')).rejects.toThrow(/1024 dimensions; the document corpus is 1536/);
  });
});
