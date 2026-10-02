#!/usr/bin/env node
// judge-local.mjs — run the on-prem model as a JUDGE over blinded packets from judge-packet.mjs, and
// write results that judge-merge.mjs accepts.
//
// Why: C-2 in docs/QUALITY-GATES.md needs at least one non-Claude judge whenever a Claude arm is
// compared. A local-model judge may in turn favour the local arm; judge-merge prints that caveat.
// A clinician's review (C-3) decides either way.
//
// One chat completion per packet:
//   system = a short contract + JUDGE-INSTRUCTIONS.md + rubric.md (embedded ONCE, here, not per packet)
//            + results.schema.json (minified);
//   user   = the packet, BLINDED by whitelist (blindView), + an answer template for its slots.
// The reply is parsed as ONE JSON object, the runner adds packet_id / judge_id / judge_kind / schema,
// and the line is validated by hand against results.schema.json AND judge-merge's own rules. An
// invalid reply gets ONE corrective retry; both attempts are recorded in the run log.
//
// BLINDING: the runner never opens key.do-not-share.json. A packet reaches the model only through
// blindView(), which copies named fields and drops everything else, so a field added to packets later
// cannot leak by default. The packet's own embedded rubric is dropped too (it is in the system prompt).
//
// Transport: scripts/probe/lib.mjs chatCompletion — the same `${LOCAL_AI_BASE_URL}/chat/completions`
// join as tutor-audit and rimpl's providers/local.js.
//
// Usage:
//   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… [LOCAL_AI_API_KEY=…] node scripts/quality/judge-local.mjs <packet-dir>
//     --out <file.jsonl>     results (default <packet-dir>/results-local.jsonl); the run log is
//                            <out>.runlog.jsonl and the run's provenance <out>.meta.json
//     --resume               skip packets that already have a valid line in --out
//     --limit <n>            judge at most n packets this run (after --resume skipping)
//     --concurrency <n>      1 (default) or 2; the box decodes ~60 s per call
//     --max-tokens <n>       per call (default 4000)   --temperature <t>   (default 0)
//     --judge-id <id>        default "judge-local" (neutral: never a vendor or model name)
//     --dry-run              print prompt sizes for the selected packets; send nothing, write nothing
//   PROBE_TIMEOUT_MS (default 180000) bounds each call.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import {
  readConfig, chatCompletion, parseArgs, intArg, floatArg, fail, hr, dim, red, green, yellow, printTarget,
} from '../probe/lib.mjs';
import { DIMENSIONS, RESULT_SCHEMA } from './judge-packet.mjs';
import { validateResult } from './judge-merge.mjs';

export const JUDGE_ID = 'judge-local';
export const JUDGE_KIND = 'local-model';
export const INPUT_FILES = { packets: 'packets.jsonl', rubric: 'rubric.md', schema: 'results.schema.json', instructions: 'JUDGE-INSTRUCTIONS.md' };
const KEY_FILE = 'key.do-not-share.json';

/* ---------------------------------------------------------------- blinding */

const ITEM_FIELDS = ['id', 'mode', 'specialty', 'physician_language', 'expected_reply_language', 'conversation',
  'expected_behaviour', 'key_facts', 'must_not', 'sources'];

/** The ONLY view of a packet the model sees: named fields copied, everything else dropped. */
export function blindView(packet) {
  const item = packet.item ?? {};
  return {
    item: Object.fromEntries(ITEM_FIELDS.filter((k) => k in item).map((k) => [k, item[k]])),
    replies: (packet.replies ?? []).map((r) => ({ slot: r.slot, text: r.text })),
    applicable_dimensions: packet.applicable_dimensions ?? [],
    must_flag_codes: packet.must_flag_codes ?? [],
  };
}

/* ----------------------------------------------------------------- prompts */

export function buildSystemPrompt({ instructions, rubric, schema }) {
  return [
    'You are a strict, blinded judge. You receive ONE packet per message as JSON (instead of a packets.jsonl file).',
    'Answer with ONE JSON object and nothing else: no prose, no code fence. Give only the fields',
    '"scores", "must_flags", "preference" and "rationale"; the runner adds packet_id, judge_id, judge_kind and schema.',
    'Keep "rationale" to at most two sentences.',
    '',
    instructions.trim(),
    '',
    '# Rubric (rubric.md)',
    '',
    rubric.trim(),
    '',
    '# Result schema (results.schema.json, minified)',
    '',
    JSON.stringify(schema),
  ].join('\n');
}

/** A filled-in shape for this packet: applicable dimensions as <0-3>, the rest null. */
export function answerTemplate(view) {
  const slotScores = Object.fromEntries(DIMENSIONS.map((d) => [d, view.applicable_dimensions.includes(d) ? '<0-3>' : null]));
  const slots = view.replies.map((r) => r.slot);
  return JSON.stringify({
    scores: Object.fromEntries(slots.map((s) => [s, slotScores])),
    must_flags: Object.fromEntries(slots.map((s) => [s, []])),
    preference: slots.length === 2 ? '<"A" | "B" | "tie">' : null,
    rationale: '<at most two sentences>',
  });
}

export function buildUserPrompt(packet) {
  const view = blindView(packet);
  return `PACKET:\n${JSON.stringify(view)}\n\nANSWER TEMPLATE (replace every <…>; keep every null as null):\n${answerTemplate(view)}`;
}

export function correctivePrompt(errors) {
  return 'Your answer could not be used:\n- ' + errors.slice(0, 8).join('\n- ') +
    '\nReply again with ONLY the corrected JSON object (fields scores, must_flags, preference, rationale).';
}

/* ------------------------------------------------------------------ parsing */

/** The first balanced top-level JSON object in a reply, ignoring <think> blocks and code fences. */
export function extractJsonObject(text) {
  const s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return { ok: true, value: JSON.parse(s.slice(start, i + 1)) }; } catch { break; }
      }
    }
  }
  return { ok: false, error: 'no parseable JSON object in the reply' };
}

/* --------------------------------------------------------------- validation */

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** By-hand JSON Schema check, for the keywords results.schema.json uses. Returns error strings. */
export function validateSchema(value, schema, at = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  if ('const' in schema && value !== schema.const) errs.push(`${at} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((x) => x === value)) errs.push(`${at} must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const t = typeOf(value);
    const okType = allowed.includes(t) || (t === 'integer' && allowed.includes('number'));
    if (!okType) { errs.push(`${at} must be ${allowed.join(' or ')} (got ${t})`); return errs; }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${at} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validateSchema(v, schema.items, `${at}[${i}]`)));
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}.${k} is required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errs.push(...validateSchema(v, props[k], `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k} is not allowed`);
    }
  }
  return errs;
}

/** Assemble the result line from the model's object, then check it against the schema AND merge's rules. */
export function toResult(obj, packet, { schema, judgeId = JUDGE_ID }) {
  const pairwise = (packet.replies ?? []).length === 2;
  const rec = {
    schema: RESULT_SCHEMA,
    packet_id: packet.packet_id,
    judge_id: judgeId,
    judge_kind: JUDGE_KIND,
    scores: obj?.scores,
    must_flags: obj?.must_flags,
    preference: pairwise ? obj?.preference : (obj?.preference ?? null),
    ...(obj?.rationale !== undefined ? { rationale: obj.rationale } : {}),
  };
  // A slot-only key (no arm in it) so merge's validator knows which slots this packet has.
  const slotKey = { packets: { [packet.packet_id]: { slots: Object.fromEntries((packet.replies ?? []).map((r) => [r.slot, '-'])) } } };
  const errors = [
    ...validateSchema(rec, schema),
    ...validateResult(rec, { key: slotKey, packetsById: new Map([[packet.packet_id, packet]]) }),
  ];
  return { rec, errors: [...new Set(errors)] };
}

/* --------------------------------------------------------------- one packet */

function attemptRecord(r, parsed, errors) {
  return {
    ok: !!r.ok, ms: r.ms == null ? null : Math.round(r.ms), status: r.status ?? null, error: r.error ?? null,
    finish_reason: r.finishReason ?? null, prompt_tokens: r.promptTokens ?? 0, completion_tokens: r.completionTokens ?? 0,
    response_model: r.model ?? null, reasoning_only: !!r.reasoningOnly,
    parsed: !!parsed, errors,
    ...(errors.length ? { text: r.text ?? '' } : {}),
  };
}

/**
 * Judge one packet: one call, and ONE corrective retry if the reply is not a valid result.
 * `complete({systemPrompt, messages, maxTokens, temperature})` is the transport (stubbed in tests).
 * @returns {{result: object|null, log: object}}
 */
export async function judgePacket(packet, complete, { system, schema, maxTokens = 4000, temperature = 0, judgeId = JUDGE_ID }) {
  const user = buildUserPrompt(packet);
  const attempts = [];
  const tryOnce = async (messages) => {
    const r = await complete({ systemPrompt: system, messages, maxTokens, temperature });
    if (!r.ok) { attempts.push(attemptRecord(r, false, [`transport: ${r.error}`])); return { transport: true }; }
    const errs = [];
    if (r.reasoningOnly) errs.push('reasoning only, no answer text');
    if (r.finishReason === 'length') errs.push('reply truncated at max_tokens');
    const parsed = extractJsonObject(r.text);
    if (!parsed.ok) errs.push(parsed.error);
    const out = parsed.ok ? toResult(parsed.value, packet, { schema, judgeId }) : null;
    if (out) errs.push(...out.errors);
    attempts.push(attemptRecord(r, parsed.ok, errs));
    return { text: r.text ?? '', errors: errs, rec: out?.rec ?? null };
  };

  const first = await tryOnce([{ role: 'user', content: user }]);
  let final = first;
  let retry = null;
  if (!first.transport && first.errors.length) {
    retry = { reason: first.errors.slice(0, 3).join('; ') };
    final = await tryOnce([
      { role: 'user', content: user },
      { role: 'assistant', content: first.text },
      { role: 'user', content: correctivePrompt(first.errors) },
    ]);
  }
  const ok = !final.transport && final.errors.length === 0;
  return {
    result: ok ? final.rec : null,
    log: {
      packet_id: packet.packet_id,
      status: ok ? (retry ? 'valid-after-retry' : 'valid') : (final.transport ? 'transport-error' : 'invalid'),
      retry, attempts,
    },
  };
}

/* --------------------------------------------------------------------- main */

/** Read the four judge-facing files. key.do-not-share.json is never opened. */
export async function loadJudgeInputs(dir) {
  const read = (f) => readFile(path.join(dir, f), 'utf8');
  const packets = (await read(INPUT_FILES.packets)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return {
    packets,
    rubric: await read(INPUT_FILES.rubric),
    schema: JSON.parse(await read(INPUT_FILES.schema)),
    instructions: await read(INPUT_FILES.instructions),
  };
}

async function readDone(file) {
  if (!existsSync(file)) return new Set();
  const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
  return new Set(lines.map((l) => { try { return JSON.parse(l).packet_id; } catch { return null; } }).filter(Boolean));
}

async function main() {
  const { flags, positional } = parseArgs();
  // parseArgs gives a bare flag the next word as its value; these flags take none, so hand it back.
  for (const b of ['resume', 'dry-run']) if (typeof flags[b] === 'string') { positional.push(flags[b]); flags[b] = true; }
  const dir = positional[0];
  if (!dir) fail('usage: node scripts/quality/judge-local.mjs <packet-dir> [--out f.jsonl] [--resume] [--limit n] [--concurrency 1|2] [--dry-run]');
  if (path.basename(dir) === KEY_FILE) fail('give the packet DIRECTORY, not the key: the judge must never see key.do-not-share.json');
  const out = flags.out && flags.out !== true ? String(flags.out) : path.join(dir, 'results-local.jsonl');
  const runlog = `${out}.runlog.jsonl`;
  const metaFile = `${out}.meta.json`;
  let concurrency = Math.max(1, intArg(flags, 'concurrency', 1));
  if (concurrency > 2) { console.log(yellow(`  --concurrency ${concurrency} capped at 2: the box decodes one long reply at a time`)); concurrency = 2; }
  const limit = intArg(flags, 'limit', Infinity);
  const maxTokens = intArg(flags, 'max-tokens', 4000);
  const temperature = floatArg(flags, 'temperature', 0);
  const judgeId = flags['judge-id'] && flags['judge-id'] !== true ? String(flags['judge-id']) : JUDGE_ID;

  const inputs = await loadJudgeInputs(dir);
  const system = buildSystemPrompt(inputs);
  const done = flags.resume ? await readDone(out) : new Set();
  if (!flags.resume && !flags['dry-run'] && existsSync(out)) fail(`${out} exists — pass --resume to continue it, or --out a new file`);
  const todo = inputs.packets.filter((p) => !done.has(p.packet_id)).slice(0, limit);

  if (flags['dry-run']) {
    hr('judge-local — DRY RUN (nothing is sent, nothing is written)');
    const sizes = todo.map((p) => buildUserPrompt(p).length);
    console.log(`  system prompt ${system.length} chars (rubric embedded once) · ${todo.length} packet(s) · user prompt ${Math.min(...sizes)}–${Math.max(...sizes)} chars`);
    console.log(`  ${dim('rough tokens per call: (system + user chars) / 3 for mixed Thai/English — check it fits the box context')}`);
    return;
  }

  const cfg = readConfig({ needModel: true });
  printTarget(cfg, { packets: `${todo.length} to judge${done.size ? ` (${done.size} already done)` : ''}`, concurrency: String(concurrency) });
  const complete = (req) => chatCompletion(cfg, req);
  const meta = {
    schema: 'clics-tutor-judge-local-run/v1',
    started_at: new Date().toISOString(),
    judge_id: judgeId, judge_kind: JUDGE_KIND,
    model_requested: cfg.model,
    endpoint: 'LOCAL_AI_BASE_URL (not recorded: the address of the on-prem box stays out of committed files)',
    system_prompt_sha: createHash('sha256').update(system).digest('hex').slice(0, 12),
    rubric_version: inputs.packets[0]?.rubric_version ?? null,
    max_tokens: maxTokens, temperature, concurrency,
  };

  const counts = { valid: 0, 'valid-after-retry': 0, invalid: 0, 'transport-error': 0 };
  const models = new Set();
  let next = 0;
  let writing = Promise.resolve();
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const { result, log } = await judgePacket(p, complete, { system, schema: inputs.schema, maxTokens, temperature, judgeId });
      counts[log.status] += 1;
      for (const a of log.attempts) if (a.response_model) models.add(a.response_model);
      writing = writing.then(async () => {
        if (result) await appendFile(out, JSON.stringify(result) + '\n', 'utf8');
        await appendFile(runlog, JSON.stringify({ at: new Date().toISOString(), ...log }) + '\n', 'utf8');
      });
      const tag = log.status.startsWith('valid') ? green('✔') : red('✘');
      console.log(`  ${tag} ${p.packet_id}  ${log.status}${log.retry ? dim(` (retry: ${log.retry.reason.slice(0, 80)})`) : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  await writing;
  await writeFile(metaFile, JSON.stringify({ ...meta, finished_at: new Date().toISOString(), models_reported: [...models], counts }, null, 2) + '\n', 'utf8');

  hr('summary');
  console.log(`  valid ${counts.valid} · valid after retry ${counts['valid-after-retry']} · invalid ${counts.invalid} · transport errors ${counts['transport-error']}`);
  console.log(`  models reported: ${[...models].join(', ') || '—'}${models.size > 1 ? red('  (MORE THAN ONE)') : ''}`);
  if (counts.invalid || counts['transport-error']) console.log(`  re-run with --resume to retry the packets that have no line in ${out}`);
  console.log(`  next: node scripts/quality/judge-merge.mjs --key ${path.join(dir, KEY_FILE)} --packets ${path.join(dir, INPUT_FILES.packets)} ${out} <other judges' results…>`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) await main();
