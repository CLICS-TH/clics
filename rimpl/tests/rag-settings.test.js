// The SQL migration writes rag_enabled to app_settings.value. Exercise that row through the real
// cache, AI seam and retrieval gate: mocking ragEnabled/numberFor hid a value_text-only reader.
// Supabase and embedding transport are isolated; no database, provider or paid API is contacted.
const mockDb = { rows: [], error: null };
const mockRpc = jest.fn();
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      if (table !== 'app_settings') throw new Error(`unexpected table: ${table}`);
      return {
        select: (columns) => ({
          in: async (_key, keys) => ({
            // Model PostgREST projection: a fixture must not supply columns the reader omitted.
            data: mockDb.rows.filter((row) => keys.includes(row.key)).map((row) =>
              Object.fromEntries(columns.split(',').map((column) => {
                const name = column.trim();
                return [name, row[name]];
              }))),
            error: mockDb.error,
          }),
        }),
      };
    },
    rpc: (...args) => mockRpc(...args),
  },
}));

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PROVIDER_SETTINGS_SOURCE',
  'AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA',
  'AI_PROVIDER_DISCUSS', 'AI_PROVIDER_EMBED', 'EMBED_PROVIDER', 'CHAT_FAILOVER_PROVIDER',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'RAG_EMBED_DIM'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.PROVIDER_SETTINGS_SOURCE = 'database';
const settings = require('../src/services/provider-settings');
const ai = require('../src/services/ai');
const { ragLookup } = require('../src/services/rag');

let fetchSpy;
let warnSpy;
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  mockDb.rows = [];
  mockDb.error = null;
  mockRpc.mockReset().mockResolvedValue({ data: [{ id: 'reference' }], error: null });
  settings.__resetForTests();
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected network request'));
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('the migration numeric 1 enables retrieval and exposes the missing OpenAI key in readiness', async () => {
  mockDb.rows = [{ key: 'rag_enabled', value: 1, value_text: null }];
  expect(await ai.ragEnabled()).toBe(true);
  expect((await ai.readiness()).openai_embeddings.status).toBe('down');
  expect(fetchSpy).not.toHaveBeenCalled(); // readiness checks presence, never embeds

  process.env.OPENAI_API_KEY = 'test-openai';
  fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) });
  expect(await ragLookup('de-identified question')).toEqual([{ id: 'reference' }]);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(mockRpc).toHaveBeenCalledWith('match_documents', expect.objectContaining({ match_count: 3 }));
});

test('numeric 0 wins over stale value_text=1 and prevents both embedding and its readiness probe', async () => {
  mockDb.rows = [{ key: 'rag_enabled', value: 0, value_text: '1' }];
  expect(await ai.ragEnabled()).toBe(false);
  expect(settings.status().overrides.rag_enabled).toBe(0);
  expect(await ragLookup('de-identified question')).toEqual([]);
  expect((await ai.readiness()).openai_embeddings).toBeUndefined();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockRpc).not.toHaveBeenCalled();
});

test('an absent flag stays off without an embedding dependency', async () => {
  expect(await ai.ragEnabled()).toBe(false);
  expect(await ragLookup('question')).toEqual([]);
  expect((await ai.readiness()).openai_embeddings).toBeUndefined();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockRpc).not.toHaveBeenCalled();
});

test.each([undefined, null, true, '1', '1.0', '01', '1junk', 1.5, 2, -1])(
  'malformed numeric flag %p cannot enable retrieval, even with value_text=1', async (value) => {
    mockDb.rows = [{ key: 'rag_enabled', value, value_text: '1' }];
    expect(await ai.ragEnabled()).toBe(false);
    expect((await ai.readiness()).openai_embeddings).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  },
);

test('a successful refresh observes numeric rollback from 1 to 0', async () => {
  mockDb.rows = [{ key: 'rag_enabled', value: 1, value_text: null }];
  expect(await ai.ragEnabled()).toBe(true);
  mockDb.rows = [{ key: 'rag_enabled', value: 0, value_text: null }];
  await settings.refresh([]);
  expect(await ai.ragEnabled()).toBe(false);
  expect((await ai.readiness()).openai_embeddings).toBeUndefined();
});

test('local_ai_min_context retains its independent positive value_text contract', async () => {
  mockDb.rows = [{ key: 'local_ai_min_context', value: 1, value_text: '32768' }];
  await settings.refresh([]);
  expect(settings.numberFor('local_ai_min_context')).toBe(32768);
  mockDb.rows = [{ key: 'local_ai_min_context', value: 32768, value_text: '0' }];
  await settings.refresh([]);
  expect(settings.numberFor('local_ai_min_context')).toBeUndefined();
});
