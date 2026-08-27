// The PLE qualifying gate (CREC082 PLE Instruction Sheet §1) and the consecutive-failure counter
// that now hangs off it.
//
// §1 defines a Professional Learning Episode by four qualities — a meaningful problem, developing
// reasoning, integration of context/evidence, reflective synthesis — and explicitly NOT by length:
// it is "not a short factual lookup, repeated questioning, or passive copying". c1-c3 (minutes,
// turns, tokens) used to terminate a session before it was ever classified; they are metadata now.
//
// The counter moved here from the /end route in the same change. Fed from /end it would have
// recorded a pass for every session that got that far and reset itself forever — a dead feature
// that still looked alive.
let mockCrit, mockUpdates, mockRpc;
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ update: (p) => { mockUpdates.push(p); return { eq: async () => ({ error: null }) }; } }),
    rpc: (fn, args) => { mockRpc.push([fn, args]); return Promise.resolve({ data: null, error: null }); },
  },
}));
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluateCriteria: jest.fn(async () => mockCrit),
  isDeterministicRimplError: () => false,
}));
jest.mock('../src/services/cle-evaluation', () => ({ triggerEvaluation: jest.fn(async () => {}) }));
jest.mock('../src/lib/usage', () => ({ accrueUsage: jest.fn(async () => ({ cost: 0, error: null })) }));
jest.mock('../src/lib/pii-map', () => ({ persistPiiMap: jest.fn(async () => {}) }));

const { finalizeScreening } = require('../src/services/cle-finalize');

const ALL_FOUR = { c4: true, c5: true, c6: true, c7: true, input_tokens: 1, output_tokens: 1, pii_map: [] };
const run = (crit, cle = {}) => {
  mockCrit = { ...ALL_FOUR, ...crit };
  return finalizeScreening({
    cleId: 'c1', physicianId: 'p1', transcript: [{ role: 'physician', content: 'x' }],
    tier1: { c1: false, c2: false, c3: false }, // deliberately all false: they must not matter
    patient_ref: null, cle,
  });
};

beforeEach(() => { mockUpdates = []; mockRpc = []; });

describe('the gate is the four CREC082 §1 elements', () => {
  test('all four present → cle_pass, even with every effort measure failing', async () => {
    const out = await run({});
    expect(out.status).toBe('cle_pass');
    // The point of the change: c1-c3 are written, and they did not decide anything.
    expect(mockUpdates.at(-1)).toMatchObject({ c1_pass: false, c2_pass: false, c3_pass: false });
  });

  test.each(['c4', 'c5', 'c6', 'c7'])('missing %s → cle_flag_t2', async (missing) => {
    const out = await run({ [missing]: false });
    expect(out.status).toBe('cle_flag_t2');
  });

  test('c7 is persisted, so "was this session tested for evidence integration?" is answerable', async () => {
    await run({});
    expect(mockUpdates.at(-1)).toMatchObject({ c7_pass: true });
  });
});

describe('the consecutive-failure counter', () => {
  test('a qualifying session records a pass; a non-qualifying one records a fail', async () => {
    await run({});
    expect(mockRpc).toContainEqual(['record_t1_outcome', { p_id: 'p1', p_pass: true }]);
    mockRpc = [];
    await run({ c7: false });
    expect(mockRpc).toContainEqual(['record_t1_outcome', { p_id: 'p1', p_pass: false }]);
  });

  test('a Socratic session does not feed it — it is not part of the "natural fails" signal', async () => {
    await run({ c4: false }, { socratic_reason: 'protocol_rescue' });
    expect(mockRpc).toHaveLength(0);
  });

  test('a test session does not pollute the real counter', async () => {
    await run({ c4: false }, { is_test: true });
    expect(mockRpc).toHaveLength(0);
  });

  test('an RPC failure never blocks the finalize — it is bookkeeping', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = require('../src/lib/supabase');
    const orig = supabase.rpc;
    supabase.rpc = async () => ({ data: null, error: { message: 'boom' } });
    const out = await run({});
    expect(out.status).toBe('cle_pass');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/record_t1_outcome failed/), 'boom');
    supabase.rpc = orig; err.mockRestore();
  });
});
