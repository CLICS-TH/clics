// Shadow evaluation — score twice, serve once, show nobody.
//
// The happy path is the least interesting thing here. What must hold, in priority order:
//   1. A shadow failure can NEVER affect the served evaluation (a physician's credit).
//   2. A shadow run can NEVER cost the physician anything.
//   3. A FAILED shadow run is still recorded — "the candidate model could not produce valid JSON
//      8% of the time" is the disqualifying measurement Gate 4 needs, and dropping those rows
//      would hide it behind a flattering average.
//   4. It is OFF unless explicitly switched on.
const mockCallProvider = jest.fn();
jest.mock('../src/services/ai', () => {
  const actual = jest.requireActual('../src/services/ai');
  return { ...actual, callProvider: (...a) => mockCallProvider(...a) };
});

const mockUpsert = jest.fn(async () => ({ error: null }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({ upsert: (...a) => mockUpsert(...a) }) },
}));

const { runShadowEvaluation, fireShadowEvaluation, shadowTarget } = require('../src/services/shadow');

const VALID = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7: 4, rationale: { d1: 'because' } };
const ok = (obj, extra = {}) => ({
  text: JSON.stringify(obj), inputTokens: 100, outputTokens: 50,
  stopReason: 'end_turn', model: 'deepseek-v4-flash', provider: 'local', ...extra,
});
const run = () => runShadowEvaluation({ pleId: 'ple-1', transcriptText: 'Physician: hi', servedProvider: 'anthropic' });
const row = () => mockUpsert.mock.calls[0][0];

let warnSpy;
beforeEach(() => {
  mockCallProvider.mockReset();
  mockUpsert.mockReset().mockResolvedValue({ error: null });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.SHADOW_EVAL_PROVIDER;
});
afterEach(() => jest.restoreAllMocks());

describe('when to shadow at all', () => {
  test('OFF by default — no call, no write', async () => {
    expect(await run()).toEqual({ skipped: true });
    expect(mockCallProvider).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('a typo\'d provider name warns and disables, rather than silently no-opping', async () => {
    process.env.SHADOW_EVAL_PROVIDER = 'loclahost';
    expect(shadowTarget('anthropic')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/not a known provider/));
  });

  test('never shadows the model that already served — same model twice proves nothing', async () => {
    process.env.SHADOW_EVAL_PROVIDER = 'anthropic';
    expect(await run()).toEqual({ skipped: true });
    expect(mockCallProvider).not.toHaveBeenCalled();
  });

  test('shadows when the candidate differs from the served provider', () => {
    process.env.SHADOW_EVAL_PROVIDER = 'local';
    expect(shadowTarget('anthropic')).toBe('local');
  });
});

describe('recording', () => {
  beforeEach(() => { process.env.SHADOW_EVAL_PROVIDER = 'local'; });

  test('a good run records scores, composite and full §10.2 provenance', async () => {
    mockCallProvider.mockResolvedValue(ok(VALID));
    const r = await run();
    expect(r).toMatchObject({ persisted: true, provider: 'local', failed: false });

    expect(mockCallProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local' }));
    const w = row();
    expect(w).toMatchObject({ ple_id: 'ple-1', provider: 'local', d1: 3, d5: 5, d7: 4 });
    // .45+.80+.45+.30+.75+.10+.40 = 3.25 -> x20 = 65
    expect(w.composite_score).toBeCloseTo(65, 6);
    expect(w.model_version).toBe('CCME_LLM_v8.0+deepseek-v4-flash');
    expect(w.prompt_version).toMatch(/^pis7-prompt-/);
    expect(w.rubric_version).toMatch(/^pis7-weights-/);
    expect(w.error).toBeNull();
    expect(typeof w.latency_ms).toBe('number');
  });

  test('the SAME prompt and rubric as the served evaluation (a fair comparison, not a different exam)', async () => {
    const { PIS7_EVALUATOR_PROMPT } = require('../src/lib/prompts');
    mockCallProvider.mockResolvedValue(ok(VALID));
    await run();
    expect(mockCallProvider.mock.calls[0][0].systemPrompt).toBe(PIS7_EVALUATOR_PROMPT);
  });

  test('re-uses the caller\'s already de-identified transcript — no new PII surface', async () => {
    mockCallProvider.mockResolvedValue(ok(VALID));
    await runShadowEvaluation({ pleId: 'c', transcriptText: 'Physician: [NAME-1] has fever', servedProvider: 'anthropic' });
    const sent = JSON.stringify(mockCallProvider.mock.calls[0][0].messages);
    expect(sent).toContain('[NAME-1]');
  });

  test('a model that returns UNPARSEABLE output is still recorded, with the failure', async () => {
    mockCallProvider.mockResolvedValue({ ...ok(VALID), text: 'I cannot score this.' });
    const r = await run();
    expect(r).toMatchObject({ persisted: true, failed: true });
    const w = row();
    expect(w.error).toMatch(/invalid_(json|scores)/);
    expect(w.d1).toBeNull();               // no scores...
    expect(w.stop_reason).toBe('end_turn'); // ...but the diagnosis survives
    expect(w.output_tokens).toBe(50);
  });

  test('a model that returns OUT-OF-RANGE scores is recorded as a failure, not silently clamped', async () => {
    mockCallProvider.mockResolvedValue(ok({ ...VALID, d2: 9 }));
    await run();
    expect(row().error).toMatch(/invalid_scores/);
    expect(row().composite_score).toBeNull();
  });

  test('a transport failure is recorded rather than lost', async () => {
    mockCallProvider.mockRejectedValue(new Error('local AI 503 Service Unavailable'));
    const r = await run();
    expect(r).toMatchObject({ persisted: true, failed: true });
    expect(row().error).toMatch(/call_failed: local AI 503/);
  });
});

// THE regression guard for the highest-severity finding of the 2026-08-24 review.
//
// postgrest-js's single-object upsert derives the INSERT column list from the payload's KEYS, so
// `ON CONFLICT DO UPDATE SET` covers only the keys present — any omitted column RETAINS its previous
// value. With a per-outcome key set, a re-run MERGES onto the earlier attempt: a later transport
// failure leaves the earlier valid scores in place beside an error (a harness counting non-null d1
// reads it as a success), and a later success leaves a stale error on a validly scored row (a
// harness filtering `error is null` drops it AND counts it a failure). Both directions launder the
// candidate's failure rate in the flattering direction, undetectably.
describe('every outcome writes the SAME column set (upsert must replace, never merge)', () => {
  beforeEach(() => { process.env.SHADOW_EVAL_PROVIDER = 'local'; });

  const keysFor = async (mock) => {
    mockUpsert.mockClear();
    mock();
    await run();
    return Object.keys(row()).sort();
  };

  test('success, parse failure and transport failure produce identical payload keys', async () => {
    const success = await keysFor(() => mockCallProvider.mockResolvedValue(ok(VALID)));
    const parseFail = await keysFor(() => mockCallProvider.mockResolvedValue({ ...ok(VALID), text: 'nope' }));
    const transportFail = await keysFor(() => mockCallProvider.mockRejectedValue(new Error('503')));

    expect(parseFail).toEqual(success);
    expect(transportFail).toEqual(success);
    // and the set is the full column list, not a coincidentally-matching subset
    // Sorted, so the order is alphabetical rather than meaningful. `cle_id` used to sit first
    // ('l' < 'o' in composite_score); after the CLE->PLE rename `ple_id` sorts between latency_ms
    // and prompt_version. The set is what this test is about, not the order.
    expect(success).toEqual([
      'composite_score', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7',
      'domain_rationale', 'error', 'evaluated_at', 'input_tokens', 'latency_ms',
      'model_version', 'output_tokens', 'ple_id', 'prompt_version', 'provider', 'rubric_version', 'stop_reason',
    ]);
  });

  test('evaluated_at is sent explicitly — `default now()` is not re-evaluated on DO UPDATE', async () => {
    mockCallProvider.mockResolvedValue(ok(VALID));
    await run();
    expect(Date.parse(row().evaluated_at)).not.toBeNaN();
  });

  test('a transport failure is still attributable — provenance stamped BEFORE the call', async () => {
    mockCallProvider.mockRejectedValue(new Error('local AI 404'));
    await run();
    // Without this, the rows Gate 4 leans on hardest would be the only unattributable ones.
    expect(row().model_version).toMatch(/^CCME_LLM_v8\.0\+/);
    expect(row().prompt_version).toMatch(/^pis7-prompt-/);
    expect(row().rubric_version).toMatch(/^pis7-weights-/);
  });

  test('the conflict target matches the table\'s unique(ple_id, provider, model_version)', async () => {
    mockCallProvider.mockResolvedValue(ok(VALID));
    await run();
    expect(mockUpsert.mock.calls[0][1]).toEqual({ onConflict: 'ple_id,provider,model_version' });
  });
});

describe('shedding — served traffic always wins the queue', () => {
  beforeEach(() => { process.env.SHADOW_EVAL_PROVIDER = 'local'; });

  test('sheds when anyone is already waiting for that provider', async () => {
    const local = require('../src/services/providers/local');
    jest.spyOn(local, 'stats').mockReturnValue({ provider: 'local', active: 24, queued: 3, maxConcurrency: 24 });
    const r = await run();
    expect(r).toMatchObject({ skipped: true, shed: true });
    expect(mockCallProvider).not.toHaveBeenCalled();  // never takes a slot ahead of a physician
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  test('runs when the provider is idle', async () => {
    const local = require('../src/services/providers/local');
    jest.spyOn(local, 'stats').mockReturnValue({ provider: 'local', active: 0, queued: 0, maxConcurrency: 24 });
    mockCallProvider.mockResolvedValue(ok(VALID));
    await expect(run()).resolves.toMatchObject({ persisted: true });
  });
});

describe('it can never hurt the served evaluation', () => {
  beforeEach(() => { process.env.SHADOW_EVAL_PROVIDER = 'local'; });

  test('a persist failure is swallowed, not thrown', async () => {
    mockCallProvider.mockResolvedValue(ok(VALID));
    mockUpsert.mockResolvedValue({ error: { message: 'permission denied' } });
    await expect(run()).resolves.toMatchObject({ persisted: false });
  });

  test('a persist THROW is swallowed too', async () => {
    mockCallProvider.mockResolvedValue(ok(VALID));
    mockUpsert.mockRejectedValue(new Error('connection reset'));
    await expect(run()).resolves.toMatchObject({ persisted: false });
  });

  test('fireShadowEvaluation never rejects, even when everything fails', async () => {
    mockCallProvider.mockRejectedValue(new Error('boom'));
    mockUpsert.mockRejectedValue(new Error('boom too'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    expect(() => fireShadowEvaluation({ pleId: 'c', transcriptText: 't', servedProvider: 'anthropic' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('it never meters usage — the whole point is that it is free', () => {
    const src = require('fs').readFileSync(require.resolve('../src/services/shadow'), 'utf8');
    expect(src).not.toMatch(/accrueUsage|reserveUsage|usage_cost/);
  });
});
