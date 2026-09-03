// Every field the /chat contract carries must actually reach the wire.
//
// rimplChat destructures its argument and re-serializes a fresh object, so a field the backend
// computes is dropped in silence if the adapter forgets it — no error, no type failure, no test.
// That is how `rescue_rounds` went missing: routes/ples.js derives it and passes it, RIMPL's schema
// defaults it to 0, and the eight-round rescue ceiling therefore never fired. A session that never
// recovered was re-assessed by the classifier on every subsequent turn, unbounded and billed.
//
// This suite asserts the serialized body, not the call arguments, because the call arguments were
// always right — the loss happened between them.

const savedFetch = global.fetch;
afterAll(() => { global.fetch = savedFetch; });

const { rimplChat } = require('../src/services/rimpl-client');

const okResponse = () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  json: async () => ({ content: 'hi', refs: [] }),
});

const sentBody = () => JSON.parse(global.fetch.mock.calls[0][1].body);

const CALL = {
  ple_id: 'p1', history: [], message: 'hello', language: 'th',
  chief_complaint: 'chest pain', patient_ref: null,
  socratic: false, artifacts: false,
  rescue_active: true, already_qualified: false,
  rescue_rounds: 5,
};

beforeEach(() => { global.fetch = jest.fn(async () => okResponse()); });

test('rescue_rounds reaches the wire — the ceiling cannot fire without it', async () => {
  await rimplChat(CALL);
  expect(sentBody().rescue_rounds).toBe(5);
});

test('every field of the /chat contract is serialized', async () => {
  await rimplChat(CALL);
  const body = sentBody();
  for (const k of ['ple_id', 'history', 'message', 'language', 'chief_complaint', 'patient_ref',
    'socratic', 'artifacts', 'rescue_active', 'already_qualified', 'rescue_rounds']) {
    expect(body).toHaveProperty(k);
  }
});

test('an absent or nonsense rescue_rounds serializes as 0, never NaN or undefined', async () => {
  await rimplChat({ ...CALL, rescue_rounds: undefined });
  expect(sentBody().rescue_rounds).toBe(0);

  global.fetch = jest.fn(async () => okResponse());
  await rimplChat({ ...CALL, rescue_rounds: -3 });
  expect(sentBody().rescue_rounds).toBe(0);
});

test('the latches are sent as booleans, so a null row value cannot read as "not rescued"', async () => {
  await rimplChat({ ...CALL, rescue_active: null, already_qualified: 1 });
  const body = sentBody();
  expect(body.rescue_active).toBe(false);
  expect(body.already_qualified).toBe(true);
});
