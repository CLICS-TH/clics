// The patient identifier (cle_patient_refs.patient_ref) must reach RIMPL on both eval paths so RIMPL
// can scrub it from the transcript on-prem before the cloud call. This pins the threading through
// finalizeScreening → criteria classifier (C4/C5/C6) AND → the PIS-7 evaluation.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    // record_t1_outcome: cle-finalize.js records the consecutive-failure outcome via RPC.
    rpc: async () => ({ data: null, error: null }),
  },
}));
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluateCriteria: jest.fn(async () => ({ c4: true, c5: true, c6: true, c7: true, input_tokens: 1, output_tokens: 1 })),
  isDeterministicRimplError: () => false,
}));
jest.mock('../src/lib/usage', () => ({ accrueUsage: jest.fn(async () => {}) }));
jest.mock('../src/services/cle-evaluation', () => ({ triggerEvaluation: jest.fn(() => Promise.resolve()) }));

const { finalizeScreening } = require('../src/services/cle-finalize');
const { rimplEvaluateCriteria } = require('../src/services/rimpl-client');
const { triggerEvaluation } = require('../src/services/cle-evaluation');

test('finalizeScreening threads patient_ref to the criteria classifier AND the PIS-7 eval', async () => {
  const transcript = [{ role: 'physician', content: 'สมชายปวดท้อง' }];
  await finalizeScreening({
    cleId: 'c1', physicianId: 'p1', transcript,
    tier1: { c1: true, c2: true, c3: true }, patient_ref: 'นายสมชาย ใจดี',
  });
  expect(rimplEvaluateCriteria).toHaveBeenCalledWith({ transcript, patient_ref: 'นายสมชาย ใจดี' });
  expect(triggerEvaluation).toHaveBeenCalledWith('c1', transcript, 'p1', 'นายสมชาย ใจดี');
});
