#!/usr/bin/env node
/*
 * What is the real input ceiling for a PLE evaluation, and does the server tell us when we cross it?
 *
 * WHY THIS EXISTS. providers/local.js:52 leaves LOCAL_AI_NUM_CTX at 0, so rimpl never sends num_ctx
 * and the SERVER decides the context window. We do not know what that window is. The comment at
 * local.js:158 records a measured 400 on the DGX under Ollama — "exceeds the available context size
 * (4096)" at 9,144 tokens — but the 26-fixture run through Open WebUI on cme-dev never errored, even
 * on a ~7,346-token transcript. Two explanations with opposite consequences:
 *
 *   1. the window is genuinely larger here            -> fine
 *   2. the server SILENTLY TRUNCATED the transcript   -> the model scored a PARTIAL PLE and returned
 *      well-formed JSON with a plausible score, and nothing downstream can tell
 *
 * (2) is the dangerous one: valid JSON, finish_reason 'stop', no error, wrong input. It would bite
 * the LONGEST episodes first — plausibly the richest ones — and it would look exactly like model
 * non-determinism in a repeatability test.
 *
 * Chat has a second capacity cost: every physician turn re-sends and prefills the whole transcript.
 * A transcript that fits an evaluation may still make interactive chat unusably slow. The chat-shaped
 * latency at each size is therefore the real cost of allowing a transcript of that length.
 *
 * HOW IT DECIDES. Two independent signals, because either alone can mislead:
 *   A. REPORTED vs SENT. usage.prompt_tokens should grow with the prompt. If it plateaus while the
 *      prompt keeps growing, the server is dropping input. A plateau is the truncation signature.
 *   B. NEEDLE RECALL. A sentinel token is planted at the START of the transcript and the model is
 *      asked to echo it. If early content was evicted, it cannot. This catches truncation even when
 *      a server reports the pre-truncation count.
 *
 * Signal A alone is not proof (a server may report post-truncation counts honestly); signal B alone
 * is not proof (a model may simply fail to follow the echo instruction). Together they separate
 * "window is big enough" from "input is being dropped".
 *
 * ============================================================================================
 * IT PRINTS NO TRANSCRIPT TEXT. Token counts, sentinel hit/miss, and fixture ids only.
 * ============================================================================================
 *
 *   node scripts/probe/context-limit.mjs
 *     --synthetic          use repeated synthetic clinical filler instead of real fixtures
 *     --sizes <list>       synthetic sizes (default: 8k,16k,24k,32k,48k,64k,96k)
 *     --shape <mode>       eval | chat | both (default: eval)
 *     --repeats <N>        calls per size/fixture × shape (default: 2)
 *     --out <file>         write per-size rows and the decision as JSON
 *     --help               print usage without reading endpoint configuration
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PROBE_DIR, bold, dim, red, green, yellow, hr, fail, readConfig, chatCompletion,
  percentile, mean, table, writeReport, parseArgs,
} from './lib.mjs';
import { PIS7_EVALUATOR_PROMPT, RIMPL_SYSTEM_PROMPT_EXAMINER } from '../../rimpl/src/lib/prompts.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';

const DEFAULT_SIZES_TEXT = '8k,16k,24k,32k,48k,64k,96k';
const DEFAULT_REPEATS = 2;
const DEFAULT_CHAT_TIMEOUT_MS = 100000;
const SHAPES = new Set(['eval', 'chat', 'both']);
const KNOWN_FLAGS = new Set(['synthetic', 'sizes', 'shape', 'repeats', 'out', 'help']);

function printHelp() {
  console.log(`Usage: node scripts/probe/context-limit.mjs [options]

With no flags, probes the three largest real fixtures and the smallest using the
PIS-7 evaluator shape. The script never prints fixture transcript text.

Options:
  --synthetic          Pad synthetic clinical text and run a size ramp (default: off)
  --sizes <list>       Comma-separated synthetic sizes; integer or k suffix per entry
                       (default: ${DEFAULT_SIZES_TEXT})
  --shape <mode>       Call shape: eval, chat, or both (default: eval)
  --repeats <N>        Positive integer calls per size/fixture × shape (default: ${DEFAULT_REPEATS})
  --out <file>         Write a JSON report (default: no report file)
  --help               Print this help and exit 0`);
}

const { flags, positional } = parseArgs();
if (flags.help !== undefined) {
  printHelp();
  process.exit(0);
}
if (positional.length) fail(`unexpected positional argument: ${JSON.stringify(positional[0])}`);
for (const name of Object.keys(flags)) {
  if (!KNOWN_FLAGS.has(name)) fail(`unknown flag --${name}; run with --help for usage`);
}

const synthetic = flags.synthetic !== undefined;
const shape = flags.shape === undefined ? 'eval' : String(flags.shape);
if (flags.shape === true || !SHAPES.has(shape)) {
  fail(`--shape must be eval, chat, or both (got ${JSON.stringify(flags.shape)})`);
}

if (flags.repeats === true || (flags.repeats !== undefined && !/^\d+$/.test(String(flags.repeats)))) {
  fail(`--repeats must be a positive integer (got ${JSON.stringify(flags.repeats)})`);
}
const repeats = flags.repeats === undefined ? DEFAULT_REPEATS : Number(flags.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1) fail('--repeats must be a positive integer');

if (flags.out === true || flags.out === '') fail('--out requires a file path');
if (!synthetic && flags.sizes !== undefined) fail('--sizes requires --synthetic');

function parseSize(value) {
  const match = /^(\d+)(k)?$/i.exec(value.trim());
  if (!match) fail(`invalid --sizes entry ${JSON.stringify(value)}; use an integer or k suffix`);
  const n = Number(match[1]) * (match[2] ? 1000 : 1);
  if (!Number.isSafeInteger(n) || n < 1) fail(`invalid --sizes entry ${JSON.stringify(value)}; size must be positive`);
  return n;
}

function parseSizes(value) {
  if (value === true || value === '') fail('--sizes requires a comma-separated list');
  const parts = String(value).split(',');
  if (!parts.length || parts.some((part) => part.trim() === '')) {
    fail('--sizes must be a comma-separated list with no empty entries');
  }
  return parts.map(parseSize);
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) fail(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

const sizes = parseSizes(flags.sizes === undefined ? DEFAULT_SIZES_TEXT : flags.sizes);
const shapes = shape === 'both' ? ['eval', 'chat'] : [shape];
const chatTimeoutMs = envPositiveInt('RIMPL_CHAT_TIMEOUT_MS', DEFAULT_CHAT_TIMEOUT_MS);
const chatLatencyLimitMs = chatTimeoutMs * 0.6;
const cfg = readConfig();

// A sentinel the model is asked to echo back. Placed FIRST, so it is the first thing a
// keep-the-tail truncation drops.
const SENTINEL = 'ZQ7X4K';
const EVAL_ECHO_RULE = `\n\nBefore the JSON, output one line exactly: SENTINEL=<the six-character code appearing immediately after "AUDIT-CODE:" at the very top of the transcript>. Then output the JSON as instructed.`;
const CHAT_ECHO_RULE = `\n\nCAPACITY PROBE: At the very start of your reply, output one line exactly: SENTINEL=<the six-character code appearing immediately after "AUDIT-CODE:" at the very top of the prior transcript context>. Then give your normal reply.`;

// Exact first synthetic physician turn from thai-probe.mjs. It contains no PII or real case material.
const THAI_PHYSICIAN_TURN = 'ผู้ป่วยชายอายุ 62 ปี มาด้วยอาการเจ็บแน่นหน้าอกขณะออกแรงมา 3 สัปดาห์ ดีขึ้นเมื่อพัก ควรนึกถึงภาวะใดบ้าง และจะประเมินความเสี่ยงก่อนส่งตรวจเพิ่มเติมอย่างไร';

function requestFor(shapeName, transcriptText) {
  const context = `AUDIT-CODE: ${SENTINEL}\n\nTRANSCRIPT:\n${transcriptText}`;
  if (shapeName === 'eval') {
    return {
      systemPrompt: PIS7_EVALUATOR_PROMPT + EVAL_ECHO_RULE,
      messages: [{ role: 'user', content: context }],
      maxTokens: 512,
      temperature: 0,
    };
  }

  return {
    systemPrompt: RIMPL_SYSTEM_PROMPT_EXAMINER + CHAT_ECHO_RULE,
    // The flattened transcript is prior context; the final user message has the same physician-turn
    // shape as rimpl's chat route and thai-probe.mjs.
    messages: [
      { role: 'assistant', content: context },
      { role: 'user', content: THAI_PHYSICIAN_TURN },
    ],
    maxTokens: 1024,
    temperature: 0,
  };
}

function safeFailure(r) {
  // Never include a response body: a misbehaving server could echo transcript input in its error.
  return r.status == null ? 'request failed before an HTTP response' : `HTTP ${r.status}`;
}

async function probeOnce(label, transcriptText, estTokens, shapeName, repeat) {
  const request = requestFor(shapeName, transcriptText);
  const r = await chatCompletion(cfg, request);
  const responseText = r.text ?? '';
  const echoed = new RegExp(`SENTINEL\\s*=\\s*${SENTINEL}`, 'i').test(responseText);
  const sentChars = request.systemPrompt.length
    + request.messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    label,
    shape: shapeName,
    repeat,
    estTokens,
    sentChars,
    ok: r.ok !== false,
    status: r.status ?? null,
    reported: r.promptTokens || 0,
    ms: Number.isFinite(r.ms) ? r.ms : null,
    err: r.ok === false ? safeFailure(r) : null,
    echoed,
  };
}

function aggregate(label, estTokens, shapeName, calls) {
  const successfulReported = calls.filter((call) => call.ok).map((call) => call.reported);
  const latencies = calls.map((call) => call.ms).filter(Number.isFinite);
  const sentinelHits = calls.filter((call) => call.echoed).length;
  const okCount = calls.filter((call) => call.ok).length;
  return {
    label,
    estimated_tokens: estTokens,
    shape: shapeName,
    repeats: calls.length,
    sent_chars: calls[0]?.sentChars ?? 0,
    reported_prompt_tokens: calls.map((call) => call.ok ? call.reported : null),
    reported_prompt_tokens_mean: mean(successfulReported),
    reported_prompt_tokens_stable: successfulReported.length
      ? new Set(successfulReported).size === 1
      : null,
    sentinel_hits: sentinelHits,
    sentinel_all_repeats: sentinelHits === calls.length,
    ok_count: okCount,
    fail_count: calls.length - okCount,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    failure_statuses: [...new Set(calls.filter((call) => !call.ok).map((call) => call.status))],
    calls: calls.map((call) => ({
      repeat: call.repeat,
      ok: call.ok,
      status: call.status,
      reported_prompt_tokens: call.ok ? call.reported : null,
      sentinel_recalled: call.echoed,
      latency_ms: call.ms,
      error: call.err,
    })),
  };
}

function reportedDisplay(row) {
  const values = row.reported_prompt_tokens.filter(Number.isFinite);
  if (!values.length) return '—';
  if (row.reported_prompt_tokens_stable) return values.length > 1 ? `${values[0]} ×${values.length}` : String(values[0]);
  return `${Math.min(...values)}–${Math.max(...values)} !`;
}

function msDisplay(value) {
  return value == null ? '—' : `${Math.round(value)} ms`;
}

function summaryCells(row) {
  return [
    row.label,
    String(row.estimated_tokens),
    row.shape,
    reportedDisplay(row),
    `${row.sentinel_hits}/${row.repeats}`,
    `${row.ok_count}/${row.fail_count}`,
    msDisplay(row.latency_p50_ms),
    msDisplay(row.latency_p95_ms),
  ];
}

async function runItem(label, transcriptText, estTokens) {
  const itemRows = [];
  const itemCalls = [];
  for (const shapeName of shapes) {
    const calls = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      console.log(`  ${dim(`running ${label} · ${shapeName} · repeat ${repeat}/${repeats}…`)}`);
      const call = await probeOnce(label, transcriptText, estTokens, shapeName, repeat);
      calls.push(call);
      itemCalls.push(call);
    }
    const row = aggregate(label, estTokens, shapeName, calls);
    itemRows.push(row);
    console.log(`  ${row.fail_count ? red('✘') : (row.sentinel_all_repeats ? green('✔') : yellow('~'))}`
      + ` ${label} · ${shapeName}: reported ${reportedDisplay(row)}, sentinel ${row.sentinel_hits}/${row.repeats},`
      + ` ok/fail ${row.ok_count}/${row.fail_count}, p50/p95 ${msDisplay(row.latency_p50_ms)}/${msDisplay(row.latency_p95_ms)}`);
  }
  return { rows: itemRows, calls: itemCalls };
}

function legacyVerdict(calls) {
  hr('verdict');
  const good = calls.filter((call) => call.ok);
  if (!good.length) {
    console.log(`  ${red('every request failed — cannot judge the window')}`);
    return;
  }

  // Signal A: does reported prompt_tokens keep tracking the prompt we sent?
  const sorted = [...good].sort((a, b) => a.sentChars - b.sentChars);
  const maxReported = Math.max(...sorted.map((call) => call.reported));
  const plateau = sorted.filter((call) => call.reported > 0
    && maxReported > 0
    && Math.abs(call.reported - maxReported) / maxReported < 0.02);
  const growing = sorted.length > 1 && sorted[sorted.length - 1].reported > sorted[0].reported * 1.2;

  // Signal B: sentinel recall.
  const missed = good.filter((call) => !call.echoed);

  console.log(`  A · reported prompt_tokens ${growing ? green('grows with input') : red('PLATEAUS — server is dropping input')}`
    + dim(`   (max reported ${maxReported}${plateau.length > 1 ? `, ${plateau.length} calls at that ceiling` : ''})`));
  console.log(`  B · sentinel recall ${missed.length === 0 ? green('all echoed — head of prompt survived')
    : red(`${missed.length}/${good.length} LOST the head of the prompt`)}`);
  for (const miss of missed) {
    console.log(`        ${red('✘')} ${miss.label} · ${miss.shape} · repeat ${miss.repeat}`
      + ` (~${miss.estTokens} tok est, reported ${miss.reported})`);
  }

  console.log();
  if (!growing && missed.length) {
    console.log(`  ${red(bold('SILENT TRUNCATION.'))} Long PLEs are being scored on a PARTIAL transcript with no error.`);
    console.log('  Every score above the cutoff is invalid, and nothing downstream can detect it.');
    console.log('  Set LOCAL_AI_NUM_CTX, or raise the window server-side, before trusting ANY local score.\n');
  } else if (missed.length) {
    console.log(`  ${yellow(bold('Head of prompt lost on some inputs'))} while token counts still grow —`);
    console.log('  the server may report pre-truncation counts. Treat long-PLE scores as unverified.\n');
  } else if (!growing) {
    console.log(`  ${yellow('Counts plateau but the sentinel survived')} — possibly a reporting quirk rather than`);
    console.log('  truncation, or the tested range never reached the ceiling. Re-run with --synthetic.\n');
  } else {
    console.log(`  ${green(bold('No truncation detected in the tested range.'))}`);
    console.log(`  Largest verified input: ~${Math.max(...good.map((call) => call.estTokens))} tokens estimated,`);
    console.log(`  ${Math.max(...good.map((call) => call.reported))} reported by the server, sentinel intact.`);
    console.log(`  ${dim('This bounds what was tested — it does not prove the window is larger than the largest fixture.')}\n`);
  }
}

function makeDecision(rows) {
  const bySize = new Map();
  for (const row of rows) {
    if (!bySize.has(row.estimated_tokens)) bySize.set(row.estimated_tokens, []);
    bySize.get(row.estimated_tokens).push(row);
  }
  const ordered = [...bySize.entries()].sort((a, b) => a[0] - b[0]);
  const candidates = ordered.filter(([, sizeRows]) => {
    const everyShapeRecalled = shapes.every((shapeName) => {
      const row = sizeRows.find((candidate) => candidate.shape === shapeName);
      return row?.sentinel_all_repeats === true;
    });
    if (!everyShapeRecalled) return false;
    if (!shapes.includes('chat')) return true;
    const chatRow = sizeRows.find((row) => row.shape === 'chat');
    return chatRow?.latency_p95_ms != null && chatRow.latency_p95_ms < chatLatencyLimitMs;
  });
  const capEntry = candidates.at(-1) ?? null;
  const recalledEntries = ordered.filter(([, sizeRows]) => sizeRows.some((row) => row.sentinel_hits > 0));
  const lastRecallEntry = recalledEntries.at(-1) ?? null;
  const capRows = capEntry?.[1] ?? [];
  const chatAtCap = capRows.find((row) => row.shape === 'chat') ?? null;
  const evalAtCap = capRows.find((row) => row.shape === 'eval') ?? null;

  // UNITS. Three different "tokens" meet here and they are not interchangeable: this probe's size labels
  // are chars/4 of the synthetic text; rimpl's 413 backstop estimates UTF-8 bytes/3 (≈1.3× the label for
  // English, ≈3.4× for Thai, which is 3 bytes/char); the server reports its own count in
  // usage.prompt_tokens. Every SETTING recommended below is in the SERVER's unit — that is what
  // ples.context_tokens stores and what LOCAL_AI_MAX_PROMPT_TOKENS is defined in (rimpl converts its byte
  // estimate through a ratio it learns from served responses). The probe-size labels are kept alongside
  // only so a row can be found again in the table.
  const served = (rows) => {
    const vals = rows.map((row) => row.reported_prompt_tokens_mean).filter((v) => Number.isFinite(v) && v > 0);
    return vals.length ? Math.round(Math.max(...vals)) : null;
  };
  const floor1k = (v) => (v == null ? null : Math.floor(v / 1000) * 1000);
  return {
    unit_note: 'settings below are in the SERVER prompt-token unit (usage.prompt_tokens); *_probe_size is this script\'s chars/4 label',
    transcript_cap_probe_size: capEntry?.[0] ?? null,
    transcript_cap_served_prompt_tokens: served(capRows),
    ple_max_transcript_tokens: floor1k(served(capRows)),
    LOCAL_AI_MAX_PROMPT_TOKENS_probe_size: lastRecallEntry?.[0] ?? null,
    LOCAL_AI_MAX_PROMPT_TOKENS: served(lastRecallEntry?.[1] ?? []),
    chat_p95_at_cap_ms: chatAtCap?.latency_p95_ms ?? null,
    eval_p95_at_cap_ms: evalAtCap?.latency_p95_ms ?? null,
    chat_timeout_ms: chatTimeoutMs,
    chat_latency_limit_ms: chatLatencyLimitMs,
    recall_rule: 'all repeats in every requested shape',
    prompt_limit_recall_rule: 'at least one sentinel recall at the last tested size',
  };
}

function printDecision(decision) {
  hr('decision');
  console.log(`  rule · transcript cap = largest size with sentinel recalled in ALL repeats${shapes.includes('chat')
    ? ` and chat p95 < 0.6 × RIMPL_CHAT_TIMEOUT_MS (${Math.round(chatLatencyLimitMs)} ms)`
    : ' (chat shape was not run, so no chat-latency condition applies)'}`);
  console.log(`  recall · LOCAL_AI_MAX_PROMPT_TOKENS uses the last size with at least one sentinel recall`);
  console.log(`  units · settings are in the SERVER's prompt_tokens; probe-size labels (chars/4) are shown in brackets only to find the row`);
  console.log(`  setting ple_max_transcript_tokens = ${decision.ple_max_transcript_tokens ?? 'none verified'}`
    + `   (served ${decision.transcript_cap_served_prompt_tokens ?? '—'} at probe size [${decision.transcript_cap_probe_size ?? '—'}])`);
  console.log(`  env LOCAL_AI_MAX_PROMPT_TOKENS = ${decision.LOCAL_AI_MAX_PROMPT_TOKENS ?? 'none verified'}`
    + `   (served at the last recall, probe size [${decision.LOCAL_AI_MAX_PROMPT_TOKENS_probe_size ?? '—'}])`);
  console.log(`  chat p95 at the cap = ${shapes.includes('chat') ? msDisplay(decision.chat_p95_at_cap_ms) : 'not run'}`);
  console.log(`  eval p95 at the cap = ${shapes.includes('eval') ? msDisplay(decision.eval_p95_at_cap_ms) : 'not run'}`);
}

hr('PLE input ceiling — is the transcript reaching the model intact?');
console.log(`  model   ${cfg.model} @ ${cfg.baseUrl}`);
console.log(`  mode    ${synthetic ? `synthetic sizes ${sizes.join(', ')}` : 'real fixtures: largest three + smallest'}`);
console.log(`  shape   ${shape}; repeats ${repeats}`);
if (shapes.includes('chat')) {
  console.log(`  chat    timeout ${chatTimeoutMs} ms; cap threshold p95 < ${Math.round(chatLatencyLimitMs)} ms`);
}
console.log(`  ${dim('LOCAL_AI_NUM_CTX is ' + (process.env.LOCAL_AI_NUM_CTX || '0 (unset) — the SERVER chooses the window'))}\n`);

const rows = [];
const calls = [];
let rampStopped = null;

if (synthetic) {
  // Padding made of realistic clinical filler. Approximate one token as four characters, matching
  // the historical probe and the roadmap's estimated-token sizes.
  const unit = 'The patient reports no further change in symptoms since the previous review. ';
  for (const target of sizes) {
    const body = unit.repeat(Math.ceil((target * 4) / unit.length));
    const result = await runItem(`synthetic-${target}`, body, target);
    rows.push(...result.rows);
    calls.push(...result.calls);

    const failedRows = result.rows.filter((row) => row.fail_count > 0);
    if (failedRows.length) {
      const statuses = [...new Set(failedRows.flatMap((row) => row.failure_statuses))]
        .map((status) => status == null ? 'no HTTP status' : `HTTP ${status}`);
      rampStopped = {
        at_tokens: target,
        reason: 'non_ok_status',
        detail: statuses,
      };
      console.log(`  ${yellow(`ramp stopped at ${target}: non-OK status returned (${statuses.join(', ')})`)}`);
      break;
    }

    const lostRows = result.rows.filter((row) => row.sentinel_hits === 0);
    if (lostRows.length) {
      const lostShapes = lostRows.map((row) => row.shape);
      rampStopped = {
        at_tokens: target,
        reason: 'sentinel_lost_every_repeat',
        detail: lostShapes,
      };
      console.log(`  ${yellow(`ramp stopped at ${target}: sentinel lost in every repeat for ${lostShapes.join(', ')} shape`)}`);
      break;
    }
  }
} else {
  const fixturesDir = path.join(PROBE_DIR, 'fixtures');
  const files = (await readdir(fixturesDir).catch(() => [])).filter((file) => file.endsWith('.json'));
  if (!files.length) fail(`no fixtures in ${fixturesDir}`);
  const sized = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(path.join(fixturesDir, file), 'utf8'));
    const flat = flattenForPrompt(Array.isArray(raw) ? raw : raw.transcript, deriveHintTokens(raw.patient_ref ?? null));
    sized.push({ id: raw.ple_id || file.replace(/\.json$/, ''), flat });
  }
  sized.sort((a, b) => b.flat.length - a.flat.length);
  // Largest three and the smallest, so a plateau is visible against a known-small baseline.
  for (const fixture of [...sized.slice(0, 3), sized[sized.length - 1]]) {
    const estTokens = Math.round(fixture.flat.length / 4);
    const result = await runItem(fixture.id, fixture.flat, estTokens);
    rows.push(...result.rows);
    calls.push(...result.calls);
  }
}

hr('results');
table(
  ['input', 'sent est tok', 'shape', 'reported prompt_tokens', 'sentinel', 'ok/fail', 'p50', 'p95'],
  rows.map(summaryCells),
  ['l', 'r', 'l', 'r', 'r', 'r', 'r', 'r'],
);
for (const row of rows.filter((candidate) => candidate.reported_prompt_tokens_stable === false)) {
  console.log(`  ${yellow('!')} reported prompt_tokens varied across successful repeats for ${row.label} · ${row.shape}`);
}

const decision = synthetic ? makeDecision(rows) : null;

await writeReport(flags.out, {
  probe: 'context-limit',
  at: new Date().toISOString(),
  target: { baseUrl: cfg.baseUrl, model: cfg.model },
  config: {
    synthetic,
    sizes: synthetic ? sizes : null,
    shape,
    repeats,
    chat_timeout_ms: chatTimeoutMs,
    chat_latency_limit_ms: chatLatencyLimitMs,
  },
  rows,
  decision,
  ramp_stopped: rampStopped,
});

if (synthetic) {
  printDecision(decision);
} else {
  // Preserve the original two-signal fixture verdict. When only chat was requested, apply it to
  // chat calls; otherwise keep the evaluator verdict as the legacy default.
  const verdictShape = shapes.includes('eval') ? 'eval' : 'chat';
  legacyVerdict(calls.filter((call) => call.shape === verdictShape));
}
