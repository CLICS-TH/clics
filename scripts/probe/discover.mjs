#!/usr/bin/env node
// discover.mjs — Gate 0, step 1: WHAT IS ACTUALLY RUNNING ON THAT HOST?
//
// Nobody has confirmed which inference server the CLICS DGX runs. Open WebUI on a second host
// proxies it, and a chat UI is the wrong thing for rimpl to talk to server-to-server:
//   * extra hop (UI process → inference server) on every clinical turn;
//   * per-USER API-key semantics — Open WebUI keys are scoped to a human account, get revoked when
//     that person leaves, and make every CLE look like it came from one operator;
//   * a UI layer applies its own throttling/queueing, so any throughput number measured through it
//     describes the UI, not the GPU;
//   * OpenAI-compatible surface parity is partial — usage accounting in particular is often dropped,
//     and rimpl bills on usage.prompt_tokens / usage.completion_tokens.
// So: find the inference server, and prove it answers directly.
//
// This script only READS (GET) except for one optional tiny generation to prove the chat endpoint
// works end to end. It needs no CLICS token and no repo secrets.
//
// Usage:
//   LOCAL_AI_BASE_URL=http://<host>:<port>/v1 node scripts/probe/discover.mjs
//   ...           --no-chat        skip the one-token generation probe
//   ...           --out report.json

import {
  readConfig, printTarget, http, chatCompletion, hr, table, parseArgs, writeReport,
  bold, dim, green, red, yellow, cyan, ms,
} from './lib.mjs';

const { flags } = parseArgs();

// needModel:false — discovering the model id is this script's job, so requiring it would be circular.
const cfg = readConfig({ needModel: false });
// Discovery must be quick: an unreachable port should report in seconds, not sit on the 180s
// generation budget.
const PROBE_MS = 8000;

printTarget(cfg, { probe: 'GET only (+1 optional tiny generation)' });

// Probe paths are tried against BOTH the origin and the configured base URL, because we do not yet
// know whether the operator gave us `http://host:8000` or `http://host:8000/v1`.
const PROBES = [
  { path: '/v1/models',      from: 'origin', stack: 'OpenAI-compatible', note: 'vLLM / SGLang / llama.cpp / TGI / LiteLLM / Open WebUI all expose this' },
  { path: '/models',         from: 'base',   stack: 'OpenAI-compatible', note: 'base URL already carries the version prefix' },
  { path: '/api/tags',       from: 'origin', stack: 'Ollama',            note: 'Ollama native model list' },
  { path: '/api/version',    from: 'origin', stack: 'Ollama',            note: 'Ollama version' },
  { path: '/version',        from: 'origin', stack: 'vLLM',              note: 'vLLM reports its version here' },
  { path: '/get_model_info', from: 'origin', stack: 'SGLang',            note: 'SGLang native' },
  { path: '/info',           from: 'origin', stack: 'TGI',               note: 'HF text-generation-inference' },
  { path: '/props',          from: 'origin', stack: 'llama.cpp',         note: 'llama.cpp server' },
  { path: '/api/config',     from: 'origin', stack: 'Open WebUI',        note: 'UI PROXY — not the inference server' },
  { path: '/health',         from: 'origin', stack: '(generic)',         note: 'liveness; Open WebUI also answers here' },
  { path: '/metrics',        from: 'origin', stack: '(generic)',         note: 'Prometheus — vLLM exposes rich queue/batch metrics' },
];

const results = [];
for (const p of PROBES) {
  const url = (p.from === 'origin' ? cfg.origin : cfg.baseUrl) + p.path;
  const r = await http(url, { timeoutMs: PROBE_MS, apiKey: cfg.apiKey });
  results.push({ ...p, url, res: r });
}

// The document root: HTML back means a browser UI is bound to this port.
const root = await http(cfg.origin + '/', { timeoutMs: PROBE_MS, apiKey: cfg.apiKey, accept: 'text/html,application/json' });

/* ------------------------------------------------------------------ report */

hr('endpoint probe');
table(
  ['path', 'status', 'ms', 'suggests', 'body (truncated)'],
  results.map((r) => {
    const st = r.res.error ? red(r.res.error.split(':')[0])
      : r.res.ok ? green(String(r.res.status))
      : (r.res.status === 401 || r.res.status === 403) ? yellow(`${r.res.status} auth`)
      : dim(String(r.res.status));
    const body = r.res.error ? '' : (r.res.text || '').replace(/\s+/g, ' ').slice(0, 60);
    return [r.path, st, r.res.error ? '—' : Math.round(r.res.ms), r.res.ok ? r.stack : dim(r.stack), dim(body)];
  }),
  ['l', 'l', 'r', 'l', 'l'],
);

const hit = (path) => results.find((r) => r.path === path && r.res.ok);
const anyReachable = results.some((r) => r.res.status !== null) || root.status !== null;

if (!anyReachable) {
  hr('verdict');
  console.log(`  ${red('nothing answered on this host at all.')}`);
  console.log(`  ${dim('Check, in order:')}`);
  console.log(`    1. tailscale status          ${dim('— is Tailscale up and is this machine in the tailnet?')}`);
  console.log(`    2. tailscale ping <host>     ${dim('— does the peer answer at the WireGuard layer?')}`);
  console.log(`    3. nc -vz <host> <port>      ${dim('— is the port open, or is a tailnet ACL blocking it?')}`);
  console.log(`  ${dim('A tailnet ACL that permits :3000 (the UI) but not the inference port is the')}`);
  console.log(`  ${dim('single most common cause of "the UI works but the API does not".')}`);
  process.exit(1);
}

/* --------------------------------------------------------- served model ids */

let servedModels = [];
let modelSource = null;

const openai = hit('/v1/models') || hit('/models');
if (openai) {
  servedModels = (openai.res.json?.data || []).map((m) => m.id).filter(Boolean);
  modelSource = openai.url;
}
const ollama = hit('/api/tags');
if (ollama && !servedModels.length) {
  servedModels = (ollama.res.json?.models || []).map((m) => m.name || m.model).filter(Boolean);
  modelSource = ollama.url;
}

hr('served models');
if (servedModels.length) {
  console.log(`  ${dim('from')} ${modelSource}`);
  for (const id of servedModels) console.log(`    ${cyan(id)}`);
} else if (openai || ollama) {
  console.log(`  ${yellow('the model-list endpoint answered but listed nothing.')}`);
  console.log(`  ${dim('An empty list usually means a proxy with no upstream configured.')}`);
} else {
  const authWalled = results.filter((r) => r.res.status === 401 || r.res.status === 403);
  if (authWalled.length) {
    console.log(`  ${yellow('model list is behind auth')} — ${authWalled.map((r) => r.path).join(', ')} returned 401/403.`);
    console.log(`  ${dim('Set LOCAL_AI_API_KEY and re-run. If the only key available is an Open WebUI')}`);
    console.log(`  ${dim('per-user key, that is a reason to get access to the inference server instead.')}`);
  } else {
    console.log(`  ${red('no model list found.')} ${dim('This may not be an OpenAI-compatible or Ollama server.')}`);
  }
}

/* ------------------------------------------------------------ what is this */

hr('verdict');

const looksLikeHtml = /<html|<!doctype html/i.test(root.text || '');
const openWebUiConfig = hit('/api/config');
const openWebUiSignals = [
  openWebUiConfig ? `/api/config answered (${JSON.stringify(openWebUiConfig.res.json?.name ?? '')})` : null,
  looksLikeHtml ? 'the document root serves HTML (a browser UI is bound to this port)' : null,
  /open\s*webui/i.test((root.text || '') + JSON.stringify(openWebUiConfig?.res.json ?? '')) ? 'the string "Open WebUI" appears in the response' : null,
].filter(Boolean);

const inferenceSignals = [
  hit('/version') && /vllm|\d+\.\d+/.test(JSON.stringify(hit('/version').res.json ?? '')) ? 'vLLM (/version)' : null,
  hit('/get_model_info') ? 'SGLang (/get_model_info)' : null,
  hit('/info') ? 'TGI (/info)' : null,
  hit('/props') ? 'llama.cpp (/props)' : null,
  hit('/api/tags') ? 'Ollama (/api/tags)' : null,
  hit('/metrics') && /vllm:/.test(hit('/metrics').res.text || '') ? 'vLLM (Prometheus metrics namespace "vllm:")' : null,
].filter(Boolean);

if (inferenceSignals.length) {
  console.log(`  ${green('inference server detected:')} ${inferenceSignals.join(', ')}`);
} else if (openai) {
  console.log(`  ${green('an OpenAI-compatible API is here')}, but it did not identify its stack.`);
  console.log(`  ${dim('Could be vLLM/SGLang behind a reverse proxy, LiteLLM, or a UI proxy.')}`);
}

if (openWebUiSignals.length) {
  console.log(`\n  ${yellow('⚠ this endpoint looks like Open WebUI (a UI proxy), not the inference server.')}`);
  for (const s of openWebUiSignals) console.log(`      ${dim('· ' + s)}`);
  console.log(`  ${dim('It will probably work, but prefer the inference server directly:')}`);
  console.log(`  ${dim('  – one less hop per clinical turn;')}`);
  console.log(`  ${dim('  – no per-user API-key lifecycle (a departing operator must not 401 the pilot);')}`);
  console.log(`  ${dim('  – no UI-layer throttling distorting throughput.mjs;')}`);
  console.log(`  ${dim('  – usage.prompt_tokens/completion_tokens survive intact (rimpl bills on them).')}`);
  console.log(`  ${dim('Ask the box operator which port the server itself listens on (vLLM/SGLang')}`);
  console.log(`  ${dim('default :8000, Ollama :11434) and whether the tailnet ACL permits it.')}`);
}

if (!inferenceSignals.length && !openai && !openWebUiSignals.length) {
  console.log(`  ${red('could not identify a serving stack.')} ${dim('Something answered, but not a shape we know.')}`);
  console.log(`  ${dim('Show this table to whoever operates the box.')}`);
}

/* --------------------------------------------------- prove chat works (1×) */

let chatProbe = null;
const chatModel = cfg.model || servedModels[0] || null;

if (flags['no-chat']) {
  console.log(`\n  ${dim('--no-chat: skipped the generation probe.')}`);
} else if (!chatModel) {
  console.log(`\n  ${yellow('skipping the generation probe: no model id known.')} ${dim('Set LOCAL_AI_MODEL and re-run.')}`);
} else {
  hr('generation probe');
  console.log(`  POST ${cfg.baseUrl}/chat/completions  ${dim(`model=${chatModel} max_tokens=16`)}`);
  const probeCfg = { ...cfg, model: chatModel, timeoutMs: Math.max(cfg.timeoutMs, 60000) };
  chatProbe = await chatCompletion(probeCfg, {
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    maxTokens: 16,
  });
  if (!chatProbe.ok) {
    console.log(`  ${red('FAILED')} ${chatProbe.error}`);
    console.log(`  ${dim('A 404 here with a working /v1/models almost always means LOCAL_AI_BASE_URL is')}`);
    console.log(`  ${dim('missing (or duplicating) the version prefix — rimpl appends /chat/completions.')}`);
  } else {
    console.log(`  ${green('OK')} ${ms(chatProbe.ms)}  finish_reason=${chatProbe.finishReason} ` +
      `prompt=${chatProbe.promptTokens} completion=${chatProbe.completionTokens}`);
    console.log(`  server-reported model: ${cyan(chatProbe.model)}`);
    console.log(`  reply: ${JSON.stringify(chatProbe.text.slice(0, 120))}`);
    if (chatProbe.reasoningOnly) {
      console.log(`  ${red('⚠ message.content was empty but reasoning_content was present.')}`);
      console.log(`  ${dim('rimpl deliberately drops non-string content so chain-of-thought never enters a')}`);
      console.log(`  ${dim('clinical transcript — so every reply would arrive EMPTY. Fix this at the server')}`);
      console.log(`  ${dim('(non-thinking variant, or a flag that folds reasoning out) before Gate 0.')}`);
    }
    if (chatProbe.promptTokens === 0 && chatProbe.completionTokens === 0) {
      console.log(`  ${yellow('⚠ the server returned no usage accounting.')}`);
      console.log(`  ${dim('rimpl meters spend and enforces the per-user cap on usage.prompt_tokens /')}`);
      console.log(`  ${dim('usage.completion_tokens. Zeroes would silently disable the budget. Common when')}`);
      console.log(`  ${dim('proxying through a UI — another reason to hit the inference server directly.')}`);
    }
    if (chatProbe.model && cfg.model && chatProbe.model !== cfg.model) {
      console.log(`  ${yellow(`⚠ server answered as "${chatProbe.model}" but LOCAL_AI_MODEL is "${cfg.model}".`)}`);
      console.log(`  ${dim('rimpl stamps the SERVER-reported model into model_version (§10.2 provenance),')}`);
      console.log(`  ${dim('and providers/local.js ready() marks the box down if the pinned id is not served.')}`);
    }
  }
}

/* ------------------------------------------------------------ next actions */

hr('use this in rimpl');
const suggestedBase = openai
  ? openai.url.replace(/\/models$/, '')
  : (ollama ? `${cfg.origin}/v1` : cfg.baseUrl);
console.log(`  LOCAL_AI_BASE_URL=${suggestedBase}`);
console.log(`  LOCAL_AI_MODEL=${chatProbe?.model || chatModel || '<pick one from the list above>'}`);
if (ollama && !openai) {
  console.log(`  ${dim('Ollama also serves an OpenAI-compatible surface at /v1 — that is the one rimpl')}`);
  console.log(`  ${dim('speaks. Re-run this script against it to confirm before trusting the line above.')}`);
}
console.log(`\n  ${bold('next:')} node scripts/probe/json-contract.mjs   ${dim('(the actual Gate 0 test)')}`);

await writeReport(flags.out, {
  probe: 'discover', at: new Date().toISOString(),
  target: { baseUrl: cfg.baseUrl, origin: cfg.origin, model: cfg.model || null },
  endpoints: results.map((r) => ({ path: r.path, url: r.url, status: r.res.status, ok: r.res.ok, ms: Math.round(r.res.ms), error: r.res.error })),
  servedModels, modelSource,
  signals: { inference: inferenceSignals, openWebUi: openWebUiSignals, rootIsHtml: looksLikeHtml },
  generation: chatProbe && {
    ok: chatProbe.ok, ms: Math.round(chatProbe.ms), error: chatProbe.error,
    finishReason: chatProbe.finishReason, model: chatProbe.model,
    promptTokens: chatProbe.promptTokens, completionTokens: chatProbe.completionTokens,
    reasoningOnly: chatProbe.reasoningOnly,
  },
  suggested: { LOCAL_AI_BASE_URL: suggestedBase, LOCAL_AI_MODEL: chatProbe?.model || chatModel || null },
});

// Exit non-zero when the thing rimpl actually needs — a working chat endpoint — did not answer.
process.exit(chatProbe && !chatProbe.ok ? 1 : 0);
