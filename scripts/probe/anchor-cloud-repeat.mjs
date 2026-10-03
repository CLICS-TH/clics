#!/usr/bin/env node
/*
 * Cloud evaluator repeatability on the SYNTHETIC anchor cohort, with a hard spend cap.
 *
 * WHY NOT repeat-consistency.mjs. That probe reads scripts/probe/fixtures only, which build-fixtures.mjs
 * fills from REAL pilot PLEs (de-identified, but real). A paid repeatability run on a model change has no
 * reason to send real transcripts anywhere, and the probe also has no spend cap, no dry-run and records
 * no usage, so it cannot be capped. This harness does the same measurement on the anchor cohort's TUNING
 * split instead, with the same production building blocks:
 *   rimpl prompts       pis7PromptFor('anthropic')             (the shipped evaluator prompt)
 *   rimpl versions      promptVersionFor('anthropic'), RUBRIC_VERSION — stamped on the report
 *   rimpl transcript    flattenForPrompt + deriveHintTokens     (the PII strip + defang evaluate.js applies)
 *   rimpl request shape requestShape(MODEL, {purpose:'evaluate'}) + evalMaxTokensFor('anthropic')
 *   rimpl contract      lib/pis7.js scoreFromText — what routes/evaluate.js applies on anthropic
 *                       (consistency mode 'off', jsonRetries 0: an unparseable reply would be a 502)
 * and the user envelope "TRANSCRIPT:\n…". The model is read from the provider module's MODEL constant.
 *
 * HELD-OUT IS REFUSED. Only ids in SPLIT-anchors.json `tuning` (and not excluded) can be scored. The 60
 * held-out anchors were scored once and are never re-scored for a prompt (AUTHORING.md §7 item 20).
 * Every fixture's sha256 is checked against manifest.json before anything is sent.
 *
 * THE CAP IS ENFORCED BEFORE EACH ANCHOR, AT THE WORST CASE. An anchor (K calls) starts only if
 *   spent + K × (input_tokens × 1.10 × $in + max_tokens × $out) ≤ --max-usd
 * where input_tokens comes from the free /v1/messages/count_tokens endpoint (+10% margin) and max_tokens
 * is the full 16000 ceiling. A call cannot bill more output than max_tokens, so the cap holds even if
 * every call thinks to the ceiling. Spend is the response `usage`; a call that dies in transport (timeout,
 * network) has no usage and is charged at its worst case, so the recorded spend can only overstate.
 *
 *   node scripts/probe/anchor-cloud-repeat.mjs --dry-run --only anc-057,anc-007 --repeats 2
 *       # count_tokens only (free): exact input tokens, worst-case and expected cost. Sends no message.
 *   node scripts/probe/anchor-cloud-repeat.mjs --allow-paid --max-usd 0.7 --usd-per-mtok-in 2 \
 *       --usd-per-mtok-out 10 --only anc-057,anc-007 --repeats 2 --out scripts/probe/report/x.json
 *
 *   --only a,b,…        anchors, in priority order (the run stops at the first that cannot fit the cap)
 *   --repeats K         calls per anchor (default 2)
 *   --timeout-ms n      per-call timeout (default 300000 = rimpl's EVAL_TIMEOUT_MS on claude-sonnet-5-5)
 *   --env-file p        where ANTHROPIC_API_KEY is read if not in the environment (default rimpl/.env)
 *   --summarize a.json,b.json   pool finished reports of ONE instrument into one summary (sends nothing)
 *
 * IT PRINTS NO TRANSCRIPT TEXT, and the report holds numbers only by default (scripts/probe/report's
 * convention): scores, tokens, latencies, stop reasons. --keep-text also keeps each raw reply (the
 * transcripts are synthetic, so that is safe) for offline re-validation against a newer contract.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RIMPL_DIR, parseArgs, intArg, floatArg, fail, hr, dim, green, red, yellow, bold } from './lib.mjs';
import { loadAnchorSplit, splitFilter } from '../calibration/anchors/anchor-split.mjs';
import { pis7PromptFor } from '../../rimpl/src/lib/prompts.js';
import { promptVersionFor, RUBRIC_VERSION } from '../../rimpl/src/lib/versions.js';
import { flattenForPrompt } from '../../rimpl/src/lib/transcript.js';
import { deriveHintTokens } from '../../rimpl/src/services/pii-filter.js';
import { requestShape } from '../../rimpl/src/lib/anthropic-request.js';
import { evalMaxTokensFor } from '../../rimpl/src/lib/eval-decoding.js';
import { compositeOf } from '../../rimpl/src/lib/composite.js';

export const EVIDENCE_LEVEL = 'screening (synthetic tuning anchors, AI-scored, small K) — not a decisive gate';
export const INPUT_MARGIN = 1.10;   // count_tokens is an estimate; reserve 10% above it
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const ANCHORS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../calibration/anchors');

/* ------------------------------------------------------------ pure (tested) */

/** USD for a token count at per-MILLION prices. */
export const usd = (inTok, outTok, pin, pout) => (inTok * pin + outTok * pout) / 1e6;

/** The most one call can bill: the counted input with margin, and every allowed output token. */
export function worstCallUsd({ inputTokens, maxTokens, pin, pout }) {
  return usd(Math.ceil(inputTokens * INPUT_MARGIN), maxTokens, pin, pout);
}

/** May an anchor of `repeats` calls start without any outcome pushing spend over the cap? */
export function canStartAnchor({ spent, worstCall, repeats, maxUsd }) {
  return spent + repeats * worstCall <= maxUsd + 1e-12;
}

/** What a finished call is charged: its reported usage, or its worst case when there is none. */
export function chargeFor(call, { worstCall, pin, pout }) {
  if (call.usage && Number.isFinite(call.usage.input_tokens) && Number.isFinite(call.usage.output_tokens)) {
    const cacheW = call.usage.cache_creation_input_tokens ?? 0;
    const cacheR = call.usage.cache_read_input_tokens ?? 0;
    // No caching is requested (production default RIMPL_PROMPT_CACHE off); counted at full input price
    // if it ever appears, which overstates rather than understates.
    return usd(call.usage.input_tokens + cacheW + cacheR, call.usage.output_tokens, pin, pout);
  }
  if (call.httpStatus && call.httpStatus >= 400 && call.httpStatus < 600 && call.errorBody) return 0; // an API error response is not billed
  return worstCall;                                                                                  // unknown: assume the worst
}

/** Wilson 95% interval for k of n. */
export function wilson(k, n, z = 1.959963984540054) {
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { k, n, p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

/** Within-anchor spread across K scored runs: per-domain agreement counts and composite ranges. */
export function spreadSummary(rows) {
  const scored = rows.filter((r) => r.scored.length >= 2);
  let domainPairs = 0; let domainSame = 0; let domainOffBy2 = 0; let compositeSame = 0;
  const compositeRanges = [];
  for (const r of scored) {
    for (const d of DOMAINS) {
      const vals = r.scored.map((s) => s.scores[d]);
      const range = Math.max(...vals) - Math.min(...vals);
      domainPairs += 1;
      if (range === 0) domainSame += 1;
      if (range >= 2) domainOffBy2 += 1;
    }
    const comps = r.scored.map((s) => s.composite);
    const cr = Math.round((Math.max(...comps) - Math.min(...comps)) * 100) / 100;
    compositeRanges.push({ id: r.id, target: r.target_composite, composites: comps, range: cr });
    if (cr === 0) compositeSame += 1;
  }
  return {
    anchors_with_k_scored: scored.length,
    domain_exact_agreement: wilson(domainSame, domainPairs),
    domains_differing_by_2plus: domainOffBy2,
    composite_identical: wilson(compositeSame, scored.length),
    composite_ranges: compositeRanges,
    composite_range_max: compositeRanges.length ? Math.max(...compositeRanges.map((c) => c.range)) : null,
  };
}

const pct = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/* ------------------------------------------------------------------ main */

/** Pool several reports (one model, one prompt) into one summary. Sends nothing. */
export function poolReports(reports) {
  const keys = new Set(reports.map((r) => `${r.model}|${r.prompt_version}|${JSON.stringify(r.shape_sent)}|${r.max_tokens}`));
  if (keys.size !== 1) throw new Error(`cannot pool runs of different instruments: ${[...keys].join(' vs ')}`);
  const anchors = reports.flatMap((r) => r.anchors);
  const ids = anchors.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error('an anchor appears in more than one report');
  const answered = anchors.flatMap((a) => a.calls).filter((c) => c.usage);
  const sumAbs = anchors.filter((a) => a.scored.length >= 2).map((a) => ({ id: a.id,
    sum_abs_delta: DOMAINS.reduce((s, d) => { const v = a.scored.map((x) => x.scores[d]); return s + Math.max(...v) - Math.min(...v); }, 0) }));
  const sorted = sumAbs.map((x) => x.sum_abs_delta).sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null;
  return {
    reports: reports.length, anchors: anchors.length, calls: answered.length,
    spent_usd: Math.round(reports.reduce((s, r) => s + r.spent_usd, 0) * 1e6) / 1e6,
    parse_ok: wilson(answered.filter((c) => c.parse === 'ok').length, answered.length),
    invalid_json: answered.filter((c) => c.parse === 'invalid_json').length,
    refusals: answered.filter((c) => c.stop_reason === 'refusal').length,
    max_tokens_truncations: answered.filter((c) => c.stop_reason === 'max_tokens').length,
    thinking_tokens_reported_max: Math.max(...answered.map((c) => c.usage.output_tokens_details?.thinking_tokens ?? -1)),
    output_tokens_max: Math.max(...answered.map((c) => c.usage.output_tokens)),
    latency_ms: { p50: pct(answered.map((c) => c.ms), 0.5), max: Math.max(...answered.map((c) => c.ms)) },
    cost_per_eval_usd: { mean: answered.reduce((s, c) => s + c.charged_usd, 0) / answered.length, max: Math.max(...answered.map((c) => c.charged_usd)) },
    spread: spreadSummary(anchors),
    sum_abs_delta: { per_anchor: sumAbs, median, at_or_under_2: wilson(sorted.filter((v) => v <= 2).length, sorted.length) },
  };
}

async function main() {
  const { flags } = parseArgs();
  if (typeof flags.summarize === 'string') {
    const reports = await Promise.all(flags.summarize.split(',').map(async (p) => JSON.parse(await readFile(path.resolve(p.trim()), 'utf8'))));
    console.log(JSON.stringify(poolReports(reports), null, 2));
    return;
  }
  const dryRun = Boolean(flags['dry-run']);
  const repeats = Math.max(2, intArg(flags, 'repeats', 2));
  const timeoutMs = Math.max(1000, intArg(flags, 'timeout-ms', 300000));
  const only = (typeof flags.only === 'string' ? flags.only : '').split(',').map((s) => s.trim()).filter(Boolean);
  const outPath = typeof flags.out === 'string' ? path.resolve(flags.out) : null;
  const keepText = Boolean(flags['keep-text']);
  const pin = floatArg(flags, 'usd-per-mtok-in', NaN);
  const pout = floatArg(flags, 'usd-per-mtok-out', NaN);
  const maxUsd = floatArg(flags, 'max-usd', NaN);
  if (!only.length) fail('--only is required: name the tuning anchors, in priority order');
  for (const [n, v] of [['usd-per-mtok-in', pin], ['usd-per-mtok-out', pout]]) {
    if (!(v >= 0.05 && v <= 200)) fail(`--${n} must be a per-MILLION-token USD price in 0.05–200 (got ${v})`);
  }
  if (pout < pin) fail('output price below input price: check the flags');
  if (!dryRun) {
    if (!flags['allow-paid']) fail('a live run spends real API credit: pass --allow-paid (after budget approval)');
    if (!(maxUsd > 0 && maxUsd <= 5)) fail(`--max-usd is required for a live run, in (0, 5] (got ${maxUsd})`);
  }

  // Key: env, or --env-file (default rimpl/.env; a git worktree has none, so point it at the main
  // checkout's). Never printed.
  const envFile = typeof flags['env-file'] === 'string' ? path.resolve(flags['env-file']) : path.join(RIMPL_DIR, '.env');
  const envText = await readFile(envFile, 'utf8').catch(() => '');
  const fileEnv = Object.fromEntries(envText.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const apiKey = process.env.ANTHROPIC_API_KEY || fileEnv.ANTHROPIC_API_KEY;
  if (!apiKey) fail('no ANTHROPIC_API_KEY (checked env and rimpl/.env)');

  const providerSrc = readFileSync(path.join(RIMPL_DIR, 'src/services/providers/anthropic.js'), 'utf8');
  const mm = providerSrc.match(/const MODEL = '(claude-[a-z0-9.-]+)'/);
  if (!mm) fail('no MODEL constant in rimpl/src/services/providers/anthropic.js');
  const model = mm[1];
  let shape;
  try { shape = requestShape(model, { temperature: 0, purpose: 'evaluate' }); } catch (e) { fail(e.message); }
  const maxTokens = evalMaxTokensFor('anthropic');
  const systemPrompt = pis7PromptFor('anthropic');

  // Anchors: tuning split only, not excluded, sha-checked.
  const design = JSON.parse(await readFile(path.join(ANCHORS_DIR, 'design.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(ANCHORS_DIR, 'manifest.json'), 'utf8'));
  const split = await loadAnchorSplit();
  const tuning = new Set(splitFilter(design, split, 'tuning'));   // a Set of ids, §7.4 replacements included
  const heldOut = new Set(split.held_out);
  const anchors = [];
  for (const id of only) {
    if (heldOut.has(id)) fail(`${id} is HELD-OUT: never re-scored (AUTHORING.md §7 item 20)`);
    if (!tuning.has(id)) fail(`${id} is not in the tuning split`);
    const a = design.anchors.find((x) => x.id === id);
    if (!a || a.excluded) fail(`${id} is excluded or unknown`);
    const raw = await readFile(path.join(ANCHORS_DIR, 'fixtures', `${id}.json`));
    const sha = createHash('sha256').update(raw).digest('hex');
    if (sha !== manifest.fixtures[id]?.sha256) fail(`${id}: fixture sha256 does not match manifest.json`);
    const fx = JSON.parse(raw.toString('utf8'));
    anchors.push({ id, language: a.language, profile: a.profile, target_composite: a.target_composite, targets: a.targets,
      user: `TRANSCRIPT:\n${flattenForPrompt(fx.transcript, deriveHintTokens(fx.patient_ref ?? null))}` });
  }

  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const countTokens = async (body) => {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}: ${JSON.stringify(j?.error ?? j)?.slice(0, 200)}`);
    return j.input_tokens;
  };
  // count_tokens takes the same thinking/effort fields; the body is otherwise the production one.
  const countBody = (user) => ({ model, system: systemPrompt, messages: [{ role: 'user', content: user }], ...shape.fields });
  // A visible reply's own token count: counted as a user message, minus a one-character message's count.
  let replyBaseline = null;
  const countReply = async (text) => {
    if (!text) return 0;
    replyBaseline ??= await countTokens({ model, messages: [{ role: 'user', content: '.' }] });
    return (await countTokens({ model, messages: [{ role: 'user', content: text }] })) - replyBaseline;
  };

  hr(`anchor cloud repeatability — ${dryRun ? 'DRY RUN (count_tokens only, free)' : 'LIVE (paid)'}`);
  console.log(`  model   ${model} · thinking ${shape.sent.thinking ?? 'none'} · effort ${shape.sent.effort ?? 'default'} · temperature ${shape.sent.temperature ?? 'not sent'} · max_tokens ${maxTokens}`);
  console.log(`  prompt  ${promptVersionFor('anthropic')} · rubric ${RUBRIC_VERSION} · split tuning (${tuning.size} ids) · K=${repeats} · timeout ${timeoutMs / 1000}s`);
  console.log(`  price   $${pin}/$${pout} per MTok${dryRun ? '' : ` · HARD CAP $${maxUsd}`}`);

  for (const a of anchors) {
    a.input_tokens = await countTokens(countBody(a.user));
    a.worst_call_usd = worstCallUsd({ inputTokens: a.input_tokens, maxTokens, pin, pout });
  }
  console.log('\n  anchor    lang  target  input_tok  worst/call  worst/anchor');
  let cum = 0;
  for (const a of anchors) {
    cum += a.worst_call_usd * repeats;
    console.log(`  ${a.id}  ${a.language.padEnd(4)}  ${String(a.target_composite).padStart(6)}  ${String(a.input_tokens).padStart(9)}  $${a.worst_call_usd.toFixed(4)}     $${(a.worst_call_usd * repeats).toFixed(4)}  ${dim(`cumulative worst $${cum.toFixed(3)}`)}`);
  }
  const inTotal = anchors.reduce((s, a) => s + a.input_tokens, 0) * repeats;
  for (const outGuess of [3000, 6000, 10000]) {
    console.log(`  ${dim(`if every call used ${outGuess} output tokens: $${usd(inTotal, outGuess * anchors.length * repeats, pin, pout).toFixed(3)} for all ${anchors.length * repeats} calls`)}`);
  }
  if (dryRun) { console.log(`\n  dry run complete — 0 messages sent (count_tokens only).\n`); return; }

  // Production's contract, loaded only now (zod lives in rimpl/node_modules; CI has none).
  const require = (await import('node:module')).createRequire(import.meta.url);
  const { scoreFromText } = require('../../rimpl/src/lib/pis7.js');

  const report = {
    schema: 'clics-anchor-cloud-repeat/v1', evidence_level: EVIDENCE_LEVEL, started_at: new Date().toISOString(),
    model, shape_sent: shape.sent, max_tokens: maxTokens, timeout_ms: timeoutMs, prompt_version: promptVersionFor('anthropic'),
    rubric_version: RUBRIC_VERSION, split: { name: 'tuning', reserved_at: split.reserved_at }, repeats,
    prices_usd_per_mtok: { input: pin, output: pout }, max_usd: maxUsd, input_margin: INPUT_MARGIN,
    contract: 'rimpl/src/lib/pis7.js scoreFromText (routes/evaluate.js on anthropic: consistency off, jsonRetries 0)',
    caching: 'off (production default RIMPL_PROMPT_CACHE unset)', spent_usd: 0, stopped_by_cap: null, anchors: [],
  };
  const save = async () => { if (outPath) await writeFile(outPath, JSON.stringify(report, null, 2) + '\n'); };

  let spent = 0;
  let consecutiveFailures = 0;
  for (const a of anchors) {
    if (!canStartAnchor({ spent, worstCall: a.worst_call_usd, repeats, maxUsd })) {
      report.stopped_by_cap = { before: a.id, spent_usd: spent, needed_worst_usd: a.worst_call_usd * repeats, max_usd: maxUsd };
      console.log(`\n  ${yellow(`cap: ${a.id} not started — $${spent.toFixed(4)} spent + worst $${(a.worst_call_usd * repeats).toFixed(4)} > $${maxUsd}`)}`);
      break;
    }
    const row = { id: a.id, language: a.language, profile: a.profile, target_composite: a.target_composite, targets: a.targets,
      input_tokens_counted: a.input_tokens, worst_call_usd: a.worst_call_usd, calls: [], scored: [] };
    report.anchors.push(row);
    process.stdout.write(`  ${a.id} `);
    for (let k = 0; k < repeats; k++) {
      const t0 = performance.now();
      const call = { k, ms: null, httpStatus: null, stop_reason: null, refusal_category: null, usage: null,
        content_types: [], thinking_chars: 0, text_chars: 0, parse: null, scores: null, composite: null, error: null, errorBody: null, text: null };
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: a.user }], ...shape.fields }),
        });
        call.httpStatus = res.status;
        const j = await res.json().catch(() => null);
        call.ms = Math.round(performance.now() - t0);
        if (!res.ok) {
          call.error = `HTTP ${res.status}`;
          call.errorBody = j?.error?.type ?? 'unparsed';
        } else {
          call.usage = j.usage ?? null;
          call.served_model = j.model ?? null;
          call.stop_reason = j.stop_reason ?? null;
          call.content_types = (j.content ?? []).map((b) => b.type);
          call.thinking_chars = (j.content ?? []).filter((b) => b.type === 'thinking').reduce((s, b) => s + (b.thinking?.length ?? 0), 0);
          const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          call.text = text;
          call.text_chars = text.length;
          if (j.stop_reason === 'refusal') {
            const cat = j.stop_details?.category;
            call.refusal_category = typeof cat === 'string' && /^[a-z_]{1,40}$/.test(cat) ? cat : 'none';
            call.parse = 'refused';
          } else {
            try {
              const s = scoreFromText(text);
              call.parse = 'ok';
              call.scores = Object.fromEntries(DOMAINS.map((d) => [d, s.scores[d]]));
              call.composite = compositeOf(call.scores);
            } catch (e) {
              call.parse = e?.kind ?? 'error';
            }
          }
        }
      } catch (e) {
        call.ms = Math.round(performance.now() - t0);
        call.error = e?.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : `transport ${e?.name ?? 'error'}`;
      }
      const charge = chargeFor(call, { worstCall: a.worst_call_usd, pin, pout });
      call.charged_usd = charge;
      spent += charge;
      report.spent_usd = spent;
      if (call.usage) {
        // The API's own count when it reports one (usage.output_tokens_details.thinking_tokens);
        // otherwise output_tokens minus a count_tokens estimate of the visible reply.
        const reported = call.usage.output_tokens_details?.thinking_tokens;
        call.thinking_tokens = Number.isFinite(reported) ? reported : null;
        try {
          call.visible_text_tokens_est = await countReply(call.text);
          call.thinking_tokens_est = Math.max(0, call.usage.output_tokens - call.visible_text_tokens_est);
        } catch (e) { call.visible_text_tokens_est = null; call.thinking_tokens_est = null; }
      }
      if (!keepText) call.text = null;   // scripts/probe/report holds numbers only (see its README)
      row.calls.push(call);
      if (call.parse === 'ok') row.scored.push({ k, scores: call.scores, composite: call.composite });
      process.stdout.write(call.parse === 'ok' ? green('•') : red('×'));
      consecutiveFailures = call.usage ? 0 : consecutiveFailures + 1;
      await save();
      if (consecutiveFailures >= 2) { report.aborted = 'two consecutive transport/API failures'; break; }
    }
    const c = row.scored.map((s) => s.composite);
    console.log(`  composites ${c.join(', ') || '—'}  target ${a.target_composite}  ${dim(`spent $${spent.toFixed(4)}`)}`);
    if (report.aborted) break;
  }

  const calls = report.anchors.flatMap((r) => r.calls);
  const answered = calls.filter((c) => c.usage);
  report.summary = {
    calls: calls.length,
    answered: answered.length,
    parse: Object.fromEntries(['ok', 'invalid_json', 'invalid_scores', 'refused'].map((k) => [k, calls.filter((c) => c.parse === k).length])),
    parse_ok_rate: wilson(calls.filter((c) => c.parse === 'ok').length, answered.length),
    invalid_json_rate: wilson(calls.filter((c) => c.parse === 'invalid_json').length, answered.length),
    stop_reasons: answered.reduce((m, c) => { m[c.stop_reason] = (m[c.stop_reason] || 0) + 1; return m; }, {}),
    max_tokens_truncations: answered.filter((c) => c.stop_reason === 'max_tokens').length,
    refusals: answered.filter((c) => c.stop_reason === 'refusal').map((c) => c.refusal_category),
    transport_or_api_errors: calls.filter((c) => !c.usage).map((c) => c.error),
    latency_ms: { p50: pct(answered.map((c) => c.ms), 0.5), max: answered.length ? Math.max(...answered.map((c) => c.ms)) : null,
      all: answered.map((c) => c.ms), timeout_ms: timeoutMs },
    tokens: {
      input: answered.map((c) => c.usage.input_tokens),
      output: answered.map((c) => c.usage.output_tokens),
      output_max: answered.length ? Math.max(...answered.map((c) => c.usage.output_tokens)) : null,
      thinking_reported: answered.map((c) => c.thinking_tokens ?? null),
      thinking_est: answered.map((c) => c.thinking_tokens_est),
      visible_text_est: answered.map((c) => c.visible_text_tokens_est),
    },
    cost_per_eval_usd: { mean: answered.length ? spent / answered.length : null,
      max: answered.length ? Math.max(...answered.map((c) => c.charged_usd)) : null },
    spread: spreadSummary(report.anchors),
  };
  report.finished_at = new Date().toISOString();
  await save();

  hr('summary');
  const s = report.summary;
  console.log(`  calls ${s.calls} · answered ${s.answered} · parse ok ${s.parse.ok} · invalid_json ${s.parse.invalid_json} · invalid_scores ${s.parse.invalid_scores} · refused ${s.parse.refused}`);
  console.log(`  stop_reason ${JSON.stringify(s.stop_reasons)} · max_tokens truncations ${s.max_tokens_truncations}`);
  console.log(`  latency p50 ${(s.latency_ms.p50 / 1000).toFixed(1)}s · max ${(s.latency_ms.max / 1000).toFixed(1)}s (timeout ${timeoutMs / 1000}s)`);
  console.log(`  thinking tokens (API-reported) ${JSON.stringify(s.tokens.thinking_reported)}`);
  console.log(`  output tokens max ${s.tokens.output_max} of ${maxTokens} · cost/eval mean $${s.cost_per_eval_usd.mean?.toFixed(4)} max $${s.cost_per_eval_usd.max?.toFixed(4)}`);
  const sp = s.spread;
  console.log(`  domain exact agreement ${sp.domain_exact_agreement.k}/${sp.domain_exact_agreement.n} (95% ${sp.domain_exact_agreement.lo?.toFixed(2)}–${sp.domain_exact_agreement.hi?.toFixed(2)}) · ≥2 apart ${sp.domains_differing_by_2plus}`);
  console.log(`  composite identical ${sp.composite_identical.k}/${sp.composite_identical.n} · ranges ${sp.composite_ranges.map((c) => `${c.id}:${c.range}`).join(' ')}`);
  console.log(`  ${bold(`spent $${spent.toFixed(4)} of cap $${maxUsd}`)}${outPath ? ` · wrote ${path.relative(process.cwd(), outPath)}` : ''}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(red(e?.stack || String(e))); process.exit(1); });
}
