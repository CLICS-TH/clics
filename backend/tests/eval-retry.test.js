// triggerEvaluation must retry a transient RIMPL failure instead of silently stranding a passed PLE.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockUpdates = [];
let mockInserts = [];   // { table, row } for every insert, so "nothing was saved" can be asserted
let mockInsertErr = {}; // { tableName: 'message' } to simulate an insert failure
// The evaluator lock settings (app_settings.value_text by key), and an error to answer their read with.
let mockLockSettings = {};
let mockSettingsReadErr = null;
// The evaluator_model_lock row the flag points at (null = none), and an error to answer its read with.
let mockLockRecord = null;
let mockRecordReadErr = null;

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      // mockInsertErr[table] can be a string (generic error) or { code } (e.g. '23505' dup).
      insert: (row) => { mockInserts.push({ table, row }); return Promise.resolve({ error: mockInsertErr[table]
        ? (typeof mockInsertErr[table] === 'string' ? { message: mockInsertErr[table] } : mockInsertErr[table])
        : null }); },
      update: (patch) => ({ eq: () => { mockUpdates.push({ table, patch }); return Promise.resolve({ error: null }); } }),
      // The lock-state reads (services/ple-evaluation.js evaluationLockStamp): both settings in one
      // .in('key', [...]) statement, then the record behind the flag by .eq('locked_at', ...).
      select: () => {
        const ins = [];
        const chain = {
          in: (c, vals) => { ins.push([c, vals]); return chain; },
          eq: () => chain, order: () => chain, limit: () => chain,
          maybeSingle: () => Promise.resolve(table === 'evaluator_model_lock' && mockRecordReadErr
            ? { data: null, error: { message: mockRecordReadErr } }
            : { data: table === 'evaluator_model_lock' ? mockLockRecord : null, error: null }),
          then: (res, rej) => Promise.resolve(mockSettingsReadErr
            ? { data: null, error: { message: mockSettingsReadErr } }
            : { data: (ins.find(([c]) => c === 'key')?.[1] ?? []).filter((k) => k in mockLockSettings)
              .map((k) => ({ key: k, value_text: mockLockSettings[k] })), error: null }).then(res, rej),
        };
        return chain;
      },
    }),
  },
}));

let mockAttempts = 0;
let mockFailFirst = 0;     // how many leading calls should throw
let mockRejectStatus = null; // status to attach to the rejection (for the deterministic-skip test)
// The provenance rimpl answers with, from the payload it was sent. Default: a CURRENT rimpl, which stamps
// back both lock digests it received. A test swaps it to play an older rimpl; undefined omits the key.
const mockEcho = (p) => ({ weights_sha256: p.weights_sha256 ?? null, lock_declaration_sha256: p.lock_declaration_sha256 ?? null, locked: !!p.weights_sha256 });
let mockProvenance = mockEcho;
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluate: jest.fn((payload) => {
    mockAttempts++;
    if (mockAttempts <= mockFailFirst) {
      const e = new Error('RIMPL error');
      if (mockRejectStatus != null) e.status = mockRejectStatus;
      return Promise.reject(e);
    }
    const provenance = mockProvenance(payload);
    return Promise.resolve({ d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {}, model_version: 'test', input_tokens: 100, output_tokens: 50,
      ...(provenance === undefined ? {} : { provenance }) });
  }),
  isDeterministicRimplError: (e) => e && [400, 401, 403, 422, 502].includes(e.status),
}));

const mockAccrue = jest.fn(async () => ({ cost: 0, error: null }));
jest.mock('../src/lib/usage', () => ({ accrueUsage: (...a) => mockAccrue(...a) }));

const { triggerEvaluation, persistEvaluation } = require('../src/services/ple-evaluation');

beforeEach(() => { mockAttempts = 0; mockFailFirst = 0; mockRejectStatus = null; mockUpdates = []; mockInserts = []; mockProvenance = mockEcho; mockInsertErr = {}; mockAccrue.mockClear(); mockLockSettings = {}; mockSettingsReadErr = null; mockLockRecord = null; mockRecordReadErr = null; require('../src/services/rimpl-client').rimplEvaluate.mockClear(); });

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
// so a post-lock score could be stamped `locked: false` for good. Since #75 criterion 7 the declaration
// digest rides too, so a lock whose record cannot be read, or does not match, defers the same way.
describe('the lock state is read strictly', () => {
  const { rimplEvaluate } = require('../src/services/rimpl-client');
  const { lockDeclarationDigest } = require('../src/services/model-lock');
  const LOCKED_AT = '2026-10-15T09:00:00.000Z';
  const RECORD = {
    id: 'lock-1', locked_at: LOCKED_AT, provider: 'local', model_version: 'CCME_LLM_v8.0+qwen-2.5-72b',
    weights_sha256: 'a'.repeat(64), inference_engine: 'vllm 0.21.1', quantization: 'fp8',
    system_prompt_version: 'sys-v3', evaluator_prompt_version: 'pis7-prompt-59561c29+local-c5ffe572aa81',
    rubric_version: 'pis7-weights-08b0cb1a', decoding: { temperature: 0, max_tokens: 4096 }, environment: { vllm: '0.21.1' },
  };
  const lockIt = () => {
    mockLockSettings = { evaluator_locked_at: LOCKED_AT, evaluator_weights_sha256: 'a'.repeat(64) };
    mockLockRecord = RECORD;
  };
  // A deferral: a transient 503 carrying `code`, thrown before rimpl is called, nothing written or billed.
  const expectDeferred = async (pleId, code) => {
    const err = await triggerEvaluation(pleId, [{ role: 'physician', content: 'x' }], 'doc1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.code).toBe(code);
    // Transient by the drain's own rule, so it is deferred with backoff rather than routed to manual QA.
    expect([400, 401, 403, 413, 422, 502]).not.toContain(err.status);
    expect(rimplEvaluate).not.toHaveBeenCalled();     // nothing paid for, nothing scored with a guess
    expect(mockUpdates).toHaveLength(0);
    expect(mockAccrue).not.toHaveBeenCalled();
  };

  test('the declared digest AND the declaration digest travel to rimpl when the lock is in force', async () => {
    lockIt();
    await triggerEvaluation('ple-locked', [{ role: 'physician', content: 'x' }], 'doc1');
    expect(rimplEvaluate).toHaveBeenCalledWith(expect.objectContaining({
      weights_sha256: 'a'.repeat(64), lock_declaration_sha256: lockDeclarationDigest(RECORD),
    }));
    expect(lockDeclarationDigest(RECORD)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('no lock (never locked, or unlocked) sends weights null and no declaration — the honest "not locked"', async () => {
    await triggerEvaluation('ple-unlocked', [{ role: 'physician', content: 'x' }], 'doc1');
    expect(rimplEvaluate).toHaveBeenCalledWith(expect.objectContaining({ weights_sha256: null, lock_declaration_sha256: null }));
  });

  test('a digest left behind with no flag is not a lock: no declaration is sent (and none is looked up)', async () => {
    // The state the retired quick unlock left (flag cleared, digest kept). Its weights still travel as
    // before; nothing claims a declaration that is not in force.
    mockLockSettings = { evaluator_weights_sha256: 'a'.repeat(64) };
    mockLockRecord = RECORD;
    await triggerEvaluation('ple-stale', [{ role: 'physician', content: 'x' }], 'doc1');
    expect(rimplEvaluate).toHaveBeenCalledWith(expect.objectContaining({ weights_sha256: 'a'.repeat(64), lock_declaration_sha256: null }));
  });

  test('a lock whose record cannot be read DEFERS', async () => {
    lockIt();
    mockRecordReadErr = 'connection reset';
    await expectDeferred('ple-rec-unreadable', 'lock_record_unreadable');
  });

  test('a lock with no record behind its flag (a hand-set lock) DEFERS', async () => {
    lockIt();
    mockLockRecord = null;
    await expectDeferred('ple-rec-missing', 'lock_record_missing');
  });

  test('a lock whose record names other weights than the setting DEFERS', async () => {
    lockIt();
    mockLockRecord = { ...RECORD, weights_sha256: 'b'.repeat(64) };
    await expectDeferred('ple-rec-inconsistent', 'lock_state_inconsistent');
  });

  test('a flag with no weights digest beside it DEFERS (the record cannot match)', async () => {
    lockIt();
    mockLockSettings = { evaluator_locked_at: LOCKED_AT };
    await expectDeferred('ple-flag-only', 'lock_state_inconsistent');
  });

  test('an unreadable lock state DEFERS: a transient 503, thrown before rimpl is called, nothing written', async () => {
    mockSettingsReadErr = 'connection reset';
    await expectDeferred('ple-unknown', 'lock_state_unreadable');
  });

  test('each deferral says what is actually wrong, not "unreadable" for every case', async () => {
    const said = async (setup) => {
      setup();
      const err = await triggerEvaluation('ple-msg', [{ role: 'physician', content: 'x' }], 'doc1').catch((e) => e);
      return err.message;
    };
    expect(await said(() => { mockSettingsReadErr = 'connection reset'; })).toMatch(/lock settings could not be read \(lock_state_unreadable: connection reset\)/);
    mockSettingsReadErr = null;
    expect(await said(() => { lockIt(); mockRecordReadErr = 'reset'; })).toMatch(/lock record behind the lock in force could not be read \(lock_record_unreadable/);
    mockRecordReadErr = null;
    expect(await said(() => { lockIt(); mockLockRecord = null; })).toMatch(/no lock record stands behind the lock in force \(lock_record_missing/);
    expect(await said(() => { lockIt(); mockLockRecord = { ...RECORD, weights_sha256: 'b'.repeat(64) }; }))
      .toMatch(/names other weights than the lock settings \(lock_state_inconsistent/);
  });

  // ---- the echo check: a locked score is saved only if rimpl stamped back what it was sent ----------
  // An older rimpl's zod schema strips lock_declaration_sha256 and still answers 200, with the weights-only
  // fingerprint every declaration over the same weights shares. Saving that is the #75 criterion-7 failure.
  describe('the echo check', () => {
    // Not saved: rimpl WAS called (and the reply discarded), but nothing is written and nothing is billed
    // to the physician, so the next attempt scores the PLE afresh.
    const expectNotSaved = async (pleId, code) => {
      const err = await triggerEvaluation(pleId, [{ role: 'physician', content: 'x' }], 'doc1').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(503);
      expect(err.code).toBe(code);
      expect([400, 401, 403, 413, 422, 502]).not.toContain(err.status);   // transient: deferred, not manual QA
      expect(rimplEvaluate).toHaveBeenCalledTimes(1);
      expect(mockInserts).toHaveLength(0);
      expect(mockUpdates).toHaveLength(0);
      expect(mockAccrue).not.toHaveBeenCalled();
      return err;
    };
    const expectSaved = () => {
      expect(mockInserts.some((i) => i.table === 'ai_evaluations')).toBe(true);
      expect(mockUpdates.some((u) => u.table === 'ples' && u.patch.status === 'evaluated')).toBe(true);
    };
    beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { console.error.mockRestore(); });

    test('an older rimpl that drops the declaration: not saved, 503 lock_declaration_not_stamped, one log line naming the cause', async () => {
      lockIt();
      // Master's rimpl: the unknown key stripped, the weights stamped, `locked: true`.
      mockProvenance = (p) => ({ weights_sha256: p.weights_sha256, locked: true });
      await expectNotSaved('ple-old-rimpl', 'lock_declaration_not_stamped');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error.mock.calls[0][0]).toMatch(/ple-old-rimpl: rimpl did not stamp lock_declaration_sha256 .*older than this backend/);
    });

    test('a reply with no provenance at all, under a lock: not saved', async () => {
      lockIt();
      mockProvenance = () => undefined;
      await expectNotSaved('ple-no-prov', 'lock_declaration_not_stamped');
    });

    test('the wrong declaration digest echoed: not saved', async () => {
      lockIt();
      mockProvenance = (p) => ({ ...mockEcho(p), lock_declaration_sha256: 'c'.repeat(64) });
      await expectNotSaved('ple-wrong-decl', 'lock_declaration_not_stamped');
    });

    test('the weights digest not echoed: not saved, 503 lock_weights_not_stamped', async () => {
      lockIt();
      mockProvenance = (p) => ({ ...mockEcho(p), weights_sha256: null });
      await expectNotSaved('ple-no-weights', 'lock_weights_not_stamped');
    });

    test('the wrong weights digest echoed: not saved', async () => {
      lockIt();
      mockProvenance = (p) => ({ ...mockEcho(p), weights_sha256: 'b'.repeat(64) });
      await expectNotSaved('ple-wrong-weights', 'lock_weights_not_stamped');
    });

    test('a correct echo is saved, with that provenance', async () => {
      lockIt();
      await triggerEvaluation('ple-echoed', [{ role: 'physician', content: 'x' }], 'doc1');
      expectSaved();
      expect(mockInserts.find((i) => i.table === 'ai_evaluations').row.provenance)
        .toMatchObject({ weights_sha256: 'a'.repeat(64), lock_declaration_sha256: lockDeclarationDigest(RECORD) });
      expect(mockAccrue).toHaveBeenCalledTimes(1);
    });

    test('the echo is compared case-insensitively (hex is the same digest in either case)', async () => {
      lockIt();
      mockProvenance = (p) => ({ weights_sha256: p.weights_sha256.toUpperCase(), lock_declaration_sha256: p.lock_declaration_sha256.toUpperCase() });
      await triggerEvaluation('ple-upper', [{ role: 'physician', content: 'x' }], 'doc1');
      expectSaved();
    });

    test('unlocked: nothing was sent, nothing is checked, and the score is saved as today (even with no provenance)', async () => {
      mockProvenance = () => undefined;
      await triggerEvaluation('ple-unlocked-saved', [{ role: 'physician', content: 'x' }], 'doc1');
      expectSaved();
      expect(console.error).not.toHaveBeenCalled();
    });

    test('a weights digest with no lock in force (the old quick unlock\'s leftover) is echo-checked too', async () => {
      mockLockSettings = { evaluator_weights_sha256: 'a'.repeat(64) };
      mockProvenance = (p) => ({ ...mockEcho(p), weights_sha256: null });
      await expectNotSaved('ple-stale-unechoed', 'lock_weights_not_stamped');
    });
  });
});
