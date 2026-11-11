// lib/manifest.js — the model manifest's content and its content address (CCME R2). The CI `manifest` job
// runs scripts/manifest/build.mjs --check on a bare checkout; this suite pins the same properties from the
// rimpl side, where a regression would otherwise surface only as a confusing health warning.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M = require('../src/lib/manifest');
const P = require('../src/lib/prompts');
const V = require('../src/lib/versions');

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

describe('canonicalJson', () => {
  test('keys sorted recursively, arrays kept in order, two-space indent, LF, one trailing newline', () => {
    const a = M.canonicalJson({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: null } });
    expect(a).toBe('{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      1,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
    expect(a).not.toMatch(/\r/);
    expect(M.canonicalJson({ a: { c: null, d: [3, 1, { y: 2, z: 1 }] }, b: 1 })).toBe(a);   // property order is irrelevant
  });

  test.each([
    ['undefined', { a: undefined }, /\$\.a: a undefined is not JSON/],
    ['NaN', { a: { b: NaN } }, /\$\.a\.b: NaN is not a finite number/],
    ['Infinity', [1, Infinity], /\$\[1\]: Infinity/],
    ['a function', { f: () => 1 }, /\$\.f: a function is not JSON/],
  ])('strict: %s is a TypeError naming its path, never a silent null', (_l, v, re) => {
    expect(() => M.canonicalJson(v)).toThrow(re);
  });
});

describe('the content address', () => {
  test('sha256 is over the manifest WITHOUT its sha256 field, and any content change moves it', () => {
    const body = { schema: 's', expected: { code: { x: 1 }, declared: {} } };
    const h = M.manifestSha256(body);
    expect(h).toBe(sha(M.canonicalJson(body)));
    expect(M.manifestSha256({ ...body, sha256: 'anything' })).toBe(h);
    expect(M.manifestSha256({ ...body, expected: { code: { x: 2 }, declared: {} } })).not.toBe(h);
  });

  test('the committed file is canonical, verifies, and is what the code + declared input generate', () => {
    const text = fs.readFileSync(M.MANIFEST_FILE, 'utf8');
    const built = M.buildManifest(M.readDeclared());
    expect(text).toBe(M.canonicalJson(built));
    expect(M.readManifest()).toMatchObject({ file: 'present', sha256: built.sha256, error: null });
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('it ships: the file is under rimpl/src, the only tree the Dockerfile copies', () => {
    const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    expect(docker).toMatch(/COPY src \.\/src/);
    expect(path.relative(path.join(__dirname, '..', 'src'), M.MANIFEST_FILE)).toBe('model-manifest.json');
  });

  test('readManifest: missing, not JSON, and a hand edit that left the sha256 behind are all reported, never thrown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    try {
      expect(M.readManifest(path.join(dir, 'nope.json'))).toMatchObject({ file: 'missing', sha256: null, claimed_sha256: null });
      fs.writeFileSync(path.join(dir, 'bad.json'), '{"sha256": "http://box.internal:8000/');
      const bad = M.readManifest(path.join(dir, 'bad.json'));
      expect(bad).toMatchObject({ file: 'invalid', sha256: null, claimed_sha256: null, error: 'not JSON' });   // no parser message: it quotes the text
      const m = JSON.parse(fs.readFileSync(M.MANIFEST_FILE, 'utf8'));
      const stored = m.sha256;
      m.expected.code.decoding.evaluate.temperature = 0.7;           // the edit a lock must catch
      fs.writeFileSync(path.join(dir, 'edited.json'), M.canonicalJson(m));
      // The hash the file carries is NOT vouched for: sha256 is null, and the claim is reported apart.
      expect(M.readManifest(path.join(dir, 'edited.json'))).toMatchObject({
        file: 'invalid', sha256: null, claimed_sha256: stored, error: expect.stringMatching(/sha256/) });
      m.sha256 = 'not a hash, maybe an address 10.0.0.1';           // a claim that is not hex is not repeated
      fs.writeFileSync(path.join(dir, 'odd.json'), M.canonicalJson(m));
      expect(M.readManifest(path.join(dir, 'odd.json'))).toMatchObject({ file: 'invalid', sha256: null, claimed_sha256: null });
      expect(M.readManifest()).toMatchObject({ file: 'present', sha256: stored, claimed_sha256: stored });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('expected.code is computed from the code, not from the environment', () => {
  test('the same with every override set as with none', () => {
    const OVERRIDES = { RIMPL_CHAT_MAX_TOKENS: '6000', RIMPL_CHAT_DEEP_MAX_TOKENS: '16000', RIMPL_DISCUSS_MAX_TOKENS: '2000',
      SHADOW_EVAL_MAX_TOKENS: '8000', EVAL_CONSISTENCY: 'median3', EVAL_JSON_RETRIES: '5', EVAL_CONSISTENCY_MAX_SUM_DELTA: '3',
      SHADOW_EVAL_CONSISTENCY: 'adaptive', LOCAL_AI_NUM_CTX: '32768', LOCAL_AI_THINKING_STYLE: 'ollama', AI_PROVIDER: 'local' };
    const saved = Object.fromEntries(Object.keys(OVERRIDES).map((k) => [k, process.env[k]]));
    let withEnv;
    try {
      Object.assign(process.env, OVERRIDES);
      jest.isolateModules(() => { withEnv = require('../src/lib/manifest').expectedCode(); });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect(M.canonicalJson(withEnv)).toBe(M.canonicalJson(M.expectedCode()));
  });

  test('the evaluator prompt_version per provider is lib/versions.js\'s, and the suffix hashes the addendum ALONE', () => {
    const e = M.expectedCode().evaluator;
    expect(e.prompt_version).toEqual({ anthropic: V.PROMPT_VERSION, local: V.promptVersionFor('local') });
    expect(e.prompt_version.local).toBe(`${V.PROMPT_VERSION}+local-${sha(P.PIS7_LOCAL_ADDENDUM).slice(0, 12)}`);
    // The separator pis7PromptFor inserts is NOT in the suffix — which is why the full prompt's sha is recorded.
    expect(e.prompt_version.local).not.toContain(sha(`\n\n${P.PIS7_LOCAL_ADDENDUM}`).slice(0, 12));
    expect(e.prompt_sha256.local).toBe(sha(P.pis7PromptFor('local')));
    expect(e).not.toHaveProperty(['prompt_version', 'local-tutor']);   // the tutor may not evaluate (CCME R3)
    expect(e.rubric_version).toBe(V.RUBRIC_VERSION);
  });

  test('labels: discuss is the one audit-discuss stamps; criteria is defined here', () => {
    const p = M.expectedCode().prompts;
    expect(p.discuss.label).toBe(V.promptLabel('discuss', P.RIMPL_SYSTEM_PROMPT_AUDIT_DISCUSS));
    expect(p.criteria.label).toBe(V.promptLabel('criteria', P.CRITERIA_CLASSIFIER_PROMPT));
    expect(p.criteria.label).toMatch(/^criteria-prompt-[0-9a-f]{8}$/);
  });
});

describe('validateDeclared', () => {
  const ok = () => M.readDeclared();
  test('the committed declared input passes', () => { expect(() => M.validateDeclared(ok())).not.toThrow(); });
  test.each([
    ['a URL', (d) => { d.local.source = 'measured at http://box/v1'; }, /declared\.local\.source: looks like an address/],
    ['an IP', (d) => { d.notes.push('the box is 100.64.12.34'); }, /declared\.notes\[3\]: looks like an address/],
    ['a host:port', (d) => { d.target = 'cme-dgx.example.org:8888'; }, /looks like an address/],
    ['a key', (d) => { d.local.source = 'key sk-abcdef123456'; }, /looks like an address or a key/],
    ['the tutor as the evaluator', (d) => { d.providers.evaluate = 'local-tutor'; }, /may not serve evaluate/],
    ['an unknown provider', (d) => { d.providers.chat = 'openai'; }, /is not a provider/],
    ['an unknown key', (d) => { d.extra = 1; }, /unknown key "extra"/],
  ])('refuses %s', (_l, mutate, re) => {
    const d = ok();
    mutate(d);
    expect(() => M.validateDeclared(d)).toThrow(re);
  });
});

describe('driftOf (pure)', () => {
  const manifest = () => JSON.parse(fs.readFileSync(M.MANIFEST_FILE, 'utf8'));
  const liveAsDeclared = () => ({
    providers: { chat: 'local-tutor', evaluate: 'local', criteria: 'local', discuss: 'local-tutor' },
    models: { anthropic: 'claude-sonnet-4-6', local: 'DeepSeek-V4.1-Flash-1017', 'local-tutor': 'qwen3.8-flash-next' },
    last_seen: { local: null, 'local-tutor': null },
    decoding: {
      evaluate: { temperature: 0, max_tokens: 4096 }, shadow: { temperature: 0, max_tokens: 4096 },
      criteria: { temperature: null, max_tokens: 200 }, discuss: { temperature: null, max_tokens: 1200 },
      chat: { temperature: null, fast_max_tokens: 4000, deep_max_tokens: 8000, evidence_line_max_tokens: 128 },
      num_ctx: { local: null, 'local-tutor': null },
    },
    consistency: { evaluate_mode: 'off', max_sum_delta: 0, json_retries: 2, shadow_mode: 'off' },
    thinking_style: { local: 'none', 'local-tutor': 'none' },
  });

  test('none when live is the declared target at the code defaults', () => {
    expect(M.driftOf(manifest(), liveAsDeclared())).toEqual([]);
  });

  test('a null declared value is not compared (no fingerprint is recorded yet, nor the tutor engine)', () => {
    const live = liveAsDeclared();
    live.last_seen.local = { model: 'DeepSeek-V4.1-Flash-1017', engine: 'vllm', runtime: 'vllm-anything' };
    live.last_seen['local-tutor'] = { model: 'qwen3.8-flash-next', engine: 'ollama', runtime: 'x' };
    expect(M.driftOf(manifest(), live)).toEqual([]);
  });

  test('an observed served model that differs from the declared one is drift, even when the configured id matches', () => {
    const live = liveAsDeclared();
    live.last_seen.local = { model: 'deepseek-v4-flash-other', engine: 'vllm', runtime: 'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0' };
    expect(M.driftOf(manifest(), live)).toEqual([{ key: 'declared.local.served_model', expected: 'DeepSeek-V4.1-Flash-1017', live: 'deepseek-v4-flash-other' }]);
  });

  test('once a fingerprint is declared, an observed different one is drift (the lock by model identity rests on it)', () => {
    const m = manifest();
    m.expected.declared.local.system_fingerprint = 'vllm-declared-fp';
    const live = liveAsDeclared();
    live.last_seen.local = { model: 'DeepSeek-V4.1-Flash-1017', engine: 'vllm', runtime: 'vllm-other-fp' };
    expect(M.driftOf(m, live)).toEqual([{ key: 'declared.local.system_fingerprint', expected: 'vllm-declared-fp', live: 'vllm-other-fp' }]);
    live.last_seen.local.runtime = 'vllm-declared-fp';
    expect(M.driftOf(m, live)).toEqual([]);
  });

  test('no manifest: no drift to compute (the health check reports the missing file instead)', () => {
    expect(M.driftOf(null, liveAsDeclared())).toEqual([]);
  });
});

describe('redaction', () => {
  test.each([
    'http://100.64.12.34:8888/v1', 'https://box.tailnet.ts.net', 'reach it at 192.168.10.20', 'cme-dgx.lan:18300',
    'Bearer abc.def', 'sk-ant-api03-xxxxxxxx', '[fd7a:115c::1]', 'localhost',
    // bare host:port, no dot
    'cme-dgx:8000', 'cme-dev:3000', '098215-u:443', 'localhost:3000',
    // compressed IPv6
    'fe80::1', '::1', 'fd7a:115c:a1e0::1', 'served from fe80::1%en0',
    // a bare domain with a path
    'ccme.or.th/api/v1', 'gateway at ccme.or.th:3000/api',
    // key / token assignments without an sk- prefix
    'api_key=abc123', 'API-KEY = 0f9e8d7c', 'token=xyz', 'x-internal-token=abc', 'key=deadbeef', 'secret=hunter2', 'password=pw',
  ])('%s is redacted', (s) => {
    expect(M.isUnsafeString(s)).toBe(true);
    expect(M.redactDeep({ v: [s] })).toEqual({ v: [M.REDACTED] });
  });

  test.each([
    'vllm-0.21.1rc1.dev339+g1967a5627bc3-tp2-48c629c0', 'deepseek-v4-flash-dspark', 'claude-sonnet-4-6',
    // model TAGS: digits then a letter after the colon are not a port
    'qwen3:32b', 'deepseek-r1:671b', 'llama3.1:8b', 'qwen2.5:72b-instruct-q4_K_M', 'nomic-embed-text:v1.5', 'mistral:7b',
    // whole ISO-8601 timestamps (live.observed_at, evaluator_locked_at)
    '2026-10-15T04:43:00.000Z', '2026-10-15T04:43:00+07:00', '2026-10-15 04:43:00+00',
    'pis7-prompt-59561c29+local-c5ffe572aa81', 'router-v1+e721153fb701', 'chat-prompt-d63340e1',
    'docs/ARCHITECTURE-MAPPING-CCME.md', 'scripts/quality/report/BASELINE-2026-10-02.md', 'std::string',
  ])('%s is kept (a version, tag, timestamp or repo path is not an address)', (s) => {
    expect(M.isUnsafeString(s)).toBe(false);
    expect(M.redactDeep(s)).toBe(s);
  });
});

describe('publicDrift: no free text on the unauthenticated endpoint', () => {
  const sha12 = (s) => sha(s).slice(0, 12);
  test('a model id or a fingerprint becomes live_present + live_sha256_12; null stays opaque-shaped', () => {
    expect(M.publicDrift([
      { key: 'declared.local.model', expected: 'deepseek-v4-flash-dspark', live: 'SENTINEL-MODEL' },
      { key: 'declared.local.system_fingerprint', expected: 'vllm-x', live: 'vllm-sentinel-fp' },
      { key: 'declared.local.served_model', expected: 'a', live: 'b' },
      { key: 'declared.local-tutor.model', expected: 'q', live: null },
      { key: 'code.models.anthropic', expected: 'claude-sonnet-4-6', live: 'claude-other' },
    ])).toEqual([
      { key: 'declared.local.model', expected: 'deepseek-v4-flash-dspark', live_present: true, live_sha256_12: sha12('SENTINEL-MODEL') },
      { key: 'declared.local.system_fingerprint', expected: 'vllm-x', live_present: true, live_sha256_12: sha12('vllm-sentinel-fp') },
      { key: 'declared.local.served_model', expected: 'a', live_present: true, live_sha256_12: sha12('b') },
      { key: 'declared.local-tutor.model', expected: 'q', live_present: false, live_sha256_12: null },
      { key: 'code.models.anthropic', expected: 'claude-sonnet-4-6', live_present: true, live_sha256_12: sha12('claude-other') },
    ]);
  });

  test('a fixed vocabulary, a number or null stays raw — and an off-vocabulary string does not', () => {
    expect(M.publicDrift([
      { key: 'declared.providers.evaluate', expected: 'local', live: 'anthropic' },
      { key: 'declared.providers.chat', expected: 'local-tutor', live: 'loclahost-typo' },
      { key: 'declared.local.engine', expected: 'vllm', live: 'sglang' },
      { key: 'code.consistency.evaluate_mode', expected: 'off', live: 'adaptive' },
      { key: 'code.thinking_style.local', expected: 'none', live: 'invalid' },
      { key: 'code.decoding.shadow.max_tokens', expected: 4096, live: 6000 },
      { key: 'code.decoding.num_ctx.local', expected: null, live: null },
      { key: 'code.some.future_key', expected: 'x', live: 'free text' },
    ])).toEqual([
      { key: 'declared.providers.evaluate', expected: 'local', live: 'anthropic' },
      { key: 'declared.providers.chat', expected: 'local-tutor', live_present: true, live_sha256_12: sha12('loclahost-typo') },
      { key: 'declared.local.engine', expected: 'vllm', live: 'sglang' },
      { key: 'code.consistency.evaluate_mode', expected: 'off', live: 'adaptive' },
      { key: 'code.thinking_style.local', expected: 'none', live: 'invalid' },
      { key: 'code.decoding.shadow.max_tokens', expected: 4096, live: 6000 },
      { key: 'code.decoding.num_ctx.local', expected: null, live: null },
      { key: 'code.some.future_key', expected: 'x', live_present: true, live_sha256_12: sha12('free text') },   // default-deny
    ]);
  });
});
