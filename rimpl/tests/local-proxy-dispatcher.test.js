// The local provider may need to reach the on-prem box through a Tailscale HTTP proxy when rimpl
// itself runs off the tailnet. Two things have to be true, and only one of them is about the proxy:
//
//   1. With LOCAL_AI_HTTP_PROXY unset — the on-prem deployment, and every other environment —
//      nothing changes. `dispatcher` must be undefined, not a no-op agent, so fetch takes exactly
//      the path it took before this existed.
//   2. Only THIS provider is proxied. Anthropic and Supabase must keep their normal route; sending
//      them down the tunnel would make an outage of the on-prem box an outage of everything.
//
// The second point is why the dispatcher is passed per-request rather than set globally, and it is
// what this suite exists to hold in place.

const local = require('../src/services/providers/local');

const savedFetch = global.fetch;
const savedEnv = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  delete process.env.LOCAL_AI_HTTP_PROXY;
  local._resetDispatcher();
  process.env.LOCAL_AI_BASE_URL = 'http://100.68.210.69:11434';
  process.env.LOCAL_AI_MODEL = 'test-model';
  global.fetch = jest.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1 } }),
  }));
});

afterEach(() => { global.fetch = savedFetch; process.env = { ...savedEnv }; local._resetDispatcher(); });

const fetchOpts = () => global.fetch.mock.calls[0][1];

test('no proxy configured → dispatcher is undefined, so fetch behaves exactly as before', async () => {
  await local.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => {});
  expect(global.fetch).toHaveBeenCalled();
  expect(fetchOpts()).toHaveProperty('dispatcher', undefined);
});

test('proxy configured → a dispatcher is attached to the request', async () => {
  process.env.LOCAL_AI_HTTP_PROXY = 'http://127.0.0.1:1055';
  local._resetDispatcher();
  await local.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => {});
  expect(fetchOpts().dispatcher).toBeDefined();
});

test('the dispatcher is memoised — one agent, not one per request', async () => {
  process.env.LOCAL_AI_HTTP_PROXY = 'http://127.0.0.1:1055';
  local._resetDispatcher();
  await local.call({ messages: [{ role: 'user', content: 'a' }] }).catch(() => {});
  await local.call({ messages: [{ role: 'user', content: 'b' }] }).catch(() => {});
  const [first, second] = global.fetch.mock.calls.map(([, o]) => o.dispatcher);
  expect(first).toBe(second);
});

test('the proxy is not applied globally — no global dispatcher is installed', async () => {
  process.env.LOCAL_AI_HTTP_PROXY = 'http://127.0.0.1:1055';
  local._resetDispatcher();
  await local.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => {});
  // undici's global dispatcher is what an Anthropic or Supabase call would pick up. If this ever
  // becomes the ProxyAgent, every cloud call starts routing through the on-prem tunnel.
  const { getGlobalDispatcher, ProxyAgent } = require('undici');
  expect(getGlobalDispatcher()).not.toBeInstanceOf(ProxyAgent);
});
