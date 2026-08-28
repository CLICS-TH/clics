// probeProvider — "can this provider serve?", asked BEFORE the superadmin switches to it.
//
// readiness() next door deliberately probes only the ACTIVE providers, which is right for
// /health/deep: a cloud-only box should not report degraded for an on-prem server it never calls.
// It is exactly wrong for the question a switch gate asks, because the target of a switch is by
// definition not active yet. That gap is why an inference server left on a 4,096-token context
// accepted the switch and then failed every evaluation — loudly, but only at the moment a physician
// lost a session.
//
// The verdict lives HERE rather than in the calling gate on purpose. Two callers deciding for
// themselves what `context_length: 'unknown'` means is how they end up disagreeing.

const LOCAL_ENV = [
  'LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL', 'LOCAL_AI_API_KEY', 'HEALTH_PROBE_TIMEOUT_MS',
  'LOCAL_AI_MIN_CONTEXT', 'LOCAL_AI_EMBED_MODEL', 'RAG_EMBED_DIM',
  'AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'EMBED_PROVIDER',
];

let savedEnv, realFetch, fetchMock;

beforeEach(() => {
  savedEnv = Object.fromEntries(LOCAL_ENV.map((k) => [k, process.env[k]]));
  for (const k of LOCAL_ENV) delete process.env[k];
  process.env.LOCAL_AI_BASE_URL = 'http://dgx.tailnet:8000/v1';
  process.env.LOCAL_AI_MODEL = 'qwen3-32b-medical';
  process.env.LOCAL_AI_EMBED_MODEL = 'nomic-embed-text';
  process.env.HEALTH_PROBE_TIMEOUT_MS = '200';
  realFetch = global.fetch;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  global.fetch = realFetch;
  for (const k of LOCAL_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

const res = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: 'OK', headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body),
});

// ready() probes twice (GET /models, then Ollama's native /api/show), and embed hits /embeddings.
// Route by URL rather than by call order, so a test states the condition it means.
function serve({ models = ['qwen3-32b-medical'], context = 32768, vector = null, fail = null }) {
  fetchMock.mockImplementation(async (url) => {
    if (fail) throw new Error(fail);
    const u = String(url);
    if (u.includes('/models')) return res({ data: models.map((id) => ({ id })) });
    if (u.includes('/api/show')) {
      return context == null ? res({}, 404) : res({ model_info: { 'qwen3.context_length': context } });
    }
    if (u.includes('/embeddings')) return res({ data: [{ embedding: new Array(vector ?? 768).fill(0.1) }] });
    throw new Error(`unexpected probe call: ${u}`);
  });
}

const load = () => { jest.resetModules(); return require('../src/services/ai'); };

describe('a chat-capable provider', () => {
  test('a server holding a full transcript is fit, and reports what it measured', async () => {
    serve({ context: 32768 });
    const v = await load().probeProvider('local', 'chat');
    expect(v).toMatchObject({ provider: 'local', fit: true, code: null, measured: 32768 });
  });

  test('a context too small to hold a transcript is UNFIT, with the reason intact', async () => {
    process.env.LOCAL_AI_MIN_CONTEXT = '16384';
    serve({ context: 4096 });
    const v = await load().probeProvider('local', 'chat');
    expect(v.fit).toBe(false);
    expect(v.code).toBe('context_too_small');
    // The measured number has to survive into the reason — one value the operator forwards to
    // whoever administers the box is the whole point of refusing here rather than at call time.
    expect(v.reason).toMatch(/4096/);
  });

  test('reachable but not serving the pinned model is unfit', async () => {
    serve({ models: ['some-other-model'] });
    const v = await load().probeProvider('local', 'chat');
    expect(v).toMatchObject({ fit: false, code: 'provider_down' });
  });

  test('a server that cannot be reached at all is unfit, not unknown-therefore-fine', async () => {
    serve({ fail: 'connect ECONNREFUSED' });
    const v = await load().probeProvider('local', 'chat');
    expect(v.fit).toBe(false);
  });

  test('a context we could not read does not block a server that is otherwise serving', async () => {
    // vLLM and SGLang expose no equivalent of Ollama's /api/show. An unreadable context is unknown,
    // and only a context we READ and found too small may fail the check — otherwise every non-Ollama
    // server is permanently unswitchable.
    serve({ context: null });
    const v = await load().probeProvider('local', 'chat');
    expect(v.fit).toBe(true);
    expect(v.measured).toBeNull();
  });

  test('a provider name nobody serves is refused by name', async () => {
    const v = await load().probeProvider('not-a-provider', 'chat');
    expect(v).toMatchObject({ fit: false, code: 'unknown_provider' });
  });
});

describe('an embedding provider', () => {
  test('a vector of the corpus dimension is fit', async () => {
    process.env.RAG_EMBED_DIM = '768';
    serve({ vector: 768 });
    const v = await load().probeProvider('local', 'embed');
    expect(v).toMatchObject({ fit: true, measured: 768, required: 768 });
  });

  test('the wrong dimension is unfit, and names both numbers', async () => {
    // A length mismatch is rejected by pgvector, but a model that HAPPENS to match the length while
    // placing text in a different space returns confident nonsense. Catching it at switch time is
    // the only place the cause is legible.
    process.env.RAG_EMBED_DIM = '1536';
    serve({ vector: 768 });
    const v = await load().probeProvider('local', 'embed');
    expect(v).toMatchObject({ fit: false, code: 'embed_dim_mismatch', measured: 768, required: 1536 });
  });

  test('a chat-only provider cannot serve embeddings', async () => {
    const v = await load().probeProvider('anthropic', 'embed');
    expect(v).toMatchObject({ fit: false, code: 'unknown_provider' });
  });
});
