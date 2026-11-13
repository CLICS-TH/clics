// The readiness harness in this process (src/services/readiness-harness.js, #431): the real routes on a
// loopback port against loopback model servers, a read-only sandbox store, and the down scenario's
// refusing and 5xx stand-ins. The local-only row's child process runs in readiness-cli.test.js.
const { startFakeOpenAI } = require('./helpers/fake-openai');
const { startFakePostgrest, sandboxTables } = require('./helpers/fake-postgrest');
const R = require('../src/lib/readiness');
const { openHarness, loadSandboxTranscript, errorReason, readyReason } = require('../src/services/readiness-harness');

jest.setTimeout(120000);

const TOKEN = 'harness-internal-token-1';
let evaluator;
let tutor;
let db;
let savedEnv;

beforeAll(async () => {
  savedEnv = { ...process.env };
  evaluator = await startFakeOpenAI({ model: 'fake-evaluator' });
  tutor = await startFakeOpenAI({ model: 'fake-tutor' });
  db = await startFakePostgrest(sandboxTables());
  Object.assign(process.env, {
    LOCAL_AI_BASE_URL: evaluator.url, LOCAL_AI_MODEL: 'fake-evaluator',
    LOCAL_TUTOR_AI_BASE_URL: tutor.url, LOCAL_TUTOR_AI_MODEL: 'fake-tutor', LOCAL_TUTOR_AI_THINKING_STYLE: 'chat_template_kwargs',
    // Ten concurrent sessions need room in the tutor's interactive lane; the default 4 loses turns.
    LOCAL_TUTOR_MAX_QUEUE_INTERACTIVE: '16',
    LOCAL_RETRY_BASE_MS: '5', LOCAL_TUTOR_RETRY_BASE_MS: '5',
    INTERNAL_TOKEN: TOKEN, SUPABASE_URL: db.url, SUPABASE_SERVICE_ROLE_KEY: 'harness-service-role-key',
    AI_PROVIDER: 'anthropic', CLICS_LOCAL_ONLY: '',
  });
});

afterAll(async () => {
  await evaluator.close();
  await tutor.close();
  await db.close();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

test('every in-process row passes against healthy loopback models, and the run leaves no trace', async () => {
  const before = { ...process.env };
  const harness = await openHarness({ opts: R.resolveOptions({}) });
  let report;
  try {
    report = await R.runReadiness(harness.ctx, { only: ['reachability', 'inference-shape', 'context', 'failure-down', 'latency', 'concurrency', 'decisive-icc'] });
  } finally {
    await harness.close();
  }

  const failed = report.rows.filter((r) => r.status === 'fail');
  expect(failed.map((r) => [r.id, r.evidence])).toEqual([]);
  expect(report.verdict).toBe('GO');
  expect(report.anthropic_requests).toBe(0);
  expect(report.rows.find((r) => r.id === 'reachability').evidence.local).toMatchObject({ models_status: 'up', model: 'fake-evaluator', chat_ok: true });
  expect(report.rows.find((r) => r.id === 'context').evidence.local.window_source).toBe('models_max_model_len');
  expect(report.rows.find((r) => r.id === 'failure-down').evidence).toMatchObject({
    refused: { chat_code: 'ai_unavailable', evaluate_requeued: true },
    error: { chat_code: 'ai_unavailable', evaluate_requeued: true },
  });

  // Nothing written, routing and the endpoints restored, and the report clean.
  expect(db.state.writes).toBe(0);
  expect(process.env).toEqual(before);
  const sensitive = [...R.sensitiveFromEnv(harness.originalEnv), ...R.fixtureLiterals(), ...harness.registered().flatMap(R.textLiteral)];
  expect(harness.registered()).toContain('Fictional question one about chest pain triage in this test case.');
  const text = R.formatText(report);
  expect(R.findUnsafe(`${text}${JSON.stringify(report)}`, sensitive)).toBeNull();
  expect(text).not.toContain(TOKEN);
});

test('the deep chat probe asks for thinking and the tutor reports it on', async () => {
  const harness = await openHarness({ opts: R.resolveOptions({}) });
  try {
    const row = await R.CHECKS.find((c) => c.id === 'inference-shape').run.call({ id: 'inference-shape', title: '' }, harness.ctx);
    expect(row.evidence['chat-deep']).toMatchObject({ thinking_supported: true, thinking: true, thinking_style: 'chat_template_kwargs' });
    expect(row.evidence.control).toMatchObject({ forced_empty_reply_status: 503, classified_as: 'empty_reply', behaved: true });
  } finally {
    await harness.close();
  }
});

test('reachability fails, by enum, when the evaluator does not serve its pinned model', async () => {
  process.env.LOCAL_AI_MODEL = 'some-other-model';
  const harness = await openHarness({ opts: R.resolveOptions({}) });
  try {
    const report = await R.runReadiness(harness.ctx, { only: ['reachability'] });
    expect(report.rows[0].evidence.local).toMatchObject({ models_status: 'down', models_error: 'model_not_served', chat_reason: 'not_reached' });
    expect(report.verdict).toBe('NO-GO');
  } finally {
    await harness.close();
    process.env.LOCAL_AI_MODEL = 'fake-evaluator';
  }
});

test('the sandbox loader reads the longest transcript of the SANDBOX council only, and writes nothing', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(db.url, 'harness-service-role-key');
  const got = await loadSandboxTranscript(sb);
  expect(got.ples).toBe(2);
  expect(got.transcript.turns.map((t) => t.role)).toEqual(['physician', 'assistant', 'physician']);
  expect(got.transcript.chiefComplaint).toBe('fictional chest pain case for testing');
  expect(await loadSandboxTranscript(null)).toMatchObject({ transcript: null, error: 'database_not_configured' });
  expect(db.state.writes).toBe(0);
});

test('provider errors and ready() prose become enums', () => {
  expect(errorReason(Object.assign(new Error('x'), { code: 'empty_reply' }))).toBe('empty_reply');
  expect(errorReason(Object.assign(new Error('x'), { status: 503 }))).toBe('http_503');
  expect(errorReason(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).toBe('econnrefused');
  expect(errorReason(Object.assign(new Error('x'), { localTimeout: true }))).toBe('timeout');
  expect(readyReason({ status: 'down', error: 'LOCAL_AI_BASE_URL not set' })).toBe('base_url_unset');
  expect(readyReason({ status: 'down', error: 'fetch failed http://10.0.0.1' })).toBe('unreachable');
  expect(readyReason({ status: 'up' })).toBeNull();
});
