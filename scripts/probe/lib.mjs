// Shared plumbing for the Gate 0 probe harness (docs/LOCAL-MODEL-ROADMAP.md, Phase 0).
//
// WHY THIS DOES NOT CALL rimpl/src/services/providers/local.js
// -----------------------------------------------------------
// That module is the production transport (implemented in providers/local-factory.js), and it is
// deliberately defensive: it caps concurrency (LOCAL_MAX_CONCURRENCY, default 2 — getRunner() in
// createLocalProvider), retries retryable failures with backoff, and normalises `finish_reason`
// into the Anthropic vocabulary. Every one of those behaviours DESTROYS a measurement:
//   * a retrying client turns a 30% failure rate into an apparent 0% one — the exact number Gate 0
//     exists to find;
//   * a concurrency cap makes every level above it unmeasurable (a 32-way level would silently
//     measure the cap);
//   * a normalised stop reason hides whether the server said `length` or `stop`.
// So the probes speak the raw OpenAI-compatible protocol here: no retries, no queue, raw
// finish_reason preserved alongside the mapped one. Everything that must stay single-source — the
// PIS-7 prompt, the examiner prompt, parseJsonObject, hasCitation/extractSocraticQuestion,
// flattenForPrompt — is IMPORTED from rimpl, never copied.
//
// The URL join below (`${LOCAL_AI_BASE_URL}/chat/completions`) is intentionally identical to
// providers/local.js. That is what makes Gate 0 transferable: the base URL that passes here is the
// literal string that goes into rimpl's env.
//
// PII: nothing in this file de-identifies anything. json-contract.mjs runs fixtures through rimpl's
// own flattenForPrompt/deriveHintTokens before any bytes leave the machine; this module is a dumb
// transport, exactly like the provider it mirrors.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The reasoning-markup rule production applies to every local reply — IMPORTED, never copied, so a
// measurement judges the text rimpl would actually return. rimpl/src/lib/think-markup.js has no
// require() at all (this job has no npm install); providers/local-factory.js re-exports the same
// functions, but loading it would also load provider-settings.js and its env validation.
const requireCjs = createRequire(import.meta.url);
const { stripThink, closesThink, flagOn, createThinkFilter } = requireCjs('../../rimpl/src/lib/think-markup.js');
export { stripThink, closesThink, flagOn, createThinkFilter };
// How a `thinking` request becomes body fields (chat_template_kwargs / think) — the SAME package-free
// module the production transport uses (providers/local-factory.js), so an audit arm that asks for
// thinking on or off sends the server exactly what rimpl would.
const { thinkingFields, thinkingEnabled, parseThinkingStyle } = requireCjs('../../rimpl/src/lib/thinking-control.js');
export { thinkingFields, thinkingEnabled, parseThinkingStyle };

// The Claude model production pins: rimpl/src/lib/provider-policy.js ANTHROPIC_MODEL, the id
// providers/anthropic.js sends (its MODEL is this constant). IMPORTED — package-free — so a cloud arm can
// never compare against a model production does not use. Until 2026-10-15 the probes regex-scraped the
// first claude-* string out of providers/anthropic.js, which a comment in that file could satisfy.
export const { ANTHROPIC_MODEL: PRODUCTION_CLOUD_MODEL } = requireCjs('../../rimpl/src/lib/provider-policy.js');

export const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
export const RIMPL_DIR = path.join(REPO_ROOT, 'rimpl');

/* ------------------------------------------------------------------ output */

const TTY = process.stdout.isTTY;
const c = (code) => (s) => (TTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));
export const bold = c('1');
export const dim = c('2');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');

export const PASS = () => green('PASS');
export const FAIL = () => red('FAIL');
export const WARN = () => yellow('WARN');

export function hr(title = '') {
  const line = '─'.repeat(Math.max(4, 78 - (title ? title.length + 3 : 0)));
  console.log(title ? `\n${bold(title)} ${dim(line)}` : dim('─'.repeat(78)));
}

/** Print a clear operator-facing error and exit. Never let a probe die on a raw stack trace: these
 *  are run by a human on a lab network, often once, and a stack trace tells them nothing. */
export function fail(message, code = 2) {
  console.error(`\n${red('✖')} ${message}\n`);
  process.exit(code);
}

/* ------------------------------------------------------------------ config */

const envHelp = (prefix) => `
Set these before running (never committed, never defaulted to an IP by these scripts):

  export ${prefix}BASE_URL=http://<dgx-tailscale-ip>:<port>/v1   # include the /v1 prefix
  export ${prefix}MODEL='<model-id-exactly-as-the-server-reports-it>'
  export ${prefix}API_KEY=<token>                                # optional; many servers need none

${prefix}BASE_URL must be the value rimpl would use: rimpl's providers/local-factory.js appends
"/chat/completions" and "/models" to it, so the URL normally ends in /v1.
Run  node scripts/probe/discover.mjs  first — it finds the port, the path prefix and the model id.`;

/**
 * Read probe config from the environment.
 *
 * `prefix` names the rimpl provider instance whose variables are read: 'LOCAL_AI_' (default) is the
 * evaluator (`local`, providers/local.js), 'LOCAL_TUTOR_AI_' the tutor (`local-tutor`). Either way they
 * are the very variables that instance reads, so the base URL that passes here is the literal string
 * that goes into rimpl's env.
 * @param {{needModel?: boolean, prefix?: string}} opts
 */
export function readConfig({ needModel = true, prefix = 'LOCAL_AI_' } = {}) {
  const ENV_HELP = envHelp(prefix);
  const rawBase = String(process.env[`${prefix}BASE_URL`] || '').trim();
  if (!rawBase) {
    fail(`${prefix}BASE_URL is not set — the probe has no endpoint to talk to.\n${ENV_HELP}`);
  }
  let url;
  try {
    url = new URL(rawBase);
  } catch {
    fail(`${prefix}BASE_URL is not a valid URL: ${JSON.stringify(rawBase)}\n${ENV_HELP}`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    fail(`${prefix}BASE_URL must be http:// or https:// (got ${url.protocol}//).\n${ENV_HELP}`);
  }

  const model = String(process.env[`${prefix}MODEL`] || '').trim();
  if (needModel && !model) {
    fail(`${prefix}MODEL is not set — the probe does not guess a model id.\n${ENV_HELP}`);
  }

  const baseUrl = rawBase.replace(/\/+$/, '');
  return {
    prefix,
    baseUrl,
    origin: url.origin,
    model,
    apiKey: process.env[`${prefix}API_KEY`] || '',
    // Deliberately NOT <prefix>TIMEOUT_MS: that is rimpl's production ceiling. A probe wants its own,
    // usually longer, budget — a cold model load can take minutes on first request.
    timeoutMs: Math.max(1000, parseInt(process.env.PROBE_TIMEOUT_MS || '180000', 10)),
    // The SAME variable the rimpl instance reads (providers/local-factory.js): set it as the server is
    // configured, and the measurement strips reasoning exactly as production does. See chatCompletion.
    thinkPreopened: flagOn(process.env[`${prefix}THINK_PREOPENED`]),
    // How a `thinking` request reaches this server, as rimpl would send it (lib/thinking-control.js):
    // 'none' when unset, null when set to something that is not a style (production then sends nothing
    // and warns; a caller that needs thinking control refuses on null — see tutor-audit.mjs).
    thinkingStyle: parseThinkingStyle(process.env[`${prefix}THINKING_STYLE`]),
  };
}

/** Banner every probe prints, so the operator can see exactly what is being hit before it runs. */
export function printTarget(cfg, extra = {}) {
  hr('target');
  console.log(`  base URL     ${cfg.baseUrl}`);
  console.log(`  chat endpoint ${cyan(`${cfg.baseUrl}/chat/completions`)}   ${dim('(same join rimpl uses)')}`);
  if (cfg.model) console.log(`  model        ${cfg.model}`);
  console.log(`  api key      ${cfg.apiKey ? dim('set (' + cfg.apiKey.length + ' chars)') : dim('none')}`);
  console.log(`  timeout      ${cfg.timeoutMs} ms`);
  const prefix = cfg.prefix || 'LOCAL_AI_';
  console.log(`  think block  ${cfg.thinkPreopened ? `pre-opened by the template (${prefix}THINK_PREOPENED=1)` : dim(`model-opened (${prefix}THINK_PREOPENED unset)`)}`);
  if (cfg.thinkingStyle && cfg.thinkingStyle !== 'none') console.log(`  thinking     ${cfg.thinkingStyle} (${prefix}THINKING_STYLE)`);
  for (const [k, v] of Object.entries(extra)) console.log(`  ${k.padEnd(12)} ${v}`);
  if (!/\/v\d+$/.test(cfg.baseUrl) && !/\/api$/.test(cfg.baseUrl)) {
    console.log(dim(`  note: base URL does not end in a version prefix (e.g. /v1). If the chat`));
    console.log(dim(`        endpoint above 404s, that is almost certainly why.`));
  }
}

/* -------------------------------------------------------------------- http */

/**
 * One HTTP request. NEVER throws — a probe reports failures, it does not crash on them.
 * @returns {Promise<{ok:boolean,status:number|null,statusText:string,headers:Headers|null,
 *                    json:any,text:string,ms:number,error:string|null}>}
 */
export async function http(url, { method = 'GET', body, timeoutMs = 30000, apiKey, accept = 'application/json' } = {}) {
  const headers = { accept };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — the raw text is the signal */ }
    return {
      ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers,
      json, text, ms: performance.now() - t0, error: null,
    };
  } catch (e) {
    const code = e?.code || e?.cause?.code || '';
    return {
      ok: false, status: null, statusText: '', headers: null, json: null, text: '',
      ms: performance.now() - t0,
      error: `${e?.name === 'TimeoutError' ? 'timeout' : (code || e?.name || 'error')}: ${e?.message || String(e)}`,
    };
  }
}

// OpenAI `finish_reason` → Anthropic `stop_reason`. MIRRORS rimpl/src/services/providers/local.js
// (FINISH_REASON). Kept as a copy only because that module does not export it; if the production
// map changes, change this one too. The probe reports BOTH the raw and the mapped value, because
// evaluate.js branches on the mapped one ('max_tokens' = truncated, needs headroom; 'end_turn' =
// the model finished without emitting JSON, which a bigger ceiling cannot fix).
export const FINISH_REASON = {
  length: 'max_tokens', stop: 'end_turn', tool_calls: 'tool_use',
  function_call: 'tool_use', content_filter: 'content_filter',
};

/**
 * One non-streaming chat completion, raw: no retry, no concurrency limit. See the header comment.
 *
 * `text` is what providers/local-factory.js would RETURN for this reply: a non-string
 * `message.content` degrades to '' (never structured/reasoning content), and inline <think> markup is
 * removed by production's own stripThink — honouring `cfg.thinkPreopened` (LOCAL_AI_THINK_PREOPENED),
 * as the server-side knob does. `rawText` is the content exactly as served, kept for the checks that
 * ask what a STREAMING physician would have seen (scripts/quality/checks.mjs no_reasoning_leak).
 *
 * Deliberate difference, recorded rather than hidden: with thinkPreopened and a reply that never
 * closes its block, production THROWS (code reasoning_only, no reply at all). Here that is
 * `{ ok: true, text: '', reasoningOnly: true, reasoningUnclosed: true }` — a probe reports, it does not
 * crash, and every caller already treats reasoningOnly as its own failure class.
 *
 * `thinking` (optional) is sent exactly as rimpl's transport sends it: only when given AND
 * `cfg.thinkingStyle` names a style (lib/thinking-control.js). Absent, the body is what it always was.
 */
export async function chatCompletion(cfg, { systemPrompt, messages, maxTokens = 1024, temperature, thinking }) {
  const body = {
    model: cfg.model,
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
    max_tokens: maxTokens,
    stream: false,
  };
  if (temperature != null) body.temperature = temperature;
  Object.assign(body, thinkingFields(cfg.thinkingStyle, thinkingEnabled(thinking)));

  const r = await http(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST', body, timeoutMs: cfg.timeoutMs, apiKey: cfg.apiKey,
  });

  if (!r.ok) {
    return {
      ok: false, ms: r.ms, status: r.status,
      error: r.error || `HTTP ${r.status} ${r.statusText}: ${r.text.slice(0, 300)}`,
      text: '', finishReason: null, stopReason: null,
      promptTokens: 0, completionTokens: 0, model: null,
      // A reasoning-only reply is a distinct, very common failure on "thinking" models and must not
      // be reported as a generic error — see below.
      reasoningOnly: false,
    };
  }

  const choice = r.json?.choices?.[0];
  const content = choice?.message?.content;
  const rawText = typeof content === 'string' ? content : '';
  const preopened = !!cfg.thinkPreopened;
  const text = stripThink(rawText, { preopened });
  const raw = choice?.finish_reason ?? null;
  // A model that returns content:null plus reasoning_content (DeepSeek-style "thinking" output)
  // will look like an empty reply to rimpl. Surface it explicitly — it is a config fix (ask the
  // server to separate reasoning, or use a non-thinking variant), not a model-quality verdict.
  // Same failure, other route: content that was NOTHING BUT inline reasoning strips to ''.
  const reasoningOnly = text === '' && (
    typeof choice?.message?.reasoning_content === 'string' ||
    typeof choice?.message?.reasoning === 'string' ||
    rawText.trim() !== ''
  );
  const reasoningUnclosed = preopened && rawText !== '' && !closesThink(rawText);

  return {
    ok: true, ms: r.ms, status: r.status, error: null,
    text,
    rawText,
    thinkPreopened: preopened,
    ...(reasoningUnclosed ? { reasoningUnclosed: true } : {}),
    finishReason: raw,
    stopReason: raw ? (FINISH_REASON[raw] ?? raw) : null,
    promptTokens: r.json?.usage?.prompt_tokens ?? 0,
    completionTokens: r.json?.usage?.completion_tokens ?? 0,
    model: r.json?.model || cfg.model,
    reasoningOnly,
    raw: r.json,
  };
}

/**
 * One STREAMED chat completion (OpenAI-compatible SSE, `stream: true`), raw like chatCompletion — no
 * retry, no queue — and timed. NEVER throws.
 *
 * Two clocks, both from the moment the request is sent (ms), measured separately:
 *   ttft_reasoning_ms  the first sign the model is REASONING: a `reasoning_content` / `reasoning` delta
 *                      (vLLM / SGLang with a reasoning parser; Ollama and some gateways), or — with no
 *                      parser — inline <think> markup opening, the first piece of a pre-opened block
 *                      (cfg.thinkPreopened), or a closing tag nothing opened. Exactly the signals rimpl's
 *                      transport turns into onReasoning, i.e. the moment routes/chat.js would send the
 *                      SSE `status` {phase:'thinking'} event;
 *   ttft_content_ms    the first VISIBLE reply text: the first non-whitespace piece rimpl's own think
 *                      filter (lib/think-markup.js createThinkFilter) lets through to the physician.
 *                      Reasoning the filter withholds does not stop this clock.
 * Either is null when it never happened. `total_ms` runs to the end of the body.
 *
 * Returned beside them: `text` (what rimpl would RETURN: production's stripThink of the raw content),
 * `rawText`, `reasoning` (the reasoning_content / reasoning text, concatenated — this harness only
 * ever sends synthetic items), `usage` (the final chunk's, requested with stream_options.include_usage
 * as rimpl does; null when the server ignores that), and chatCompletion's fields (ms = total_ms,
 * finishReason, promptTokens, …) so a caller can consume either. A server that ignores `stream` and
 * answers one JSON completion is handled (`streamed: false`; both clocks are then that body's arrival).
 * A stream that stops with neither [DONE] nor a finish_reason is a failure (ok: false), as in rimpl.
 */
export async function chatCompletionStream(cfg, { systemPrompt, messages, maxTokens = 1024, temperature, thinking } = {}) {
  const body = {
    model: cfg.model,
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (temperature != null) body.temperature = temperature;
  Object.assign(body, thinkingFields(cfg.thinkingStyle, thinkingEnabled(thinking)));
  const headers = { accept: 'text/event-stream', 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const preopened = !!cfg.thinkPreopened;

  const t0 = performance.now();
  const since = () => performance.now() - t0;
  let ttftContent = null;
  let ttftReasoning = null;
  const noteReasoning = () => { if (ttftReasoning == null) ttftReasoning = since(); };
  const filter = createThinkFilter({
    emit: (t) => { if (ttftContent == null && /\S/.test(t)) ttftContent = since(); },
    onThink: noteReasoning,
    onOrphanClose: noteReasoning,
    preopened,
  });
  let rawText = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  let model = null;
  let fingerprint = null;
  let streamed = true;
  let status = null;

  // A failed call returns no text (as chatCompletion does); what had arrived stays in rawText.
  const result = (ok, error) => {
    const text = ok ? stripThink(rawText, { preopened }) : '';
    const total = since();
    return {
      ok, status, error,
      text, rawText, reasoning, thinkPreopened: preopened, streamed,
      ttft_content_ms: ttftContent, ttft_reasoning_ms: ttftReasoning, total_ms: total, usage,
      ms: total,
      finishReason: finish,
      stopReason: finish ? (FINISH_REASON[finish] ?? finish) : null,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      model: model || cfg.model,
      reasoningOnly: ok && text === '' && (reasoning !== '' || rawText.trim() !== ''),
      ...(ok && preopened && rawText !== '' && !closesThink(rawText) ? { reasoningUnclosed: true } : {}),
      raw: { system_fingerprint: fingerprint },
    };
  };

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    status = res.status;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return result(false, `HTTP ${res.status} ${res.statusText}: ${detail.slice(0, 300)}`);
    }
    if (/application\/json/i.test(res.headers.get('content-type') || '')) {
      // The server ignored `stream`: one completion, both clocks at its arrival.
      streamed = false;
      const j = await res.json();
      const msg = j?.choices?.[0]?.message ?? {};
      rawText = typeof msg.content === 'string' ? msg.content : '';
      const thought = msg.reasoning_content ?? msg.reasoning;
      if (typeof thought === 'string' && thought) { reasoning = thought; noteReasoning(); }
      if (rawText) { filter.push(rawText); filter.end(); }
      finish = j?.choices?.[0]?.finish_reason ?? null;
      usage = j?.usage ?? null;
      model = j?.model ?? null;
      fingerprint = j?.system_fingerprint ?? null;
      return result(true, null);
    }
    const decoder = new TextDecoder();
    let buf = '';
    let sawDone = false;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; continue; }
        let j;
        try { j = JSON.parse(payload); } catch { continue; }   // a keep-alive or a torn line
        if (j.error) return result(false, `stream: server error ${String(j.error.message || j.error.type || '').slice(0, 200)}`);
        if (j.model) model = j.model;
        if (j.system_fingerprint) fingerprint = j.system_fingerprint;
        if (j.usage) usage = j.usage;
        const c = j.choices?.[0];
        if (c?.finish_reason) finish = c.finish_reason;
        const thought = c?.delta?.reasoning_content ?? c?.delta?.reasoning;
        if (typeof thought === 'string' && thought) { reasoning += thought; noteReasoning(); }
        const piece = c?.delta?.content;
        if (typeof piece === 'string' && piece) { rawText += piece; filter.push(piece); }
      }
    }
    if (!sawDone && !finish) return result(false, 'stream: the reply ended before the server finished it');
    filter.end();
    return result(true, null);
  } catch (e) {
    const code = e?.code || e?.cause?.code || '';
    return result(false, `${e?.name === 'TimeoutError' ? 'timeout' : (code || e?.name || 'error')}: ${e?.message || String(e)}`);
  }
}

/* ------------------------------------------------------------------- stats */

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  // Nearest-rank. With the small sample counts a probe collects, interpolation implies a precision
  // the data does not have.
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

export const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function distribution(values) {
  const counts = new Map();
  for (const v of values) {
    const k = v === null || v === undefined ? '(none)' : String(v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export const ms = (n) => (n == null ? '—' : `${Math.round(n)} ms`);
export const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

/** Terminal display width, not `.length`. Three things break naive padding in this harness:
 *  ANSI colour codes (zero width), emoji such as ❓/🚦 (two columns), and Thai combining vowel/tone
 *  marks (zero width). Getting this wrong makes every column after the offending cell drift. */
const ANSI_RE = /\u001b\[[0-9;]*m/g;
export function dispWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) {
    const cp = ch.codePointAt(0);
    // Thai above/below vowels and tone marks stack on the preceding consonant.
    if ((cp >= 0x0e31 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e) || cp === 0x0e31) { continue; }
    // Combining marks generally.
    if (cp >= 0x0300 && cp <= 0x036f) continue;
    // CJK, Hangul, and the emoji/pictograph planes render double-width.
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff) ||
        (cp >= 0x2600 && cp <= 0x27bf)) { w += 2; continue; }
    if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / ZWJ
    w += 1;
  }
  return w;
}
const padTo = (s, width, right) => {
  const gap = ' '.repeat(Math.max(0, width - dispWidth(s)));
  return right ? gap + s : s + gap;
};

/** Minimal fixed-width table. Rows are arrays of strings; `align` is a per-column 'l' | 'r'. */
export function table(headers, rows, align = []) {
  const widths = headers.map((h, i) =>
    Math.max(dispWidth(h), ...rows.map((r) => dispWidth(r[i] ?? ''))));
  const line = (cells, style = (s) => s) => style(cells
    .map((cell, i) => padTo(String(cell ?? ''), widths[i], align[i] === 'r'))
    .join('  '));
  console.log('  ' + line(headers, bold));
  console.log('  ' + dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const r of rows) console.log('  ' + line(r));
}

/** Transient progress, only when a human is watching. Piped/redirected output stays clean — the
 *  README tells people to redirect these runs to a file. */
export function progress(text) {
  if (TTY) process.stdout.write(`  ${dim(text)}\r`);
}
export function progressDone() {
  if (TTY) process.stdout.write('\u001b[2K\r');
}

/* -------------------------------------------------------------------- args */

/** `--key value`, `--key=value`, `--flag`. Everything else is positional. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else { flags[key] = true; }
  }
  return { flags, positional };
}

export function intArg(flags, name, fallback) {
  if (flags[name] === undefined || flags[name] === true) return fallback;
  const n = parseInt(flags[name], 10);
  if (!Number.isFinite(n)) fail(`--${name} must be a number (got ${JSON.stringify(flags[name])})`);
  return n;
}

export function floatArg(flags, name, fallback) {
  if (flags[name] === undefined || flags[name] === true) return fallback;
  const n = Number(flags[name]);
  if (!Number.isFinite(n)) fail(`--${name} must be a number (got ${JSON.stringify(flags[name])})`);
  return n;
}

/** Write a machine-readable report next to the human one, when `--out <file>` is given. */
export async function writeReport(outPath, report) {
  if (!outPath || outPath === true) return;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n  report written to ${outPath}`);
}
