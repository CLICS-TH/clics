// triggerEvaluation must retry a transient RIMPL failure instead of silently stranding a passed PLE.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockUpdates = [];
let mockInsertErr = {}; // { tableName: 'message' } to simulate an insert failure
// The evaluator lock settings (app_settings.value_text by key), and an error to answer their read with.
let mockLockSettings = {};
let mockSettingsReadErr = null;

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      // mockInsertErr[table] can be a string (generic error) or { code } (e.g. '23505' dup).
      insert: () => Promise.resolve({ error: mockInsertErr[table]
        ? (typeof mockInsertErr[table] === 'string' ? { message: mockInsertErr[table] } : mockInsertErr[table])
        : null }),
      update: (patch) => ({ eq: () => { mockUpdates.push({ table, patch }); return Promise.resolve({ error: null }); } }),
      // The weights-digest read (lib/settings.js evaluatorWeightsSha256, strict).
      select: () => ({ eq: (_c, key) => ({ maybeSingle: () => Promise.resolve(mockSettingsReadErr
        ? { data: null, error: { message: mockSettingsReadErr } }
        : { data: key in mockLockSettings ? { value_text: mockLockSettings[key] } : null, error: null }) }) }),
    }),
  },
}));

let mockAttempts = 0;
let mockFailFirst = 0;     // how many leading calls should throw
let mockRejectStatus = null; // status to attach to the rejection (for the deterministic-skip test)
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluate: jest.fn(() => {
    mockAttempts++;
    if (mockAttempts <= mockFailFirst) {
      const e = new Error('RIMPL error');
      if (mockRejectStatus != null) e.status = mockRejectStatus;
      return Promise.reject(e);
    }
    return Promise.resolve({ d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {}, model_version: 'test', input_tokens: 100, output_tokens: 50 });
  }),
  isDeterministicRimplError: (e) => e && [400, 401, 403, 422, 502].includes(e.status),
}));

const mockAccrue = jest.fn(async () => ({ cost: 0, error: null }));
jest.mock('../src/lib/usage', () => ({ accrueUsage: (...a) => mockAccrue(...a) }));

const { triggerEvaluation, persistEvaluation } = require('../src/services/ple-evaluation');

beforeEach(() => { mockAttempts = 0; mockFailFirst = 0; mockRejectStatus = null; mockUpdates = []; mockInsertErr = {}; mockAccrue.mockClear(); mockLockSettings = {}; mockSettingsReadErr = null; require('../src/services/rimpl-client').rimplEvaluate.mockClear(); });

test('succeeds on first try when RIMPL is healthy', async () => {
  await triggerEvaluation('ple1', [{ role: 'physician', content: 'x' }], 'doc1');
  expect(mockAttempts).toBe(1);
  expect(mockUpdates.some(u => u.table === 'ples' && u.patch.status === 'evaluated')).toBe(true);
});

test('retries a transient RIMPL failure then succeeds', async () => {
  mockFailFirst = 2; // fail twice, succeed on the 3rd
  await triggerEvaluation('ple2', [{ role: 'physician', content: 'x' }], 'doc1');
  expect(mockAttempts).toBe(3);
  expect(mockUpdates.some(u => u.table === 'ples' && u.patch.status === 'evaluated')).toBe(true);
});

test('gives up (throws) after exhausting retries', async () => {
  mockFailFirst = 99;
  await expect(triggerEvaluation('ple3', [], 'doc1')).rejects.toThrow(/RIMPL error/);
  expect(mockAttempts).toBe(3); // 3 attempts, no more
});

test('does NOT retry a deterministic failure (502 bad output) — fails fast, one attempt (F7)', async () => {
  mockFailFirst = 99; mockRejectStatus = 502;
  const err = await triggerEvaluation('ple3b', [], 'doc1').catch(e => e);
  expect(err.status).toBe(502);
  expect(mockAttempts).toBe(1); // no wasted re-pays on a guaranteed failure
});

test('accrues usage on a fresh eval, but NOT on a duplicate (23505) — no double-billing (F9)', async () => {
  await triggerEvaluation('ple-fresh', [{ role: 'physician', content: 'x' }], 'doc1');
  expect(mockAccrue).toHaveBeenCalledTimes(1);

  mockAccrue.mockClear();
  mockInsertErr = { ai_evaluations: { code: '23505' } }; // a concurrent eval already wrote the row
  await triggerEvaluation('ple-dup', [{ role: 'physician', content: 'x' }], 'doc1');
  expect(mockAccrue).not.toHaveBeenCalled();
});

test('persistEvaluation throws and does NOT flip status when the score insert fails', async () => {
  mockInsertErr = { ai_evaluations: 'domain score out of range' };
  const result = { d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {}, model_version: 'test' };
  await expect(persistEvaluation('ple4', 'doc1', result)).rejects.toThrow(/ai_evaluations insert failed/);
  // no partial state: the PLE must not have been marked evaluated
  expect(mockUpdates.some(u => u.table === 'ples' && u.patch.status === 'evaluated')).toBe(false);
});

// The evaluator lock state rides on every evaluation: rimpl stamps provenance.locked = !!weights_sha256,
// and ai_evaluations is written once per PLE. An unreadable digest used to read as null ("unlocked"),
// so a post-lock score could be stamped `locked: false` for good.
describe('the lock state is read strictly', () => {
  const { rimplEvaluate } = require('../src/services/rimpl-client');

  test('the declared digest travels to rimpl when the lock is in force', async () => {
    mockLockSettings = { evaluator_weights_sha256: 'a'.repeat(64) };
    await triggerEvaluation('ple-locked', [{ role: 'physician', content: 'x' }], 'doc1');
    expect(rimplEvaluate).toHaveBeenCalledWith(expect.objectContaining({ weights_sha256: 'a'.repeat(64) }));
  });

  test('no digest (never locked, or unlocked) sends null — the honest "not locked"', async () => {
    await triggerEvaluation('ple-unlocked', [{ role: 'physician', content: 'x' }], 'doc1');
    expect(rimplEvaluate).toHaveBeenCalledWith(expect.objectContaining({ weights_sha256: null }));
  });

  test('an unreadable lock state DEFERS: a transient 503, thrown before rimpl is called, nothing written', async () => {
    mockSettingsReadErr = 'connection reset';
    const err = await triggerEvaluation('ple-unknown', [{ role: 'physician', content: 'x' }], 'doc1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.code).toBe('lock_state_unreadable');
    // Transient by the drain's own rule, so it is deferred with backoff rather than routed to manual QA.
    expect([400, 401, 403, 413, 422, 502]).not.toContain(err.status);
    expect(rimplEvaluate).not.toHaveBeenCalled();     // nothing paid for, nothing scored with a guess
    expect(mockUpdates).toHaveLength(0);
    expect(mockAccrue).not.toHaveBeenCalled();
  });
});
