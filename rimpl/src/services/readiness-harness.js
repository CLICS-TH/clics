'use strict';

// The real ctx for lib/readiness.js: this RIMPL's own routes on a loopback port, its two on-prem
// providers, and the stand-ins the controls need. Opened once per run by scripts/readiness.js.
//
// What it changes in this process, all restored by close():
//   * CLICS_LOCAL_ONLY=1 and per-purpose routing pinned to the on-prem pair (chat and discuss to the
//     tutor, evaluate and criteria to the evaluator). vm1 shares app_settings with Railway, where they
//     name Anthropic, so the database layer is switched off for routing: SUPABASE_URL is blanked once the
//     app has loaded (provider-settings reads it per call; lib/supabase.js has already built its client,
//     which the context row uses for its one read).
//   * ANTHROPIC_BASE_URL points at a loopback tripwire that counts requests and answers 500, so a path
//     that would reach the cloud is counted (the report's anthropic_requests) instead of sent.
//   * console output from the app goes nowhere (or to stderr with --verbose): its log lines name hosts.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const INDEX = path.join(__dirname, '..', 'index.js');
const ROUTING = {
  AI_PROVIDER_CHAT: 'local-tutor', AI_PROVIDER_DISCUSS: 'local-tutor',
  AI_PROVIDER_EVALUATE: 'local', AI_PROVIDER_CRITERIA: 'local',
};
// Blanked, not deleted: dotenv (src/index.js) would put a deleted key back from a .env file.
const BLANKED = ['AI_PROVIDER', 'CHAT_FAILOVER_PROVIDER', 'SHADOW_EVAL_PROVIDER', 'PROVIDER_SETTINGS_SOURCE'];
const ENDPOINT_ENV = ['LOCAL_AI_', 'LOCAL_TUTOR_AI_'];
const DOWN_TIMEOUT_MS = '10000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port, url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

const sendJson = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};
const drain = (req) => new Promise((r) => { req.on('data', () => {}); req.on('end', r); req.on('error', r); });

// POST to a loopback app. Resolves { status, body, ms } or { error: 'timeout'|'aborted'|'network', ms };
// never rejects. http.request, not fetch: undici's 300 s headers timeout would cut an evaluation the
// backend itself would still be waiting for (RIMPL_EVAL_TIMEOUT_MS is 480 s).
function poster(port, token) {
  return (p, body, { timeoutMs = 60000, signal } = {}) => new Promise((resolve) => {
    const t0 = Date.now();
    const data = Buffer.from(JSON.stringify(body));
    let settled = false;
    let req = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ms: Date.now() - t0, ...r });
    };
    const onAbort = () => { done({ error: 'aborted' }); req?.destroy(); };
    const timer = setTimeout(() => { done({ error: 'timeout' }); req?.destroy(); }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...(token ? { 'x-internal-token': token } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        done({ status: res.statusCode, body: parsed });
      });
      res.on('error', () => done({ error: 'network' }));
    });
    req.on('error', () => done({ error: 'network' }));
    req.end(data);
  });
}

// An error from a provider, as a word the report may carry. Never its message.
function errorReason(e) {
  if (!e) return 'error';
  if (e.code === 'empty_reply') return 'empty_reply';
  if (e.code === 'transcript_too_large' || e.contextTooSmall) return 'refused_too_large';
  if (e.code === 'queue_full') return 'queue_full';
  if (e.localTimeout === true || e.name === 'TimeoutError') return 'timeout';
  if (typeof e.status === 'number') return `http_${e.status}`;
  for (let c = e, i = 0; c && i < 4; c = c.cause, i++) {
    if (typeof c.code === 'string' && /^[A-Z_]{3,40}$/.test(c.code)) return c.code.toLowerCase();
  }
  return 'error';
}

// ready()'s down reasons are prose naming the model and sometimes the server; the report gets an enum.
function readyReason(check) {
  if (!check || check.status === 'up') return null;
  const m = String(check.error || '');
  if (/BASE_URL not set/.test(m)) return 'base_url_unset';
  if (/MODEL not set/.test(m)) return 'model_unset';
  if (/enumerated no models/.test(m)) return 'no_models_listed';
  if (/not served/.test(m)) return 'model_not_served';
  if (/below the required minimum/.test(m)) return 'context_below_minimum';
  return 'unreachable';
}

const modelId = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:+\-/]{0,79}$/.test(v) ? v : null);

function instanceApi(provider) {
  return {
    configured: () => provider.configured(),
    async ready() {
      const r = await provider.ready();
      const check = Object.values(r.checks || {})[0] || {};
      return { status: check.status === 'up' ? 'up' : 'down', model: modelId(check.model), error: readyReason(check) };
    },
    async chatOnce(prompt) {
      const t0 = Date.now();
      try {
        const out = await provider.call({
          systemPrompt: 'You are a concise assistant.', messages: [{ role: 'user', content: prompt }],
          maxTokens: 1024, temperature: 0, ...(provider.supportsThinking() ? { thinking: false } : {}),
        });
        const ok = typeof out.text === 'string' && out.text.trim() !== '';
        return { ok, reason: ok ? 'ok' : 'empty_reply', ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, reason: errorReason(e), ms: Date.now() - t0 };
      }
    },
    // The window the server enforces for the pinned model: vLLM's /models max_model_len and nothing else.
    // Not servedContext(): Ollama's /api/show context_length is the trained maximum, not the served num_ctx.
    async window() {
      try {
        const m = await provider.servedModel();
        if (m.maxModelLen) return { tokens: m.maxModelLen, source: 'models_max_model_len' };
      } catch { /* unreadable or unlisted: unreported */ }
      return { tokens: null, source: null };
    },
    // The server's count of a prompt: one generated token, usage.prompt_tokens read back.
    async promptTokens({ systemPrompt, messages }) {
      try {
        const out = await provider.call({ systemPrompt, messages, maxTokens: 1, temperature: 0 });
        return { tokens: out.inputTokens };
      } catch (e) {
        if (e?.code === 'empty_reply' && e.inputTokens > 0) return { tokens: e.inputTokens };
        return { tokens: null, reason: errorReason(e) };
      }
    },
  };
}

// The longest transcript in the sandbox council, read only. Text stays in this process.
async function loadSandboxTranscript(sb) {
  if (!sb) return { ples: null, transcript: null, error: 'database_not_configured' };
  try {
    const { data: councils, error: e1 } = await sb.from('councils').select('id').eq('code', 'SANDBOX');
    if (e1) return { ples: null, transcript: null, error: 'database_unreadable' };
    if (!councils?.length) return { ples: 0, transcript: null, error: 'no_sandbox_council' };
    const { data: ples, error: e2 } = await sb.from('ples').select('id, chief_complaint').in('council_id', councils.map((c) => c.id));
    if (e2) return { ples: null, transcript: null, error: 'database_unreadable' };
    let best = null;
    for (const ple of ples || []) {
      const { data: msgs, error } = await sb.from('messages').select('role, content').eq('ple_id', ple.id).order('created_at', { ascending: true });
      if (error) return { ples: ples.length, transcript: null, error: 'database_unreadable' };
      const turns = (msgs || []).filter((m) => (m.role === 'physician' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
      const bytes = turns.reduce((n, t) => n + Buffer.byteLength(t.content, 'utf8'), 0);
      if (turns.length && (!best || bytes > best.bytes)) best = { bytes, turns: turns.map(({ role, content }) => ({ role, content })), chiefComplaint: ple.chief_complaint || null };
    }
    return { ples: (ples || []).length, transcript: best ? { turns: best.turns, chiefComplaint: best.chiefComplaint } : null };
  } catch {
    return { ples: null, transcript: null, error: 'database_unreadable' };
  }
}

// A stand-in model endpoint for one scenario: 'empty' answers 200 with no reply text, 'error' answers
// 500, 'refused' is a loopback port nobody listens on.
async function standIn(kind, model) {
  if (kind === 'refused') {
    const s = await listen(() => {});
    await s.close();
    return { url: `${s.url}/v1`, close: async () => {} };
  }
  const s = await listen(async (req, res) => {
    await drain(req);
    if (kind === 'error') return sendJson(res, 500, { error: { message: 'stand-in failure' } });
    if (req.url.endsWith('/models')) return sendJson(res, 200, { object: 'list', data: [{ id: model, object: 'model' }] });
    return sendJson(res, 200, { id: 'readiness-empty', model, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });
  });
  return { url: `${s.url}/v1`, close: s.close };
}

// The local-only row's child RIMPL reads its settings from this stand-in for PostgREST:
// 'chat-anthropic' routes chat to anthropic, 'unreadable' answers 503 to every read (a cold cache).
function settingsStore(mode) {
  return listen(async (req, res) => {
    await drain(req);
    if (!req.url.startsWith('/rest/v1/app_settings')) return sendJson(res, 404, { message: 'not found' });
    if (mode === 'unreadable') return sendJson(res, 503, { message: 'unavailable' });
    return sendJson(res, 200, [{ key: 'ai_provider_chat', value: null, value_text: 'anthropic' }]);
  });
}

function silenceConsole(verbose) {
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k];
    console[k] = verbose ? (...a) => process.stderr.write(`${a.map(String).join(' ')}\n`) : () => {};
  }
  return () => Object.assign(console, saved);
}

function restoreEnv(snapshot) {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  Object.assign(process.env, snapshot);
}

async function openHarness({ opts, verbose = false } = {}) {
  // The app's own dotenv call, made first so its values count among the secrets the report may not hold.
  // quiet: dotenv 17 otherwise prints a banner to stdout, which carries the report only.
  require('dotenv').config({ quiet: true });
  const originalEnv = { ...process.env };
  const sensitive = [];

  let anthropicRequests = 0;
  const tripwire = await listen(async (req, res) => {
    anthropicRequests += 1;
    await drain(req);
    sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: 'readiness tripwire' } });
  });

  Object.assign(process.env, ROUTING, { CLICS_LOCAL_ONLY: '1', ANTHROPIC_BASE_URL: tripwire.url, ANTHROPIC_API_KEY: 'readiness-tripwire' });
  for (const k of BLANKED) process.env[k] = '';
  // lib/supabase.js builds its client at load and throws without a URL; a box with no database still
  // runs every row but the context one.
  const hasDb = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!hasDb) Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'readiness-no-database' });

  const restoreConsole = silenceConsole(verbose);
  let app;
  let server;
  try {
    app = require(INDEX);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
  } catch (e) {
    restoreConsole();
    await tripwire.close();
    restoreEnv(originalEnv);
    throw e;
  }
  const sb = hasDb ? require('../lib/supabase').supabase : null;
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  const runEnv = { ...process.env };

  const ai = require('./ai');
  const providers = { local: require('./providers/local'), 'local-tutor': require('./providers/local-tutor') };
  const post = poster(server.address().port, process.env.INTERNAL_TOKEN);
  const children = new Set();

  async function withEndpoint(kind, fn) {
    const stands = [];
    const saved = {};
    try {
      for (const [name, prefix] of [['local', ENDPOINT_ENV[0]], ['local-tutor', ENDPOINT_ENV[1]]]) {
        const s = await standIn(kind, providers[name].model());
        stands.push(s);
        for (const k of [`${prefix}BASE_URL`, `${prefix}TIMEOUT_MS`, `${prefix}HTTP_PROXY`]) saved[k] = process.env[k];
        process.env[`${prefix}BASE_URL`] = s.url;
        process.env[`${prefix}TIMEOUT_MS`] = DOWN_TIMEOUT_MS;
        process.env[`${prefix}HTTP_PROXY`] = '';
      }
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const s of stands) await s.close();
    }
  }

  // A second RIMPL, in a child process, with local-only on and its settings read from a stand-in
  // store. A child because a cold cache cannot be staged here: this process's settings layer is off.
  async function childApp(mode, fn) {
    const store = await settingsStore(mode);
    const env = { ...runEnv, CLICS_LOCAL_ONLY: '1', SUPABASE_URL: store.url, SUPABASE_SERVICE_ROLE_KEY: 'readiness-settings-store' };
    if (mode === 'unreadable') env.AI_PROVIDER = 'local';
    const code = `const app = require(${JSON.stringify(INDEX)});
const s = app.listen(0, '127.0.0.1', () => process.send({ port: s.address().port }));
process.on('disconnect', () => process.exit(0));`;
    const child = spawn(process.execPath, ['-e', code], {
      env, cwd: path.dirname(INDEX), stdio: ['ignore', verbose ? 'inherit' : 'ignore', verbose ? 'inherit' : 'ignore', 'ipc'],
    });
    children.add(child);
    try {
      const port = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(Object.assign(new Error('child did not start'), { code: 'child_start_timeout' })), 30000);
        child.once('message', (m) => { clearTimeout(t); resolve(m.port); });
        child.once('exit', () => { clearTimeout(t); reject(Object.assign(new Error('child exited'), { code: 'child_exited' })); });
      });
      return await fn({ post: poster(port, env.INTERNAL_TOKEN) });
    } finally {
      child.kill();
      children.delete(child);
      await store.close();
    }
  }

  const ctx = {
    opts,
    post,
    instances: { local: instanceApi(providers.local), 'local-tutor': instanceApi(providers['local-tutor']) },
    supportsThinking: (name) => ai.supportsThinking(name),
    withEndpoint,
    childApp,
    sandboxTranscript: () => loadSandboxTranscript(sb),
    sensitive: (value) => { if (typeof value === 'string' && value.trim()) sensitive.push(value.trim()); },
    anthropicRequests: () => anthropicRequests,
    sleep,
    now: () => Date.now(),
  };

  return {
    ctx,
    originalEnv,
    registered: () => [...sensitive],
    async close() {
      for (const c of children) c.kill();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      await tripwire.close();
      restoreConsole();
      restoreEnv(originalEnv);
    },
  };
}

module.exports = { openHarness, loadSandboxTranscript, errorReason, readyReason, poster, listen };
