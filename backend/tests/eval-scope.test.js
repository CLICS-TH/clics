// lib/eval-scope: the council partition between the prod drain and a laptop stack sharing the DB.
let mockSettings, mockCouncils, mockCouncilsError;
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      let key;
      const c = {
        select: () => c, in: () => c,
        eq: (col, val) => { if (col === 'key') key = val; return c; },
        maybeSingle: () => Promise.resolve({ data: table === 'app_settings' ? (mockSettings[key] ?? null) : null, error: null }),
        then: (resolve) => Promise.resolve(table === 'councils'
          ? (mockCouncilsError ? { data: null, error: { message: mockCouncilsError } } : { data: mockCouncils, error: null })
          : { data: null, error: null }).then(resolve),
      };
      return c;
    },
  },
}));

function load(env = {}) {
  let mod;
  jest.isolateModules(() => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try { mod = require('../src/lib/eval-scope'); }
    finally { process.env = saved; }
  });
  return mod;
}

beforeEach(() => { mockSettings = {}; mockCouncils = []; mockCouncilsError = null; });

test('no setting, no env → no filters', async () => {
  const { resolveScope } = load({ EVAL_DRAIN_ONLY_COUNCILS: '', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  expect(await resolveScope()).toMatchObject({ exclude: null, include: null });
});

test('exclude setting resolves council codes to ids (case-insensitive)', async () => {
  mockSettings = { eval_drain_exclude_councils: { value_text: 'sandbox, ENG' } };
  mockCouncils = [{ id: 'c-sbx', code: 'SANDBOX' }, { id: 'c-eng', code: 'ENG' }];
  const { resolveScope } = load({ EVAL_DRAIN_ONLY_COUNCILS: '', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  expect((await resolveScope()).exclude.sort()).toEqual(['c-eng', 'c-sbx']);
});

test('include env resolves; an UNKNOWN include code matches nothing, never everything', async () => {
  mockCouncils = [{ id: 'c-sbx', code: 'SANDBOX' }];
  const a = load({ EVAL_DRAIN_ONLY_COUNCILS: 'SANDBOX', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  expect((await a.resolveScope()).include).toEqual(['c-sbx']);
  mockCouncils = [];
  const b = load({ EVAL_DRAIN_ONLY_COUNCILS: 'TYPO', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  expect((await b.resolveScope()).include).toEqual([b.NIL_UUID]);
});

test('an unknown EXCLUDE code fails CLOSED: the drain claims nothing (never "everything") until the setting is fixed', async () => {
  mockSettings = { eval_drain_exclude_councils: { value_text: 'SANDBX' } }; // typo for SANDBOX
  mockCouncils = [{ id: 'c-sbx', code: 'SANDBOX' }];
  const m = load({ EVAL_DRAIN_ONLY_COUNCILS: '', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  const scope = await m.resolveScope();
  expect(scope.include).toEqual([m.NIL_UUID]);
  expect(scope.failedClosed).toMatch(/unknown council code/);
});

test('a failed councils read fails CLOSED too (a partial exclude list is the confound the scope exists to prevent)', async () => {
  mockSettings = { eval_drain_exclude_councils: { value_text: 'SANDBOX' } };
  mockCouncilsError = 'connection reset';
  const m = load({ EVAL_DRAIN_ONLY_COUNCILS: '', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  const scope = await m.resolveScope();
  expect(scope.include).toEqual([m.NIL_UUID]);
  expect(scope.failedClosed).toMatch(/councils read failed/);
});

test('an include scope makes the shared exclude setting irrelevant on that box (the two halves must not cancel)', async () => {
  mockSettings = { eval_drain_exclude_councils: { value_text: 'SANDBOX' } }; // prod's half, read from the shared DB
  mockCouncils = [{ id: 'c-sbx', code: 'SANDBOX' }];
  const m = load({ EVAL_DRAIN_ONLY_COUNCILS: 'SANDBOX', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  const scope = await m.resolveScope();
  expect(scope.include).toEqual(['c-sbx']);
  expect(scope.exclude).toBeNull();
  expect(scope.excludeCodes).toEqual([]);
  expect(scope.failedClosed).toBeNull();
});

test('the include env is REFUSED in production at module load', () => {
  expect(() => load({ EVAL_DRAIN_ONLY_COUNCILS: 'SANDBOX', NODE_ENV: 'production', RAILWAY_ENVIRONMENT: '' })).toThrow(/refused in production/);
  expect(() => load({ EVAL_DRAIN_ONLY_COUNCILS: 'SANDBOX', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: 'production' })).toThrow(/refused in production/);
});
