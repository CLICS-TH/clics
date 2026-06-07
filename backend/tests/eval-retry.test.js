// triggerEvaluation must retry a transient RIMPL failure instead of silently stranding a passed PLE.
// (jest requires factory-referenced vars to be `mock`-prefixed.)
let mockUpdates = [];
let mockInsertErr = {}; // { tableName: 'message' } to simulate an insert failure

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      insert: () => Promise.resolve({ error: mockInsertErr[table] ? { message: mockInsertErr[table] } : null }),
      update: (patch) => ({ eq: () => { mockUpdates.push({ table, patch }); return Promise.resolve({ error: null }); } }),
    }),
  },
}));

let mockAttempts = 0;
let mockFailFirst = 0; // how many leading calls should throw
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluate: jest.fn(() => {
    mockAttempts++;
    if (mockAttempts <= mockFailFirst) return Promise.reject(new Error('RIMPL 500 transient'));
    return Promise.resolve({ d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {}, model_version: 'test' });
  }),
}));

const { triggerEvaluation, persistEvaluation } = require('../src/services/ple-evaluation');

beforeEach(() => { mockAttempts = 0; mockFailFirst = 0; mockUpdates = []; mockInsertErr = {}; });

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
  await expect(triggerEvaluation('ple3', [], 'doc1')).rejects.toThrow(/RIMPL 500/);
  expect(mockAttempts).toBe(3); // 3 attempts, no more
});

test('persistEvaluation throws and does NOT flip status when the score insert fails', async () => {
  mockInsertErr = { ai_evaluations: 'domain score out of range' };
  const result = { d1: 4, d2: 4, d3: 3, d4: 4, d5: 3, d6: 3, d7: 4, domain_rationale: {}, model_version: 'test' };
  await expect(persistEvaluation('ple4', 'doc1', result)).rejects.toThrow(/ai_evaluations insert failed/);
  // no partial state: the PLE must not have been marked evaluated
  expect(mockUpdates.some(u => u.table === 'ples' && u.patch.status === 'evaluated')).toBe(false);
});
