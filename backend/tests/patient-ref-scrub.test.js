// The patient identifier (ple_patient_refs.patient_ref) must reach RIMPL on both eval paths so RIMPL
// can scrub it from the transcript on-prem before the cloud call. This pins the threading through
// finalizeScreening → criteria classifier (C4–C7); the PIS-7 half is pinned in eval-drain.test.js.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    // record_t1_outcome: ple-finalize.js records the consecutive-failure outcome via RPC.
    rpc: async () => ({ data: null, error: null }),
  },
}));
jest.mock('../src/services/rimpl-client', () => ({
  rimplEvaluateCriteria: jest.fn(async () => ({ c4: true, c5: true, c6: true, c7: true, input_tokens: 1, output_tokens: 1 })),
  isDeterministicRimplError: () => false,
}));
jest.mock('../src/lib/usage', () => ({ accrueUsage: jest.fn(async () => {}) }));
jest.mock('../src/services/ple-evaluation', () => ({ triggerEvaluation: jest.fn(() => Promise.resolve()) }));
// Since the evaluation drain, finalizeScreening ENQUEUES the PIS-7 evaluation instead of calling it;
// the drain reads patient_ref by ple_id itself (tests/eval-drain.test.js pins that half).
jest.mock('../src/services/eval-drain', () => ({ kick: jest.fn() }));

const { finalizeScreening } = require('../src/services/ple-finalize');
const { rimplEvaluateCriteria } = require('../src/services/rimpl-client');
const { triggerEvaluation } = require('../src/services/ple-evaluation');
const evalDrain = require('../src/services/eval-drain');

test('finalizeScreening threads patient_ref to the criteria classifier AND the PIS-7 eval', async () => {
  const transcript = [{ role: 'physician', content: 'สมชายปวดท้อง' }];
  await finalizeScreening({
    pleId: 'c1', physicianId: 'p1', transcript,
    tier1: { c1: true, c2: true, c3: true }, patient_ref: 'นายสมชาย ใจดี',
  });
  expect(rimplEvaluateCriteria).toHaveBeenCalledWith({ transcript, patient_ref: 'นายสมชาย ใจดี', chief_complaint: null });
  // The PIS-7 half no longer runs inline: the session is enqueued and the drain is woken. The drain
  // threads patient_ref from ple_patient_refs (eval-drain.test.js), so nothing here can drop it.
  expect(triggerEvaluation).not.toHaveBeenCalled();
  expect(evalDrain.kick).toHaveBeenCalledTimes(1);
});

test('finalizeScreening threads the chief complaint to the classifier (numbering seed; falls back to the ple row)', async () => {
  rimplEvaluateCriteria.mockClear();
  const transcript = [{ role: 'physician', content: 'ปวดท้อง' }];
  await finalizeScreening({ pleId: 'c1', physicianId: 'p1', transcript, tier1: { c1: true, c2: true, c3: true },
    patient_ref: null, chief_complaint: 'ปวดท้อง 2 วัน' });
  expect(rimplEvaluateCriteria).toHaveBeenLastCalledWith({ transcript, patient_ref: null, chief_complaint: 'ปวดท้อง 2 วัน' });
  await finalizeScreening({ pleId: 'c1', physicianId: 'p1', transcript, tier1: { c1: true, c2: true, c3: true },
    patient_ref: null, ple: { chief_complaint: 'จากแถว ples' } });
  expect(rimplEvaluateCriteria).toHaveBeenLastCalledWith({ transcript, patient_ref: null, chief_complaint: 'จากแถว ples' });
});
