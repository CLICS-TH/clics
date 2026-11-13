// Unit-test the probeRimplDeep helper (the backend's readiness probe to RIMPL). global.fetch is
// stubbed so no network happens. Unlike rimplChat, this MUST NOT throw on a non-200 — a 503 is a
// meaningful "RIMPL degraded" answer the health route bubbles; only transport errors propagate.
const { probeRimplDeep } = require('../src/services/rimpl-client');

describe('probeRimplDeep', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  test('200 → { httpStatus, body }', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ status: 'ok' }) });
    const r = await probeRimplDeep({ timeoutMs: 100 });
    expect(r.httpStatus).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });

  test('503 with a body returns (does NOT throw)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 503, json: async () => ({ status: 'degraded' }) });
    const r = await probeRimplDeep({ timeoutMs: 100 });
    expect(r.httpStatus).toBe(503);
    expect(r.body.status).toBe('degraded');
  });

  test('unparseable body → body null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200, json: async () => { throw new Error('not json'); } });
    const r = await probeRimplDeep({ timeoutMs: 100 });
    expect(r.httpStatus).toBe(200);
    expect(r.body).toBeNull();
  });

  test('network/timeout error propagates (caller maps to down)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted'));
    await expect(probeRimplDeep({ timeoutMs: 100 })).rejects.toThrow(/aborted/);
  });
});

// GET /manifest (CCME R2) feeds the Model Lock. It THROWS on anything but a 2xx JSON object, so the
// caller (services/model-lock.js) can fail closed on one path rather than reason about half-answers.
describe('fetchRimplManifest', () => {
  const { fetchRimplManifest } = require('../src/services/rimpl-client');
  const origFetch = global.fetch;
  const origToken = process.env.INTERNAL_TOKEN;
  afterEach(() => { global.fetch = origFetch; if (origToken === undefined) delete process.env.INTERNAL_TOKEN; else process.env.INTERNAL_TOKEN = origToken; });

  test('200 → the parsed body, fetched from /manifest WITH the internal token and a timeout', async () => {
    process.env.INTERNAL_TOKEN = 'tok-test';
    const body = { manifest: { expected: {} }, sha256: 'f'.repeat(64), file: 'present', code_match: true, live: {}, drift: [] };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    await expect(fetchRimplManifest({ timeoutMs: 100 })).resolves.toEqual(body);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/manifest$/);
    expect(init.headers['x-internal-token']).toBe('tok-test');
    expect(init.signal).toBeDefined();
  });

  test('a non-2xx (an older rimpl answers 404; a token mismatch 401) throws with the status', async () => {
    for (const status of [404, 401, 500]) {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: 'x' }), headers: { get: () => null } });
      await expect(fetchRimplManifest({ timeoutMs: 100 })).rejects.toMatchObject({ status });
    }
  });

  test('a body that is not a JSON object throws', async () => {
    for (const bad of [null, [], 'manifest']) {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => bad });
      await expect(fetchRimplManifest({ timeoutMs: 100 })).rejects.toThrow(/not a JSON object/);
    }
  });

  test('a network error / timeout propagates', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted'));
    await expect(fetchRimplManifest({ timeoutMs: 100 })).rejects.toThrow(/aborted/);
  });
});

// GET /health/mode: rimpl's local-only mode. THROWS on anything but 'on' / 'off', so the superadmin switch
// (routes/superadmin.js localOnlyState) can count an unreadable mode as on.
describe('fetchRimplLocalOnly', () => {
  const { fetchRimplLocalOnly } = require('../src/services/rimpl-client');
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  test.each(['on', 'off'])('%s is returned as is, from /health/mode', async (mode) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ local_only: mode }) });
    await expect(fetchRimplLocalOnly({ timeoutMs: 100 })).resolves.toBe(mode);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/health\/mode$/);
  });

  test('a 404 (an older rimpl) throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchRimplLocalOnly({ timeoutMs: 100 })).rejects.toThrow(/404/);
  });

  test('any other value throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ local_only: true }) });
    await expect(fetchRimplLocalOnly({ timeoutMs: 100 })).rejects.toThrow(/local_only/);
  });

  test('a network error throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchRimplLocalOnly({ timeoutMs: 100 })).rejects.toThrow(/ECONNREFUSED/);
  });
});
