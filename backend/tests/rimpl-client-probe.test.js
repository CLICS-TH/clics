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
