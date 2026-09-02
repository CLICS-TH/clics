#!/usr/bin/env node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { percentile, readConfig, REPO_ROOT, table, writeReport } from '../probe/lib.mjs';

const SCENARIOS = new Set(['single', 'burst', 'cap', 'down', 'capacity', 'all']);
const PURPOSES = ['chat', 'criteria', 'discuss', 'evaluate'];
const PROD_HOSTS = new Set([
  'physician-ui.vercel.app',
  'audit-dashboard-rouge.vercel.app',
  'backend-production-c12e4.up.railway.app',
  'rimpl.railway.internal',
]);
const REQUIRED_ENV = [
  'SMOKE_BASE',
  'SMOKE_PHYSICIANS',
  'SMOKE_PHYSICIAN_PW',
  'SMOKE_SUPER_EMAIL',
  'SMOKE_SUPER_PW',
  'LOCAL_AI_BASE_URL',
  'LOCAL_AI_MODEL',
];
const FIXED_TURNS = [
  'กรณีสมมุติที่ไม่มีข้อมูลผู้ป่วยจริง: อาการแน่นหน้าอกขณะออกแรงทำให้ฉันต้องแยกภาวะหลอดเลือดหัวใจเฉียบพลันก่อน แล้วจึงเทียบ stable angina กับสาเหตุปอดและกล้ามเนื้อ',
  'For this fictional case, worsening pain at rest, instability, dynamic ECG change, or rising troponin would increase urgency; a normal first ECG would not close the differential.',
  'ฉันจะตรวจ ECG และ troponin ตามเวลา ประเมินความเสี่ยงซ้ำ และเลือกการตรวจเพิ่มเติมเมื่อผลนั้นเปลี่ยนการรักษา โดยทบทวนแนวทางอ้างอิงที่ใช้',
  'I would document residual uncertainty, explain the management rationale, define urgent return triggers, and arrange reassessment rather than treating one reassuring result as definitive.',
];
const FIXED_REFLECTION = {
  learned: 'I learned to connect each management step to a stated clinical hypothesis and to revise that hypothesis when evidence changes.',
  uncertainty: 'The remaining uncertainty is which finding should trigger escalation; I would verify that threshold against the applicable guidance.',
  application: 'In a future hypothetical case I will document alternatives, evidence, uncertainty, reassessment, and safety-netting explicitly.',
  skipped: false,
};
const HELP = `Usage: node scripts/smoke/local-ai-sandbox-smoke.mjs [options]

End-to-end smoke for the isolated SANDBOX council on a local, tailnet-routed CLICS stack.
It never prints credentials, account emails, transcript text, or AI replies.

Options:
  --scenario <name>  single | burst | cap | down | capacity | all (default: single)
  --n <count>        Number of burst sessions (default: 5)
  --turns <count>    Fixed clinical-reasoning turns per normal session (default: 4)
  --wait-min <mins>  Maximum evaluation wait (default: 25)
  --out <path>       Write a sanitized JSON report
  --no-prompt        Skip the operator-driven down scenario
  --help             Print this help and exit without reading env or making network calls

Required environment variable names:
  ${REQUIRED_ENV.join(', ')}`;

class PreconditionError extends Error {
  constructor(number, message) {
    super(message);
    this.name = 'PreconditionError';
    this.number = number;
  }
}

class SmokeError extends Error {
  constructor(message, response = null) {
    super(message);
    this.name = 'SmokeError';
    this.response = response;
  }
}

function parseArgs(argv) {
  const out = { scenario: 'single', n: 5, turns: 4, waitMin: 25, out: null, noPrompt: false, help: false };
  if (argv.includes('--help')) return { ...out, help: true };
  const valueFlags = new Map([
    ['--scenario', 'scenario'], ['--n', 'n'], ['--turns', 'turns'], ['--wait-min', 'waitMin'], ['--out', 'out'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-prompt') { out.noPrompt = true; continue; }
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const key = valueFlags.get(flag);
    if (!key) throw new SmokeError(`unknown option ${flag}; run with --help`);
    const value = inline ?? argv[++i];
    if (value == null || value === '' || String(value).startsWith('--')) throw new SmokeError(`${flag} requires a value`);
    out[key] = value;
  }
  if (!SCENARIOS.has(out.scenario)) throw new SmokeError('--scenario must be single, burst, cap, down, capacity, or all');
  for (const [key, flag] of [['n', '--n'], ['turns', '--turns'], ['waitMin', '--wait-min']]) {
    if (!/^\d+$/.test(String(out[key]))) throw new SmokeError(`${flag} must be a positive integer`);
    out[key] = Number(out[key]);
    if (!Number.isSafeInteger(out[key]) || out[key] < 1) throw new SmokeError(`${flag} must be a positive integer`);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseDetail(response) {
  if (!response) return '';
  const code = typeof response.json?.code === 'string' && /^[A-Za-z0-9_.-]+$/.test(response.json.code)
    ? ` code=${response.json.code}` : '';
  const error = response.json && Object.hasOwn(response.json, 'error') ? ' error=<redacted>' : '';
  return `status=${response.status}${code}${error}`;
}

function errorDetail(error) {
  if (error?.response) return responseDetail(error.response);
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]+$/.test(error.code) ? ` code=${error.code}` : '';
  return `${error?.name || 'Error'}${code}`;
}

function assert(condition, message, response = null) {
  if (!condition) throw new SmokeError(message, response);
}

function assertStatus(response, allowed, message) {
  assert(allowed.includes(response.status), `${message} (${responseDetail(response)})`, response);
  return response;
}

function tokenTotal(user) {
  return Number(user?.usage_input_tokens ?? 0) + Number(user?.usage_output_tokens ?? 0);
}

function parsePositiveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254);
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value);
  }
  return false;
}

async function resolvesOnlyPrivate(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateAddress(bare)) return true;
  let addresses;
  try { addresses = await lookup(bare, { all: true, verbatim: true }); }
  catch { return false; }
  return addresses.length > 0 && addresses.every(({ address }) => isPrivateAddress(address));
}

const options = (() => {
  try { return parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(`Argument error: ${error.message}`);
    process.exitCode = 2;
    return null;
  }
})();

if (!options) process.exit();
if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const state = {
  base: null,
  local: null,
  superToken: null,
  physicians: [],
  ples: new Map(),
  settingsToRestore: new Map(),
  scenarioReports: {},
  summary: [],
  tokenSamples: [],
  evalLatenciesMs: [],
  shuttingDown: false,
  operatorModelBogus: false,
  settingsMutation: Promise.resolve(),
};

async function fetchJson(base, pathname, { method = 'GET', token, body, timeoutMs = 15_000, apiKey } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const started = performance.now();
  try {
    const url = `${String(base).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, headers: response.headers, ms: performance.now() - started };
  } catch (error) {
    const wrapped = new SmokeError(`request failed (${error?.name || 'Error'})`);
    wrapped.code = typeof error?.cause?.code === 'string' ? error.cause.code : undefined;
    throw wrapped;
  }
}

const backend = (pathname, opts) => fetchJson(state.base, pathname, opts);

async function login(email, password) {
  const response = await backend('/auth/login', { method: 'POST', body: { email, password } });
  assert(response.status === 200 && typeof response.json?.access_token === 'string', 'login did not return an access token', response);
  return response.json.access_token;
}

async function authMe(physician) {
  const response = await backend('/auth/me', { token: physician.token });
  assertStatus(response, [200], 'GET /auth/me failed');
  assert(response.json?.user && typeof response.json.user === 'object', 'GET /auth/me did not return user metadata', response);
  return response.json.user;
}

async function hardPreconditions() {
  const rawBase = String(process.env.SMOKE_BASE || '').trim();
  if (!rawBase) throw new PreconditionError(1, 'set SMOKE_BASE to the laptop backend URL; there is intentionally no default');
  let parsedBase;
  try { parsedBase = new URL(rawBase); } catch { throw new PreconditionError(1, 'set SMOKE_BASE to a valid http:// or https:// URL'); }
  const hostname = parsedBase.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^https?:$/.test(parsedBase.protocol)) throw new PreconditionError(1, 'SMOKE_BASE must use http:// or https://');
  if (parsedBase.username || parsedBase.password) throw new PreconditionError(1, 'remove credentials from SMOKE_BASE');
  if (/railway\.app$/.test(hostname) || /vercel\.app$/.test(hostname) || PROD_HOSTS.has(hostname)) {
    throw new PreconditionError(1, 'point SMOKE_BASE at the laptop/tailnet backend, never a documented production host');
  }
  if (!(await resolvesOnlyPrivate(hostname))) {
    throw new PreconditionError(1, 'point SMOKE_BASE at a hostname that resolves only to loopback, private-LAN, or Tailscale addresses');
  }
  state.base = rawBase.replace(/\/+$/, '');

  const missing = REQUIRED_ENV.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length) throw new PreconditionError(2, `set every required smoke environment variable (${missing.join(', ')})`);
  const emails = [...new Set(process.env.SMOKE_PHYSICIANS.split(',').map((value) => value.trim()).filter(Boolean))];
  if (!emails.length) throw new PreconditionError(2, 'set SMOKE_PHYSICIANS to at least one comma-separated sandbox physician account');

  let localUrl;
  try { localUrl = new URL(process.env.LOCAL_AI_BASE_URL); }
  catch { throw new PreconditionError(2, 'set LOCAL_AI_BASE_URL to a valid http:// or https:// URL'); }
  if (!/^https?:$/.test(localUrl.protocol)) throw new PreconditionError(2, 'LOCAL_AI_BASE_URL must use http:// or https://');
  if (localUrl.username || localUrl.password) throw new PreconditionError(2, 'remove credentials from LOCAL_AI_BASE_URL and use the optional API-key environment setting instead');
  if (!(await resolvesOnlyPrivate(localUrl.hostname))) {
    throw new PreconditionError(2, 'point LOCAL_AI_BASE_URL at a host that resolves only to private-LAN or Tailscale addresses');
  }
  state.local = readConfig();

  let models;
  try {
    models = await fetchJson(state.local.baseUrl, '/models', { apiKey: state.local.apiKey, timeoutMs: 15_000 });
  } catch {
    throw new PreconditionError(3, 'make the local model server reachable and allow GET /models');
  }
  const served = Array.isArray(models.json?.data) ? models.json.data.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [];
  if (models.status !== 200 || !served.includes(state.local.model)) {
    throw new PreconditionError(3, 'configure LOCAL_AI_MODEL to an exact model id returned by the authenticated GET /models endpoint');
  }

  let health;
  try { health = await backend('/health/deep'); }
  catch { throw new PreconditionError(4, 'start the laptop backend and RIMPL, then make GET /health/deep reachable'); }
  const deep = health.json?.checks?.rimpl?.deep;
  const routing = deep?.routing;
  const modelsByPurpose = deep?.models;
  const lanes = deep?.queues?.local?.lanes;
  const drain = health.json?.checks?.eval_queue?.drain;
  const localHealth = deep?.checks?.local_ai;
  const includeCodes = Array.isArray(drain?.scope?.include_codes)
    ? drain.scope.include_codes.map((code) => String(code).toUpperCase()) : [];
  const excludeCodes = Array.isArray(drain?.scope?.exclude_codes)
    ? drain.scope.exclude_codes.map((code) => String(code).toUpperCase()) : [];
  const envOverrideIsActive = routing?.override === true && routing?.source === 'env';
  const resolvedPurposesAreLocal = PURPOSES.every((purpose) => modelsByPurpose?.[purpose]?.provider === 'local'
    && modelsByPurpose[purpose].model === state.local.model);
  const sandboxOnlyDrain = includeCodes.length === 1 && includeCodes[0] === 'SANDBOX'
    && !excludeCodes.includes('SANDBOX') && drain?.scope?.failed_closed == null;
  if (health.status !== 200 || !envOverrideIsActive || !resolvedPurposesAreLocal
    || localHealth?.status !== 'up' || localHealth?.model !== state.local.model
    || !lanes || drain?.running !== true) {
    throw new PreconditionError(4, 'make deep health 200 with the dev-only env routing override, the exact LOCAL_AI_MODEL for all four purposes, local queue lanes, and a running evaluation drain');
  }

  try {
    state.superToken = await login(process.env.SMOKE_SUPER_EMAIL, process.env.SMOKE_SUPER_PW);
    const settings = await backend('/admin/usage-settings', { token: state.superToken });
    const excluded = String(settings.json?.eval_drain_exclude_councils || '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean);
    if (settings.status !== 200 || settings.json?.pilot_test_mode !== true || !excluded.includes('SANDBOX')) {
      throw new PreconditionError(5, 'enable pilot_test_mode and add SANDBOX to eval_drain_exclude_councils on the production-backed settings; this smoke never changes either key');
    }
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError(5, 'verify the superadmin credentials and GET /admin/usage-settings access on the laptop backend');
  }
  if (!sandboxOnlyDrain) {
    throw new PreconditionError(5, 'fix the backend drain partition so deep health proves an effective SANDBOX-only include scope without also excluding SANDBOX; the current include/exclude intersection cannot safely claim sandbox rows');
  }

  try {
    const councils = await backend('/admin/councils', { token: state.superToken });
    if (councils.status !== 200 || !Array.isArray(councils.json)) {
      throw new PreconditionError(6, 'allow the superadmin to resolve council ids through GET /admin/councils');
    }
    const councilCode = new Map(councils.json.map((council) => [council.id, String(council.code || '').toUpperCase()]));
    for (const email of emails) {
      const token = await login(email, process.env.SMOKE_PHYSICIAN_PW);
      const physician = { token, id: null };
      const user = await authMe(physician);
      if (user.role !== 'physician' || councilCode.get(user.council_id) !== 'SANDBOX') {
        throw new PreconditionError(6, 'place every SMOKE_PHYSICIANS account in the SANDBOX council with the physician role');
      }
      if (!user.consented_at) throw new PreconditionError(6, 'record informed consent for every sandbox physician before running the smoke');
      const identity = await backend('/auth/identity/status', { token });
      if (identity.status !== 200 || (identity.json?.required === true && identity.json?.status !== 'verified')) {
        throw new PreconditionError(6, 'complete identity verification for every sandbox physician when the identity gate is enabled');
      }
      physician.id = user.id;
      const reset = await backend(`/admin/users/${encodeURIComponent(user.id)}/reset-usage`, { method: 'POST', token: state.superToken });
      if (reset.status !== 200) throw new PreconditionError(6, 'allow the superadmin to reset usage for every sandbox physician');
      const resetUser = await authMe(physician);
      if (tokenTotal(resetUser) !== 0) throw new PreconditionError(6, 'reset each sandbox physician usage meter to zero before measuring token deltas');
      state.physicians.push(physician);
    }
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError(6, 'verify every sandbox physician login, /auth/me response, SANDBOX membership, and usage reset');
  }
}

function newScenarioReport() {
  return { status: 'running', ids: [], statuses: [], phases: [], latencies_ms: [], token_counts: [] };
}

function trackPle(id, physician, scenario) {
  const ple = { id, physician, scenario, ended: false };
  state.ples.set(id, ple);
  state.scenarioReports[scenario].ids.push(id);
  return ple;
}

async function createPle(physician, scenario) {
  const response = await backend('/ples', {
    method: 'POST', token: physician.token,
    body: { chief_complaint: 'Hypothetical exertional chest discomfort; no real patient data', socratic: false },
  });
  assert(response.status === 201 && typeof response.json?.id === 'string', 'POST /ples did not create a PLE', response);
  return trackPle(response.json.id, physician, scenario);
}

async function sendTurn(ple, turnIndex) {
  const response = await backend(`/ples/${encodeURIComponent(ple.id)}/message`, {
    method: 'POST', token: ple.physician.token,
    body: { message: FIXED_TURNS[turnIndex % FIXED_TURNS.length], language: turnIndex % 2 === 0 ? 'th' : 'en' },
    timeoutMs: parsePositiveEnvInt('RIMPL_CHAT_TIMEOUT_MS', 100_000) + 10_000,
  });
  return response;
}

function assertSuccessfulTurn(response, label) {
  assertStatus(response, [200], label);
  assert(Number(response.json?.transcript?.used) > 0, `${label}: transcript.used must be greater than zero`, response);
  if (response.json?.provider != null) assert(response.json.provider === 'local', `${label}: provider must be local`, response);
}

async function preparePle(physician, scenario, turns = options.turns) {
  const ple = await createPle(physician, scenario);
  for (let i = 0; i < turns; i++) {
    const response = await sendTurn(ple, i);
    assertSuccessfulTurn(response, `turn ${i + 1}`);
    state.scenarioReports[scenario].token_counts.push(Number(response.json?.transcript?.used) || 0);
  }
  return ple;
}

async function rawEnd(ple) {
  const response = await backend(`/ples/${encodeURIComponent(ple.id)}/end`, {
    method: 'POST', token: ple.physician.token, body: { active_seconds: 60 },
    timeoutMs: parsePositiveEnvInt('RIMPL_CRITERIA_TIMEOUT_MS', 180_000) + 20_000,
  });
  if (response.status >= 200 && response.status < 300) ple.ended = true;
  return response;
}

async function submitReflection(ple) {
  return backend(`/ples/${encodeURIComponent(ple.id)}/reflection`, {
    method: 'POST', token: ple.physician.token, body: FIXED_REFLECTION,
    timeoutMs: parsePositiveEnvInt('RIMPL_CRITERIA_TIMEOUT_MS', 180_000) + 20_000,
  });
}

async function finalizePle(ple, endResponse = null) {
  let response = endResponse ?? await rawEnd(ple);
  assertStatus(response, [200, 202], 'POST /ples/:id/end failed');
  if (response.json?.status === 'ended' && response.json?.pending === 'reflection') {
    response = await submitReflection(ple);
    assertStatus(response, [200, 202], 'POST /ples/:id/reflection failed');
  }
  assert(response.json?.status === 'ple_pass' || response.json?.status === 'evaluated',
    `PLE screening did not enqueue an evaluation (status=${String(response.json?.status || 'missing')})`, response);
  return response;
}

async function pollEvaluation(ple, { requireSequence = true, deadlineMs = options.waitMin * 60_000 } = {}) {
  const started = performance.now();
  const phases = [];
  let delay = 0;
  while (performance.now() - started <= deadlineMs) {
    if (delay) await sleep(delay);
    const response = await backend(`/ples/${encodeURIComponent(ple.id)}/evaluation`, { token: ple.physician.token });
    if (response.status === 200) {
      assert(response.json && typeof response.json === 'object', 'evaluation returned 200 without a result', response);
      assert(response.json.provenance?.provider === 'local', 'evaluation provenance.provider must be local', response);
      const calls = response.json.provenance?.consistency?.calls;
      if (calls != null) assert(calls === 2 || calls === 3, 'evaluation provenance.consistency.calls must be 2 or 3', response);
      if (requireSequence) {
        const waitingIndex = phases.findIndex((phase) => phase === 'screening' || phase === 'queued');
        const scoringIndex = phases.findIndex((phase, index) => index > waitingIndex && phase === 'scoring');
        assert(waitingIndex !== -1, 'evaluation never exposed a screening or queued phase');
        assert(scoringIndex !== -1, 'evaluation did not progress from screening/queued to scoring');
      }
      const latency = performance.now() - started;
      state.evalLatenciesMs.push(latency);
      return { result: response.json, phases, latency };
    }
    assertStatus(response, [202], 'GET /ples/:id/evaluation failed');
    const phase = response.json?.phase ?? (response.json?.status === 'pending_review' ? 'pending_review' : null);
    assert(['screening', 'queued', 'scoring', 'pending_review'].includes(phase), 'evaluation returned an unknown pending phase', response);
    phases.push(phase);
    if (phase === 'pending_review') throw new SmokeError('evaluation is held at pending_review; provenance cannot be asserted');
    delay = delay === 0 ? 4_000 : Math.min(30_000, delay * 2);
  }
  throw new SmokeError(`evaluation did not complete within ${options.waitMin} minute(s)`);
}

async function recordUsage(physician, beforeTokens, pleCount, scenario, { capacitySample = false } = {}) {
  const after = await authMe(physician);
  const effective = after.usage_limit_effective_tokens;
  assert(effective === null || typeof effective === 'number', 'usage_limit_effective_tokens must be a number or null');
  const delta = tokenTotal(after) - beforeTokens;
  assert(delta > 0, 'physician token usage did not rise');
  const perPle = Math.round(delta / Math.max(1, pleCount));
  if (capacitySample) state.tokenSamples.push(perPle);
  state.scenarioReports[scenario].token_counts.push(perPle);
}

async function scenarioSingle() {
  const wallStarted = performance.now();
  const physician = state.physicians[0];
  const before = tokenTotal(await authMe(physician));
  const ple = await preparePle(physician, 'single');
  await finalizePle(ple);
  const evaluation = await pollEvaluation(ple);
  state.scenarioReports.single.phases.push(...evaluation.phases);
  state.scenarioReports.single.latencies_ms.push(Math.round(performance.now() - wallStarted));
  state.scenarioReports.single.statuses.push('evaluated');
  await recordUsage(physician, before, 1, 'single', { capacitySample: true });
}

async function sampleBurstHealth(n, queueBaseline = 0) {
  const response = await backend('/health/deep');
  assertStatus(response, [200], 'GET /health/deep failed during burst');
  const queue = response.json?.checks?.eval_queue;
  const background = response.json?.checks?.rimpl?.deep?.queues?.local?.lanes?.background;
  assert(typeof queue?.queued === 'number' && Math.max(0, queue.queued - queueBaseline) <= n,
    `eval_queue.queued increased by more than burst size ${n}`);
  assert(typeof background?.queued === 'number' && typeof background?.maxQueue === 'number'
    && background.queued <= background.maxQueue, 'local background queue exceeded maxQueue');
  return { queue, background };
}

async function waitForBackgroundActivity(n, queueBaseline, deadlineMs = 30_000) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() <= deadline) {
    const sample = await sampleBurstHealth(n, queueBaseline);
    if (sample.background.active > 0 || sample.background.queued > 0) return;
    await sleep(500);
  }
  throw new SmokeError('the burst never produced observable local background activity');
}

async function loadAdminPleRows(pleIds) {
  const wanted = new Set(pleIds);
  const found = new Map();
  const maxPages = Math.ceil(wanted.size / 200) + 10;
  for (let page = 0; page < maxPages && found.size < wanted.size; page++) {
    const response = await backend(`/admin/ples?limit=200&offset=${page * 200}`, { token: state.superToken });
    assertStatus(response, [200], 'GET /admin/ples failed while reading enqueue timestamps');
    const rows = Array.isArray(response.json) ? response.json : [];
    for (const row of rows) if (wanted.has(row.id)) found.set(row.id, row);
    if (rows.length < 200) break;
  }
  const rows = [...found.values()];
  assert(rows.length === wanted.size, 'the recent admin PLE pages did not contain every burst PLE');
  assert(rows.every((row) => Number.isFinite(Date.parse(row.eval_enqueued_at))), 'a burst PLE lacks a valid eval_enqueued_at timestamp');
  return rows;
}

async function exportedExactlyOnce(pleIds) {
  const first = await backend('/admin/export?include_test=true&limit=1000&offset=0', { token: state.superToken });
  assertStatus(first, [200], 'GET /admin/export failed');
  const total = Number(first.json?.total ?? 0);
  const offset = Math.max(0, total - 1000);
  const page = offset === 0 ? first : await backend(`/admin/export?include_test=true&limit=1000&offset=${offset}`, { token: state.superToken });
  assertStatus(page, [200], 'GET /admin/export final page failed');
  const sessions = Array.isArray(page.json?.sessions) ? page.json.sessions : [];
  for (const id of pleIds) {
    const hits = sessions.filter((session) => session.ple_id === id && session.ai_composite != null);
    assert(hits.length === 1, 'each burst PLE must appear once with an evaluation in the de-identified export');
    const reeval = await backend(`/admin/ples/${encodeURIComponent(id)}/reevaluate`, { method: 'POST', token: state.superToken });
    assert(reeval.status === 409, 'an evaluated burst PLE must refuse re-evaluation', reeval);
  }
}

async function scenarioBurst() {
  const before = new Map();
  const countByPhysician = new Map();
  for (let i = 0; i < options.n; i++) {
    const physician = state.physicians[i % state.physicians.length];
    if (!before.has(physician.id)) before.set(physician.id, tokenTotal(await authMe(physician)));
    countByPhysician.set(physician.id, (countByPhysician.get(physician.id) || 0) + 1);
  }
  const sessions = [];
  for (let i = 0; i < options.n; i++) {
    sessions.push(await preparePle(state.physicians[i % state.physicians.length], 'burst'));
  }
  const extra = await createPle(state.physicians[options.n % state.physicians.length], 'burst');
  const queueBaseline = (await sampleBurstHealth(Number.MAX_SAFE_INTEGER)).queue.queued;

  const issuedOrder = [...sessions];
  const burstStarted = performance.now();
  const endResponses = await Promise.all(sessions.map((ple) => rawEnd(ple)));
  const screeningResponses = await Promise.all(endResponses.map(async (response, index) => {
    assertStatus(response, [200, 202], 'burst POST /end failed');
    if (response.json?.status === 'ended' && response.json?.pending === 'reflection') {
      return submitReflection(sessions[index]);
    }
    return response;
  }));
  for (const response of screeningResponses) {
    assertStatus(response, [200, 202], 'burst screening failed');
    assert(response.json?.status === 'ple_pass' || response.json?.status === 'evaluated',
      'burst screening did not enqueue an evaluation', response);
  }
  await waitForBackgroundActivity(options.n, queueBaseline);
  const chatResponse = await sendTurn(extra, 0);
  assertSuccessfulTurn(chatResponse, 'interactive chat during evaluation burst');
  const chatTimeout = parsePositiveEnvInt('RIMPL_CHAT_TIMEOUT_MS', 100_000);
  assert(chatResponse.ms <= chatTimeout, 'interactive chat exceeded RIMPL_CHAT_TIMEOUT_MS');
  state.scenarioReports.burst.latencies_ms.push(Math.round(chatResponse.ms));
  state.scenarioReports.burst.token_counts.push(Number(chatResponse.json?.transcript?.used) || 0);

  const pollStarted = burstStarted;
  const pending = new Map(issuedOrder.map((ple) => [ple.id, { ple, phases: [] }]));
  const evaluated = [];
  const deadline = burstStarted + options.waitMin * 60_000;
  while (pending.size && performance.now() <= deadline) {
    await sampleBurstHealth(options.n, queueBaseline);
    for (const [id, item] of [...pending]) {
      const response = await backend(`/ples/${encodeURIComponent(id)}/evaluation`, { token: item.ple.physician.token });
      if (response.status === 200) {
        assert(response.json?.provenance?.provider === 'local', 'burst evaluation provenance.provider must be local', response);
        assert(Number.isFinite(Date.parse(response.json?.evaluated_at)), 'burst evaluation must expose a valid evaluated_at timestamp', response);
        const latency = performance.now() - pollStarted;
        state.evalLatenciesMs.push(latency);
        state.scenarioReports.burst.latencies_ms.push(Math.round(latency));
        evaluated.push({ id, evaluatedAt: response.json.evaluated_at, phases: item.phases });
        pending.delete(id);
      } else {
        assertStatus(response, [202], 'burst evaluation poll failed');
        const phase = response.json?.phase ?? (response.json?.status === 'pending_review' ? 'pending_review' : null);
        assert(['screening', 'queued', 'scoring'].includes(phase), 'burst evaluation returned an unknown or held phase', response);
        item.phases.push(phase);
      }
    }
    if (pending.size) await sleep(5_000);
  }
  assert(pending.size === 0, `burst evaluations did not all complete within ${options.waitMin} minute(s)`);
  const enqueueRows = await loadAdminPleRows(issuedOrder.map((ple) => ple.id));
  const issuedIndex = new Map(issuedOrder.map((ple, index) => [ple.id, index]));
  const enqueueOrder = [...enqueueRows]
    .sort((a, b) => String(a.eval_enqueued_at).localeCompare(String(b.eval_enqueued_at))
      || issuedIndex.get(a.id) - issuedIndex.get(b.id))
    .map((row) => row.id);
  assert(enqueueOrder.every((id, index) => id === issuedOrder[index].id),
    'actual eval_enqueued_at order did not match the order /end calls were issued');
  const evaluatedOrder = [...evaluated].sort((a, b) => String(a.evaluatedAt).localeCompare(String(b.evaluatedAt))).map((item) => item.id);
  assert(evaluatedOrder.every((id, index) => id === enqueueOrder[index]), 'evaluated_at order did not match actual eval_enqueued_at order');
  await exportedExactlyOnce(issuedOrder.map((ple) => ple.id));

  for (const item of evaluated) state.scenarioReports.burst.phases.push(...item.phases);
  state.scenarioReports.burst.statuses.push(...evaluated.map(() => 'evaluated'));
  for (const physician of state.physicians.filter((p) => before.has(p.id))) {
    await recordUsage(physician, before.get(physician.id), countByPhysician.get(physician.id), 'burst', {
      capacitySample: physician.id !== extra.physician.id,
    });
  }
}

async function patchUsageSetting(body) {
  const operation = state.settingsMutation.then(async () => {
    const response = await backend('/admin/usage-settings', { method: 'PATCH', token: state.superToken, body });
    assertStatus(response, [200], 'PATCH /admin/usage-settings failed');
  });
  state.settingsMutation = operation.catch(() => {});
  return operation;
}

async function restoreSetting(key) {
  if (!state.settingsToRestore.has(key) || !state.superToken) return;
  const value = state.settingsToRestore.get(key);
  let restored = false;
  for (let attempt = 0; attempt < 3 && !restored; attempt++) {
    try {
      await patchUsageSetting({ [key]: value });
      const verify = await backend('/admin/usage-settings', { token: state.superToken });
      restored = verify.status === 200 && verify.json?.[key] === value;
    } catch { restored = false; }
    if (!restored && attempt < 2) await sleep(1_000);
  }
  if (!restored) throw new SmokeError(`could not restore and verify changed setting ${key}`);
  state.settingsToRestore.delete(key);
}

async function scenarioCap() {
  const physician = state.physicians[0];
  const before = tokenTotal(await authMe(physician));
  const originalResponse = await backend('/admin/usage-settings', { token: state.superToken });
  assertStatus(originalResponse, [200], 'GET /admin/usage-settings failed before cap scenario');
  const original = originalResponse.json?.ple_max_transcript_tokens;
  assert(Number.isSafeInteger(original), 'original ple_max_transcript_tokens is not an integer');
  state.settingsToRestore.set('ple_max_transcript_tokens', original);
  try {
    await patchUsageSetting({ ple_max_transcript_tokens: 8000 });
    const verify = await backend('/admin/usage-settings', { token: state.superToken });
    assert(verify.status === 200 && verify.json?.ple_max_transcript_tokens === 8000, 'transcript cap did not change to 8000', verify);

    const ple = await createPle(physician, 'cap');
    let sawWarn = false;
    let sawLimit = false;
    for (let i = 0; i < 200; i++) {
      const response = await sendTurn(ple, i);
      if (response.status === 403) {
        assert(response.json?.code === 'transcript_limit_reached', 'cap scenario received the wrong 403 code', response);
        sawLimit = true;
        break;
      }
      assertSuccessfulTurn(response, `cap turn ${i + 1}`);
      sawWarn ||= response.json?.transcript?.warn === true;
      state.scenarioReports.cap.token_counts.push(Number(response.json?.transcript?.used) || 0);
    }
    assert(sawWarn, 'no successful cap turn exposed transcript.warn=true');
    assert(sawLimit, 'cap scenario did not reach transcript_limit_reached');
    await finalizePle(ple);
    const evaluation = await pollEvaluation(ple, { requireSequence: false });
    state.scenarioReports.cap.phases.push(...evaluation.phases);
    state.scenarioReports.cap.latencies_ms.push(Math.round(evaluation.latency));
    state.scenarioReports.cap.statuses.push('evaluated');
    await recordUsage(physician, before, 1, 'cap');
  } finally {
    await restoreSetting('ple_max_transcript_tokens');
  }
}

async function promptEnter(message) {
  console.log(message);
  const rl = createInterface({ input, output });
  try { await rl.question('Press Enter when ready: '); }
  finally { rl.close(); }
}

async function waitForHealthyLocal(deadlineMs = 5 * 60_000) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() <= deadline) {
    const health = await backend('/health/deep');
    const deep = health.json?.checks?.rimpl?.deep;
    const local = deep?.checks?.local_ai;
    const exactModels = PURPOSES.every((purpose) => deep?.models?.[purpose]?.provider === 'local'
      && deep.models[purpose].model === state.local.model);
    if (health.status === 200 && local?.status === 'up' && local.model === state.local.model && exactModels) return;
    await sleep(5_000);
  }
  throw new SmokeError('local AI did not return healthy on the original exact model after the operator restore');
}

async function scenarioDown() {
  if (options.noPrompt) {
    state.scenarioReports.down.statuses.push('skipped');
    return 'skipped by --no-prompt';
  }
  const physician = state.physicians[0];
  const before = tokenTotal(await authMe(physician));
  const ple = await preparePle(physician, 'down');
  await promptEnter('Operator action: restart RIMPL with LOCAL_AI_MODEL=bogus. Do not change any backend or database setting.');
  state.operatorModelBogus = true;
  let ended = null;
  let endedAt = null;
  let outageError = null;
  try {
    ended = await rawEnd(ple);
    endedAt = Date.now();
    assert(ended.status >= 200 && ended.status < 300, 'POST /end must remain 2xx while local AI is down', ended);
    let failedScreening = ended;
    if (ended.json?.status === 'ended' && ended.json?.pending === 'reflection') {
      failedScreening = await submitReflection(ple);
    }
    assert(failedScreening.status === 202 && failedScreening.json?.status === 'ended'
      && failedScreening.json?.pending === 'tier2',
    'screening while local AI is down must remain recoverable at ended/pending:tier2', failedScreening);
    const pending = await backend(`/ples/${encodeURIComponent(ple.id)}/evaluation`, { token: physician.token });
    assert(pending.status === 202, 'evaluation must remain pending while local AI is down', pending);
    const pendingPhase = pending.json?.phase ?? null;
    assert(pendingPhase === 'screening' || pendingPhase === 'queued', 'down evaluation must be screening or queued', pending);
    state.scenarioReports.down.phases.push(pendingPhase);

    const health = await backend('/health/deep');
    const local = health.json?.checks?.rimpl?.deep?.checks?.local_ai;
    assert(health.status === 503 && local?.status === 'down', 'deep health must be 503 with nested local_ai down', health);
  } catch (error) {
    outageError = error;
  }

  await promptEnter('Operator action: restore RIMPL with the original LOCAL_AI_MODEL value.');
  await waitForHealthyLocal();
  state.operatorModelBogus = false;
  if (outageError) throw outageError;
  const recencyWait = Math.max(0, 125_000 - (Date.now() - endedAt));
  if (recencyWait) await sleep(recencyWait);
  const reconcile = await backend('/admin/reconcile-evaluations', {
    method: 'POST', token: state.superToken,
    timeoutMs: parsePositiveEnvInt('RIMPL_CRITERIA_TIMEOUT_MS', 180_000) * 3 + 30_000,
  });
  assertStatus(reconcile, [200], 'reconcile failed after local AI restore');
  const evaluation = await pollEvaluation(ple, { requireSequence: false });
  state.scenarioReports.down.phases.push(...evaluation.phases);
  state.scenarioReports.down.latencies_ms.push(Math.round(evaluation.latency));
  state.scenarioReports.down.statuses.push('evaluated');
  await recordUsage(physician, before, 1, 'down');
  return null;
}

function spawnCaptured(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => reject(new SmokeError('capacity probe could not start')));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new SmokeError(`capacity probe exited ${code}${stderr ? ' with redacted stderr' : ''}`));
    });
  });
}

function parseConcurrencyOutput(text) {
  const rows = [];
  const pattern = /^\s*conc\s+(\d+)\s+n=\s*(\d+)\s+ok\s+(\d+)\/(\d+)\s+p50\s+(\d+)s\s+p95\s+(\d+)s/gm;
  for (const match of text.matchAll(pattern)) {
    rows.push({ level: Number(match[1]), n: Number(match[2]), ok: Number(match[3]), p50_ms: Number(match[5]) * 1000, p95_ms: Number(match[6]) * 1000 });
  }
  assert(rows.length > 0, 'could not parse concurrency probe numeric results');
  return rows;
}

async function scenarioCapacity() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'clics-local-ai-smoke-'));
  const contextOut = path.join(tempDir, 'context.json');
  try {
    const contextArgs = [
      'scripts/probe/context-limit.mjs', '--synthetic', '--shape', 'both',
      '--sizes', '8k,16k,24k,32k,48k,64k', '--repeats', '2', '--out', contextOut,
    ];
    const concurrencyArgs = ['scripts/probe/pis7-concurrency.mjs', '--levels', '1,2,3'];
    await spawnCaptured(contextArgs);
    const concurrencyText = await spawnCaptured(concurrencyArgs);
    let context;
    try { context = JSON.parse(await readFile(contextOut, 'utf8')); }
    catch { throw new SmokeError('context-limit probe did not produce valid JSON'); }
    const concurrency = parseConcurrencyOutput(concurrencyText);
    const localTimeout = parsePositiveEnvInt('LOCAL_AI_TIMEOUT_MS', 150_000);
    const concurrencyCandidates = concurrency.filter((row) => row.ok === row.n && row.p95_ms < localTimeout * 0.8);
    const localMaxConcurrency = concurrencyCandidates.length ? Math.max(...concurrencyCandidates.map((row) => row.level)) : null;
    const transcriptCap = context?.decision?.transcript_cap_tokens ?? null;
    const maxPrompt = context?.decision?.LOCAL_AI_MAX_PROMPT_TOKENS ?? null;
    const usageP95 = percentile(state.tokenSamples, 95);
    const usageLimit = usageP95 == null ? null : Math.ceil(3 * usageP95 * 1.25);
    const evalP50Ms = percentile(state.evalLatenciesMs, 50)
      ?? percentile(concurrency.map((row) => row.p50_ms), 50);
    const evalP50Seconds = evalP50Ms == null ? null : Math.round(evalP50Ms / 1000);

    console.log('\ncapacity recommendations');
    console.log(`  LOCAL_MAX_CONCURRENCY=${localMaxConcurrency ?? 'none verified'}`);
    console.log(`  ple_max_transcript_tokens=${transcriptCap ?? 'none verified'}`);
    console.log(`  LOCAL_AI_MAX_PROMPT_TOKENS=${maxPrompt ?? 'none verified'}`);
    console.log(`  standard_usage_limit_tokens=${usageLimit ?? 'unavailable (no PLE token sample in this invocation)'}`);
    console.log(`  eval_p50_seconds=${evalP50Seconds ?? 'none measured'}`);
    state.scenarioReports.capacity.statuses.push('recommended');
    state.scenarioReports.capacity.latencies_ms.push(...concurrency.flatMap((row) => [row.p50_ms, row.p95_ms]));
    state.scenarioReports.capacity.token_counts.push(...[transcriptCap, maxPrompt, usageLimit].filter((value) => typeof value === 'number'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function cleanupPles(scenario = null, { strict = false } = {}) {
  let failures = 0;
  for (const ple of state.ples.values()) {
    if (ple.ended || (scenario && ple.scenario !== scenario)) continue;
    try {
      const response = await rawEnd(ple);
      if (response.status < 200 || response.status >= 300) failures++;
    } catch { failures++; }
  }
  if (strict && failures) throw new SmokeError(`${failures} started PLE(s) could not be ended during cleanup`);
}

async function restoreAllSettings({ strict = false } = {}) {
  let failures = 0;
  for (const key of [...state.settingsToRestore.keys()]) {
    try { await restoreSetting(key); }
    catch { failures++; }
  }
  if (strict && failures) throw new SmokeError(`${failures} changed setting(s) could not be restored and verified`);
}

async function shutdown(signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  console.error(`\n${signal}: cleaning up active PLEs and restoring changed settings`);
  if (state.operatorModelBogus) console.error('Operator action still required: restore RIMPL with the original LOCAL_AI_MODEL value.');
  try { await restoreAllSettings({ strict: true }); }
  catch { console.error('Cleanup warning: a changed setting could not be restored and verified.'); }
  try { await cleanupPles(null, { strict: true }); }
  catch { console.error('Cleanup warning: a started PLE could not be ended.'); }
  process.exit(130);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

async function runScenario(name, fn) {
  state.scenarioReports[name] = newScenarioReport();
  const started = performance.now();
  let note = null;
  let scenarioError = null;
  try {
    note = await fn();
  } catch (error) {
    scenarioError = error;
  }
  try {
    await cleanupPles(name, { strict: true });
  } catch (error) {
    scenarioError ??= error;
  }
  if (scenarioError) {
    state.scenarioReports[name].status = 'fail';
    const message = scenarioError instanceof SmokeError ? scenarioError.message : 'unexpected internal error';
    const detail = errorDetail(scenarioError);
    const assertion = `${message}${detail && !message.includes(detail) ? ` (${detail})` : ''}`;
    console.log(`${name} FAIL — ${assertion}`);
    state.summary.push({ scenario: name, status: 'FAIL', assertion, ms: Math.round(performance.now() - started) });
    return;
  }
  state.scenarioReports[name].status = note ? 'skipped' : 'pass';
  const assertion = note || 'all assertions satisfied';
  console.log(`${name} PASS — ${assertion}`);
  state.summary.push({ scenario: name, status: 'PASS', assertion, ms: Math.round(performance.now() - started) });
}

async function main() {
  try {
    await hardPreconditions();
  } catch (error) {
    if (error instanceof PreconditionError) {
      console.error(`${error.number}. Fix: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`Precondition failure: unexpected internal error (${errorDetail(error)})`);
    process.exitCode = 2;
    return;
  }

  const names = options.scenario === 'all'
    ? ['single', 'burst', 'cap', 'down', 'capacity']
    : [options.scenario];
  const runners = { single: scenarioSingle, burst: scenarioBurst, cap: scenarioCap, down: scenarioDown, capacity: scenarioCapacity };
  let finalizationError = null;
  try {
    for (const name of names) {
      await runScenario(name, runners[name]);
      if (state.operatorModelBogus) {
        console.error('Stopping: restore RIMPL with the original LOCAL_AI_MODEL value before any further scenario.');
        break;
      }
    }
  } finally {
    try { await restoreAllSettings({ strict: true }); }
    catch (error) { finalizationError ??= error; }
    try { await cleanupPles(null, { strict: true }); }
    catch (error) { finalizationError ??= error; }
  }
  if (finalizationError) {
    const assertion = finalizationError.message;
    console.log(`cleanup FAIL — ${assertion}`);
    state.summary.push({ scenario: 'cleanup', status: 'FAIL', assertion, ms: 0 });
  }

  console.log('\nfinal summary');
  table(
    ['scenario', 'status', 'assertion', 'wall ms'],
    state.summary.map((row) => [row.scenario, row.status, row.assertion, String(row.ms)]),
    ['l', 'l', 'l', 'r'],
  );
  if (options.out) {
    try { await writeReport(options.out, state.scenarioReports); }
    catch {
      console.error('report write failed');
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = state.summary.every((row) => row.status === 'PASS') ? 0 : 1;
}

await main();
