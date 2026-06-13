// The PIS-7 evaluator's d1..d7 drive CME credit and are persisted into smallint CHECK(0..5) columns.
// /evaluate must reject malformed/out-of-range model output (502) rather than pass it through to
// poison the composite (NaN) or trip a CHECK violation downstream that reconcile then retries forever.
jest.mock('../src/services/claude', () => ({ callClaude: jest.fn() }));

const request = require('supertest');
const app = require('../src/index');
const { callClaude } = require('../src/services/claude');

const VALID = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: {} };
const body = { ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }] };
const reply = (obj) => ({ text: JSON.stringify(obj), inputTokens: 1, outputTokens: 1 });

describe('POST /evaluate output validation', () => {
  beforeEach(() => callClaude.mockReset());

  test('out-of-range domain score -> 502', async () => {
    callClaude.mockResolvedValueOnce(reply({ ...VALID, d2: 9 }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(502);
  });

  test('non-numeric domain score -> 502', async () => {
    callClaude.mockResolvedValueOnce(reply({ ...VALID, d2: 'high' }));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(502);
  });

  test('missing domain -> 502', async () => {
    const { d5, ...missing } = VALID;
    callClaude.mockResolvedValueOnce(reply(missing));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(502);
  });

  test('valid 0-5 scores -> 200 with clean composite', async () => {
    callClaude.mockResolvedValueOnce(reply(VALID));
    const res = await request(app).post('/evaluate').send(body);
    expect(res.status).toBe(200);
    expect(res.body.d2).toBe(4);
    // (3*.15+4*.20+3*.15+2*.15+5*.15+1*.10+4*.10)*20, rounded 2dp
    expect(res.body.composite_score).toBeGreaterThan(0);
    expect(Number.isFinite(res.body.composite_score)).toBe(true);
  });
});
