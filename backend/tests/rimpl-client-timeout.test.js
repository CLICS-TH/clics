const savedFetch = global.fetch;
afterEach(() => { global.fetch = savedFetch; jest.restoreAllMocks(); });

const { rimplChat, rimplEvaluate } = require('../src/services/rimpl-client');

const CHAT = { ple_id: 'p1', history: [], message: 'hello', language: 'th' };
const EVAL = { ple_id: 'p1', transcript: [{ role: 'physician', content: 'x' }], patient_ref: null, shadow: false };

const silentRimpl = () => jest.fn((_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
}));
const answeringRimpl = (body) => jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }));

test('rimplEvaluate gives up at the timeoutMs it is given', async () => {
  global.fetch = silentRimpl();
  const err = await rimplEvaluate(EVAL, { timeoutMs: 20 }).catch((e) => e);
  expect(err.name).toBe('TimeoutError');
});

test('rimplChat gives up at the timeoutMs it is given', async () => {
  global.fetch = silentRimpl();
  const err = await rimplChat(CHAT, { timeoutMs: 20 }).catch((e) => e);
  expect(err.name).toBe('TimeoutError');
});

test('without the option, evaluate keeps its 480 s deadline and chat its 100 s one', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  global.fetch = answeringRimpl({ d1: 3 });
  await rimplEvaluate(EVAL);
  global.fetch = answeringRimpl({ content: 'hi' });
  await rimplChat(CHAT);
  expect(timeout.mock.calls).toEqual([[480000], [100000]]);
});

test('shadow: false reaches the wire as false, or rimpl would run its shadow evaluation by default', async () => {
  global.fetch = answeringRimpl({ d1: 3 });
  await rimplEvaluate(EVAL, { timeoutMs: 60000 });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).shadow).toBe(false);
});
