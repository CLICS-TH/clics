// GET /health/deep readiness probe. Hermetic: the Anthropic SDK and Supabase are mocked so no key,
// network, or token is needed. The SDK mock constructs fine at module-load (claude.js line 9) and is
// only made to throw on demand (constructor-down case) — and we assert messages.create is NEVER
// called, proving the deep check spends zero Anthropic tokens.
let mockConstructorShouldThrow = false;
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => function Anthropic() {
  if (mockConstructorShouldThrow) throw new Error('SDK init failed');
  return { messages: { create: mockMessagesCreate } };
});

let mockSupabaseResult = { count: 1, error: null };
let mockSupabaseHang = false;
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: () => (mockSupabaseHang ? new Promise(() => {}) : Promise.resolve(mockSupabaseResult)),
      }),
    }),
  },
}));

// Tiny timeout so the "supabase hangs" case resolves fast. Set BEFORE requiring the app (health.js
// reads it at module load).
process.env.HEALTH_PROBE_TIMEOUT_MS = '50';
process.env.ANTHROPIC_API_KEY = 'sk-test-key';

const request = require('supertest');
const app = require('../src/index');

describe('GET /health/deep (rimpl)', () => {
  beforeEach(() => {
    mockConstructorShouldThrow = false;
    mockSupabaseHang = false;
    mockSupabaseResult = { count: 1, error: null };
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    mockMessagesCreate.mockClear();
  });

  test('all dependencies up → 200 ok with the pinned model', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('rimpl');
    expect(res.body.model).toBe('claude-sonnet-4-6');
    expect(res.body.checks.anthropic_key.status).toBe('up');
    expect(res.body.checks.anthropic_client.status).toBe('up');
    expect(res.body.checks.supabase.status).toBe('up');
  });

  test('missing ANTHROPIC_API_KEY → 503 degraded', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.anthropic_key.status).toBe('down');
  });

  test('Anthropic client not constructible → 503, and zero token spend', async () => {
    mockConstructorShouldThrow = true;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.anthropic_client.status).toBe('down');
    expect(mockMessagesCreate).toHaveBeenCalledTimes(0); // never calls the completion API
  });

  test('Supabase error → 503 degraded', async () => {
    mockSupabaseResult = { count: null, error: { message: 'connection refused' } };
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.supabase.status).toBe('down');
    expect(res.body.checks.supabase.error).toMatch(/connection refused/);
  });

  test('Supabase timeout → down (no hang) + 503', async () => {
    mockSupabaseHang = true;
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.checks.supabase.status).toBe('down');
    expect(res.body.checks.supabase.error).toMatch(/timeout/);
  });

  test('reachable without the x-internal-token (mounted before the auth gate)', async () => {
    const res = await request(app).get('/health/deep'); // no x-internal-token header
    expect(res.status).not.toBe(401);
    expect(res.body.service).toBe('rimpl');
  });
});
