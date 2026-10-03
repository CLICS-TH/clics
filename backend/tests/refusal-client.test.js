// rimpl answers a safeguard refusal with 422 { code: 'refused', category, input_tokens, output_tokens,
// provider, model } (rimpl/src/lib/ai-errors.js). The client must (a) keep the BILLED usage on the
// error so callers can meter it, (b) let only a one-word category and a whitelisted provider through,
// and (c) classify it as deterministic, so neither the drain nor /end re-pays for a guaranteed decline.
jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());
const { rimplChat, rimplEvaluate, isDeterministicRimplError } = require('../src/services/rimpl-client');
const { isRimplRefusal } = require('../src/lib/rimpl-refusal');

const realFetch = global.fetch;
const reply = (status, body) => ({ ok: false, status, json: async () => body, headers: new Map() });
afterEach(() => { global.fetch = realFetch; });

test('a 422 refused carries usage + category, and is deterministic', async () => {
  global.fetch = jest.fn(async () => reply(422, {
    error: 'The AI model declined this request.', code: 'refused', category: 'bio',
    input_tokens: 900, output_tokens: 3, provider: 'anthropic', model: 'claude-sonnet-5-5',
  }));
  const err = await rimplEvaluate({ ple_id: 'p', transcript: [] }).catch((e) => e);
  expect(err.status).toBe(422);
  expect(err.code).toBe('refused');
  expect(err.category).toBe('bio');
  expect(err.usage).toEqual({ input_tokens: 900, output_tokens: 3, provider: 'anthropic' });
  expect(isRimplRefusal(err)).toBe(true);
  expect(isDeterministicRimplError(err)).toBe(true);
});

test('a category carrying text is dropped; an unknown provider bills at the PAID rate; non-numbers are 0', async () => {
  global.fetch = jest.fn(async () => reply(422, {
    code: 'refused', category: 'Bio — patient สมชาย', input_tokens: '900', output_tokens: null, provider: 'mystery',
  }));
  const err = await rimplChat({ ple_id: 'p', history: [], message: 'q' }).catch((e) => e);
  expect(err.category).toBeNull();
  expect(err.usage).toEqual({ input_tokens: 0, output_tokens: 0, provider: 'anthropic' });
});

test('a /chat refusal carries the rescue classifier\'s usage (study spend), numbers only', async () => {
  global.fetch = jest.fn(async () => reply(422, { code: 'refused', input_tokens: 10, output_tokens: 1, provider: 'anthropic',
    assessment: { input_tokens: 900, output_tokens: 40, provider: 'anthropic', note: 'ignored' } }));
  const err = await rimplChat({ ple_id: 'p', history: [], message: 'q' }).catch((e) => e);
  expect(err.assessment).toEqual({ input_tokens: 900, output_tokens: 40, provider: 'anthropic' });
});

test('a local refusal keeps the local ($0) provider', async () => {
  global.fetch = jest.fn(async () => reply(422, { code: 'refused', category: null, input_tokens: 10, output_tokens: 1, provider: 'local' }));
  const err = await rimplChat({ ple_id: 'p', history: [], message: 'q' }).catch((e) => e);
  expect(err.usage.provider).toBe('local');
});

test('any other error is not a refusal', async () => {
  global.fetch = jest.fn(async () => reply(502, { error: 'Classifier returned invalid JSON' }));
  const err = await rimplChat({ ple_id: 'p', history: [], message: 'q' }).catch((e) => e);
  expect(isRimplRefusal(err)).toBe(false);
  expect(err.usage).toBeUndefined();
});
