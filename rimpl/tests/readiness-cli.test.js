// `npm run readiness` end to end (scripts/readiness.js, #431): the real CLI in a child process against
// loopback model servers and a read-only sandbox store, at the ticket's sample sizes. Proves the exit
// codes, the printed and written report, the local-only row's child RIMPL, and the withheld report.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeOpenAI } = require('./helpers/fake-openai');
const { startFakePostgrest, sandboxTables } = require('./helpers/fake-postgrest');

jest.setTimeout(180000);

const CLI = path.join(__dirname, '..', 'scripts', 'readiness.js');
const TOKEN = 'cli-internal-token-12345';
let evaluator;
let tutor;
let db;
let emptyDb;

beforeAll(async () => {
  evaluator = await startFakeOpenAI({ model: 'fake-evaluator' });
  tutor = await startFakeOpenAI({ model: 'fake-tutor' });
  db = await startFakePostgrest(sandboxTables());
  emptyDb = await startFakePostgrest({});
});

afterAll(async () => {
  for (const s of [evaluator, tutor, db, emptyDb]) await s.close();
});

function runCli(args, env = {}) {
  const base = {
    PATH: process.env.PATH,
    LOCAL_AI_BASE_URL: evaluator.url, LOCAL_AI_MODEL: 'fake-evaluator', LOCAL_AI_API_KEY: 'sk-evaluator-key-0001',
    LOCAL_TUTOR_AI_BASE_URL: tutor.url, LOCAL_TUTOR_AI_MODEL: 'fake-tutor', LOCAL_TUTOR_AI_THINKING_STYLE: 'chat_template_kwargs',
    LOCAL_TUTOR_MAX_QUEUE_INTERACTIVE: '16', LOCAL_RETRY_BASE_MS: '5', LOCAL_TUTOR_RETRY_BASE_MS: '5',
    INTERNAL_TOKEN: TOKEN, SUPABASE_URL: db.url, SUPABASE_SERVICE_ROLE_KEY: 'cli-service-role-key-01',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, ...env }, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a full run against healthy models exits 0 with every measured row passing and a clean report', async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-')), 'report.json');
  const writesBefore = db.state.writes;
  const { code, stdout, stderr } = await runCli(['--out', out]);
  expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('verdict: GO');
  expect(stdout.match(/^\[PASS\]/gm)).toHaveLength(7);
  expect(stdout.match(/^\[OWNER-GATED\]/gm)).toHaveLength(2);
  expect(stdout).toContain('anthropic_requests: 0');
  for (const leak of ['127.0.0.1', TOKEN, 'sk-evaluator-key-0001', 'cli-service-role-key-01', 'chest pain triage']) expect(stdout).not.toContain(leak);

  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(written).toMatchObject({ schema: 'clics-readiness/1', verdict: 'GO', anthropic_requests: 0 });
  expect(written.rows.find((r) => r.id === 'local-only').evidence).toMatchObject({
    routed_to_anthropic: { code: 'local_only_refused', anthropic_requests: 0 },
    cold_settings_cache: { code: 'local_only_refused', anthropic_requests: 0 },
  });
  expect(db.state.writes).toBe(writesBefore);
});

test('a passing --only selection is PARTIAL, never GO: exit 4, rows not run listed in text and JSON', async () => {
  const notRun = 'inference-shape, context, failure-down, local-only, latency, concurrency, decisive-icc, clinician-thai-read';
  const text = await runCli(['--only', 'reachability']);
  expect(text.code).toBe(4);
  expect(text.stdout).toContain('verdict: PARTIAL');
  expect(text.stdout).toContain(`rows_not_run: ${notRun}`);
  expect(text.stdout).not.toContain('verdict: GO');

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-')), 'partial.json');
  const json = await runCli(['--only', 'reachability', '--json', '--out', out]);
  expect(json.code).toBe(4);
  for (const report of [JSON.parse(json.stdout), JSON.parse(fs.readFileSync(out, 'utf8'))]) {
    expect(report).toMatchObject({ verdict: 'PARTIAL', failed: [], rows_not_run: notRun.split(', ') });
  }
});

test('with the default tutor queue, ten sessions lose turns to queue_full and the run exits 1', async () => {
  const { code, stdout } = await runCli(['--only', 'concurrency', '--json'], { LOCAL_TUTOR_MAX_QUEUE_INTERACTIVE: '' });
  expect(code).toBe(1);
  const row = JSON.parse(stdout).rows[0];
  expect(row).toMatchObject({ status: 'fail', evidence: { reason: 'turns_lost', control: { behaved: true } } });
  expect(row.evidence.lost_reasons.queue_full).toBeGreaterThan(0);
});

test('an empty sandbox is a fail, never a pass: exit 1', async () => {
  const { code, stdout } = await runCli(['--only', 'context'], { SUPABASE_URL: emptyDb.url });
  expect(code).toBe(1);
  expect(stdout).toContain('[FAIL] context');
  expect(stdout).toContain('reason=no_sandbox_council');
});

test('a report that would print a secret is withheld: exit 3 and one line', async () => {
  // The model id is also the API key, so the reachability row would print the key.
  const { code, stdout } = await runCli(['--only', 'reachability'], { LOCAL_AI_API_KEY: 'fake-evaluator' });
  expect(code).toBe(3);
  expect(stdout).toBe('report withheld: contained secret\n');
});

test('bad usage exits 2 without starting anything', async () => {
  expect((await runCli(['--only', 'nope'])).code).toBe(2);
  expect((await runCli(['--chat-samples', 'many'])).code).toBe(2);
  expect((await runCli(['--frobnicate'])).code).toBe(2);
  const help = await runCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--deadline-ms');
});
