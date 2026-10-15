#!/usr/bin/env node
// tutor-audit.mjs — run the synthetic question bank through the AI TUTOR exactly as rimpl's chat
// route would, and save every reply verbatim with its provenance.
//
// This audits the TUTOR (purpose 'chat'), not the PIS-7 evaluator. It exists because the only
// earlier check, scripts/probe/thai-probe.mjs, asked 6 single-turn examiner questions, kept no
// replies, and could not tell a real citation from a fabricated one.
//
// FAITHFUL TO PRODUCTION (see request.mjs for the import-vs-replica ledger):
//   * system prompt = RIMPL_SYSTEM_PROMPT_NATURAL | _EXAMINER (+ ARTIFACT_GUIDANCE with --artifacts,
//     + EVIDENCE_GUIDANCE for the mode with --evidence-marker), or RIMPL_SYSTEM_PROMPT_RESCUE for rescue
//     items — imported from rimpl/src/lib/prompts.js;
//   * messages = chat.js buildMessages(): PII-stripped by rimpl's own filter, chief complaint
//     prefixed, physician→user, artifact fences stripped from history;
//   * the chat.js ONE corrective retry (#109): citation/❓ missing and/or a Thai turn answered in
//     English (and, with --evidence-marker, no single evidence line), ≤ 2 calls, a failed language-only
//     or evidence-only retry keeps the first reply. Both replies are kept;
//     the checks judge the FINAL one, which is what a physician sees, and `language_retry` records
//     whether the language guard's retry produced it. --no-retry measures first-pass compliance;
//   * max_tokens = CHAT_MAX_TOKENS, temperature unset (chat.js sends none);
//   * transport = scripts/probe/lib.mjs chatCompletion: the same `${LOCAL_AI_BASE_URL}/chat/completions`
//     join rimpl's providers/local.js uses, no queue, raw finish_reason kept.
//
// THE ROUTER ARMS (the fast/deep router, rimpl/src/services/router.js; docs/QUALITY-GATES.md "Before
// chat_router_enabled is switched on"). Three arms on the on-prem TUTOR (provider `local-tutor`, read
// from the same LOCAL_TUTOR_AI_* variables rimpl's local-tutor instance reads):
//   --arm local-tutor-fast     every non-rescue turn fast  (thinking:false, CHAT_MAX_TOKENS)
//   --arm local-tutor-deep     every non-rescue turn deep  (thinking:true,  CHAT_DEEP_MAX_TOKENS)
//   --arm local-tutor-routed   production's routeTurn decides, exactly as chat.js with router_enabled
// A rescue item is fast in all three (the router's first rule). Each needs
// LOCAL_TUTOR_AI_THINKING_STYLE (chat_template_kwargs | ollama): without it production would not apply
// a tier at all, and the three arms would be one. The first call of a non-rescue item is STREAMED, as a
// physician's turn is, through probe/lib.mjs chatCompletionStream, which records the two TTFT clocks
// (first reasoning signal = when chat.js would send SSE `status`; first visible text). The retry is
// not streamed, as in chat.js. Every entry carries chat.js's `middleware_flags`, and the report a
// `router_summary` (deep share with its Wilson interval, reasons, TTFT p50/p95, deadline-exceeded turns,
// and fast turns that reasoned anyway — "status on fast"). A corrective retry never thinks, as in
// chat.js. The routed arm replays the backend's sticky latch over each item's own earlier turns
// (request.mjs stickyLatch). The box address is
// recorded REDACTED for these arms. Run one job at a time on the shared box.
//
// Usage:
//   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… [LOCAL_AI_API_KEY=…] node scripts/quality/tutor-audit.mjs
//     --dry-run             print what would be sent for each selected item; send nothing, write nothing
//     --ids a,b,c           only these bank items          --limit <n>   first n (bank file order)
//     --concurrency <n>     parallel calls (default 1; the box decodes ~60 s/turn — keep it 1–2)
//     --label <name>        report name (default <arm>-<model>-<UTC stamp>)
//     --resume              reuse report/<label>.json, skip items that already have an answered reply
//     --artifacts           append ARTIFACT_GUIDANCE (the superadmin clinical_artifacts toggle)
//     --evidence-marker     append EVIDENCE_GUIDANCE (the chat_evidence_marker setting, CCME R5): every
//                           non-rescue reply must end with one GRADE evidence-level line; the retry and
//                           the evidence_marker check (checks.mjs) then apply
//     --no-retry            skip the chat.js corrective retry (first-pass compliance only)
//     --attempts <n>        transport attempts per call on a network/5xx failure (default 2; recorded)
//     --turn-deadline-ms <n> the backend's chat deadline the turn must fit (default 100000, the backend's
//                           RIMPL_CHAT_TIMEOUT_MS default; 150000 on the local stack, where the backend
//                           runs RIMPL_CHAT_TIMEOUT_MS=150000). A turn whose first call + retry
//                           (latency_ms_total) runs past it is flagged deadline_exceeded: production would
//                           have failed it closed (502). Its reply stays in the report, for inspection;
//                           the k/n with its Wilson interval is in deadline_summary (every arm) and
//                           router_summary (the router arms)
//     --arm local-tutor-fast | local-tutor-deep | local-tutor-routed   the router arms (above)
//     --arm anthropic --allow-paid   the cloud arm. OFF by default and refuses without --allow-paid:
//                           it spends real API credit (ANTHROPIC_API_KEY). Budget approval first.
//     --max-usd <x> --usd-per-mtok-in <p> --usd-per-mtok-out <q>
//                           spend ceiling, REQUIRED for the paid arm. Spend is the recorded input and
//                           output tokens of every call (first + retry) at the given prices; once it
//                           reaches <x>, no further item starts. Calls already in flight finish, so the
//                           overshoot is at most --concurrency items (each ≤ 2 calls). Prices are
//                           flags, not a table here, so they are read off the price list on the day;
//                           each must lie in 0.05–200 USD per MILLION tokens (a per-1k-token figure
//                           falls outside it), and output must not be cheaper than input.
//                           With --resume, the tokens of a failed item's earlier attempt are carried
//                           forward (`replaced_attempts_tokens`) and counted. Not counted: a call that
//                           failed in transport (an HTTP error or timeout records no usage), so the
//                           figure can sit slightly below the invoice.
//   PROBE_TIMEOUT_MS (default 180000) bounds each call.
//
// Output: scripts/quality/report/<label>.json — synthetic questions + verbatim replies, safe to keep.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readConfig, chatCompletion, chatCompletionStream, parseArgs, intArg, floatArg, fail, hr, bold, dim, cyan, yellow, red, green,
  progress, progressDone, printTarget, percentile,
} from '../probe/lib.mjs';
import { loadBank, selectItems, composition, QUALITY_DIR } from './bank.mjs';
import {
  buildChatRequest, retryDecision, retryMessages, retryReason, retryMaxTokens, optionalRetrySkipped, evidenceSplice,
  evidencePlacement, retryThinking, middlewareFlags,
  CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS, RAG_NOTE,
} from './request.mjs';
import {
  RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_RESCUE, ARTIFACT_GUIDANCE,
  EVIDENCE_GUIDANCE, promptLabel, hasCitation, extractSocraticQuestion, extractEvidenceLevel, RIMPL_FILES,
  ROUTER_VERSION, ROUTER_LABEL, ROUTER_RULES_SHA256, ROUTER_KEYWORDS_SHA256,
} from './rimpl.mjs';
import { checkReply, summarize, printSummary, CHECKS_VERSION } from './checks.mjs';
import { wilson, fmtRate } from './stats.mjs';

export const REPORT_SCHEMA = 'clics-tutor-audit/v1';
// The backend's chat deadline (backend/src/services/rimpl-client.js RIMPL_CHAT_TIMEOUT_MS, default 100 s;
// 150 s on the local stack). A turn that takes longer is a 502 in production, whatever its reply says.
export const TURN_DEADLINE_DEFAULT_MS = 100000;
export const REPORT_DIR = path.join(QUALITY_DIR, 'report');

/* --------------------------------------------------------------- arms */

/** Every arm: which provider it measures, how it drives the router (request.mjs ROUTER_MODES), and
 *  whether its first call is streamed. `thinking`: the arm's provider must honour `thinking`
 *  (the router arms refuse to run otherwise). */
export const ARMS = Object.freeze({
  local: { provider: 'local', prefix: 'LOCAL_AI_', router: 'off', thinking: false, stream: false },
  anthropic: { provider: 'anthropic', router: 'off', thinking: false, stream: false },
  'local-tutor-fast': { provider: 'local-tutor', prefix: 'LOCAL_TUTOR_AI_', router: 'fast', thinking: true, stream: true },
  'local-tutor-deep': { provider: 'local-tutor', prefix: 'LOCAL_TUTOR_AI_', router: 'deep', thinking: true, stream: true },
  'local-tutor-routed': { provider: 'local-tutor', prefix: 'LOCAL_TUTOR_AI_', router: 'routed', thinking: true, stream: true },
});

/** The local transport for an arm: streamed when the call asks for it (the router arms' first call),
 *  else the plain completion. Both are probe/lib.mjs, raw, and send `thinking` as rimpl does. */
export function localComplete(cfg, { streamImpl = chatCompletionStream, plainImpl = chatCompletion } = {}) {
  return (req) => (req.stream ? streamImpl(cfg, req) : plainImpl(cfg, req));
}

/** Why a router arm cannot run against `cfg`, or null. Without a thinking style production applies no
 *  tier (it sends no `thinking` field at all), so the fast / deep / routed arms would measure one
 *  configuration three times. */
export function armThinkingProblem(arm, cfg) {
  if (!ARMS[arm]?.thinking) return null;
  const p = cfg.prefix || 'LOCAL_TUTOR_AI_';
  if (cfg.thinkingStyle == null) return `${p}THINKING_STYLE is set but is not a style (chat_template_kwargs | ollama): rimpl would send no thinking control, so --arm ${arm} would measure nothing.`;
  if (cfg.thinkingStyle === 'none') return `--arm ${arm} needs ${p}THINKING_STYLE (chat_template_kwargs for vLLM / SGLang, ollama for Ollama): without it rimpl applies no tier, and the three router arms would be one arm.`;
  return null;
}

/** The paid arm's model, read from the production provider module so it cannot drift. */
export function productionAnthropicModel() {
  const src = readFileSync(RIMPL_FILES.anthropicProvider, 'utf8');
  const m = src.match(/const MODEL = '(claude-[a-z0-9.-]+)'/);
  if (!m) throw new Error(`no MODEL constant in ${RIMPL_FILES.anthropicProvider}`);
  return m[1];
}

/** Anthropic Messages API, same body shape as rimpl/src/services/providers/anthropic.js. Only ever
 *  constructed behind --allow-paid. `fetchImpl` is injectable for tests. */
export function makeAnthropicArm({ apiKey, model, timeoutMs, fetchImpl = fetch }) {
  return async function complete({ systemPrompt, messages, maxTokens }) {
    const t0 = performance.now();
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json().catch(() => null);
      const ms = performance.now() - t0;
      if (!res.ok) return { ok: false, ms, status: res.status, error: `HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`, text: '' };
      const text = (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return {
        ok: true, ms, status: res.status, error: null, text,
        finishReason: json?.stop_reason ?? null, stopReason: json?.stop_reason ?? null,
        promptTokens: json?.usage?.input_tokens ?? 0, completionTokens: json?.usage?.output_tokens ?? 0,
        model: json?.model || model, reasoningOnly: false, raw: { id: json?.id },
      };
    } catch (e) {
      return { ok: false, ms: performance.now() - t0, status: null, error: `${e?.name}: ${e?.message}`, text: '' };
    }
  };
}

const RETRYABLE = (r) => !r.ok && (r.status == null || r.status === 429 || r.status >= 500);

async function withAttempts(fn, attempts) {
  let r;
  const log = [];
  for (let i = 1; i <= attempts; i++) {
    r = await fn();
    if (!RETRYABLE(r) || i === attempts) break;
    log.push({ attempt: i, error: r.error });
    await new Promise((res) => setTimeout(res, 5000 * i));
  }
  return { ...r, transportAttempts: log.length + 1, transportErrors: log };
}

function callRecord(r) {
  return {
    ok: !!r.ok,
    // What production would RETURN (probe/lib.mjs chatCompletion applies rimpl's stripThink) …
    text: r.text ?? '',
    // … and the content exactly as served, for checks.mjs no_reasoning_leak (what a STREAMING
    // physician would have seen). The paid arm has no inline markup to strip, so the two are equal.
    raw_text: r.rawText ?? r.text ?? '',
    think_preopened: !!r.thinkPreopened,
    error: r.error ?? null,
    status: r.status ?? null,
    ms: r.ms == null ? null : Math.round(r.ms),
    finish_reason: r.finishReason ?? null,
    stop_reason: r.stopReason ?? null,
    prompt_tokens: r.promptTokens ?? 0,
    completion_tokens: r.completionTokens ?? 0,
    response_model: r.model ?? null,
    system_fingerprint: r.raw?.system_fingerprint ?? null,
    reasoning_only: !!r.reasoningOnly,
    transport_attempts: r.transportAttempts ?? 1,
    transport_errors: r.transportErrors ?? [],
    // A STREAMED call (the router arms' first call, probe/lib.mjs chatCompletionStream): the two TTFT
    // clocks and how much reasoning arrived. Its length only — the reasoning text is not kept.
    ...(r.streamed != null ? {
      streamed: !!r.streamed,
      ttft_reasoning_ms: r.ttft_reasoning_ms == null ? null : Math.round(r.ttft_reasoning_ms),
      ttft_content_ms: r.ttft_content_ms == null ? null : Math.round(r.ttft_content_ms),
      reasoning_chars: typeof r.reasoning === 'string' ? r.reasoning.length : 0,
    } : {}),
  };
}

/* ------------------------------------------------------------ one item */

export async function runItem(item, complete, {
  maxTokens, retry, artifacts, attempts, evidenceMarker = false,
  router = 'off', thinkingSupported = false, stream = false, deepMaxTokens = CHAT_DEEP_MAX_TOKENS,
  turnDeadlineMs = TURN_DEADLINE_DEFAULT_MS,
}) {
  const req = buildChatRequest(item, { artifacts, evidenceMarker, router, thinkingSupported, maxTokens, deepMaxTokens });
  const startedAt = new Date().toISOString();
  // chat.js: the first call at the turn's ceiling (req.maxTokens — the deep one on an applied deep tier)
  // with the tier's `thinking` field when applied; streamed when the arm streams, never on a rescue turn.
  const first = callRecord(await withAttempts(() => complete({
    systemPrompt: req.systemPrompt, messages: req.messages, maxTokens: req.maxTokens, ...req.thinkingField,
    ...(stream && !req.rescuing ? { stream: true } : {}),
  }), attempts));
  let retryRec = null;
  let final = first;
  let finalFrom = 'first';
  // chat.js (#109): ONE corrective retry, at most two calls per turn. A thrown first call ends the
  // turn (500) — no retry. Otherwise the retry fires when the citation/❓ check OR the language guard
  // fails (one prompt asks for both fixes). If the retry call itself fails: a citation retry fails
  // the turn (the first reply was not deliverable); a LANGUAGE-only (or evidence-only) retry keeps the
  // first reply. An evidence-only retry is a small line-only call whose one line is SPLICED into the
  // first reply (evidenceSplice); without a usable line the first reply stands unchanged. An optional
  // retry past the deadline cutoff is skipped (optionalRetrySkipped), as chat.js does.
  const decision = retry && first.ok ? retryDecision(first.text, req) : null;
  const skipped = decision?.fire && optionalRetrySkipped(decision, first.ms ?? 0)
    ? { reason: retryReason(decision), elapsed_ms: first.ms } : null;
  let spliced = null;
  if (decision?.fire && !skipped) {
    const reason = [
      decision.needCitation && !hasCitation(first.text) && 'no citation',
      decision.needCitation && req.socratic && !extractSocraticQuestion(first.text) && 'no ❓',
      decision.languageMismatch && 'language',
      decision.needRescue && 'rescue rules',
      decision.needEvidence && 'evidence marker',
    ].filter(Boolean).join(' + ');
    // chat.js: a retry never thinks — thinking:false (tier applied) at the FAST ceiling, even after a deep
    // first call; the marker-only call at its small cap.
    const second = callRecord(await withAttempts(() => complete({
      systemPrompt: req.systemPrompt, messages: retryMessages(req.messages, first.text, decision, req),
      maxTokens: retryMaxTokens(decision, maxTokens), ...retryThinking(req),
    }), attempts));
    retryRec = { reason, citation: decision.needCitation, language: decision.languageMismatch, rescue: decision.needRescue, evidence: decision.needEvidence, ...second };
    if (retryReason(decision) === 'evidence') {
      spliced = second.ok ? evidenceSplice(decision, first.text, second.text, req) : null;
      if (spliced) {
        final = { ...first, text: spliced.text };
        finalFrom = 'first + spliced evidence line';
      } else {
        finalFrom = second.ok
          ? 'first (the evidence retry gave no single line — chat.js keeps the first reply unchanged)'
          : 'first (evidence retry failed — chat.js keeps the first reply)';
      }
    } else if (second.ok || decision.needCitation) {
      final = second;
      finalFrom = 'retry';
    } else {
      finalFrom = 'first (language/rescue retry failed — chat.js keeps the first reply)';
    }
  } else if (skipped) {
    finalFrom = `first (${skipped.reason} retry skipped: past the deadline cutoff — chat.js delivers the first reply)`;
  }
  // Production's own response fields: the guard fired AND its retry produced the returned reply.
  const languageRetry = !!(retryRec && retryRec.language && finalFrom === 'retry');
  const evidenceRetry = !!(retryRec && retryRec.evidence && (finalFrom === 'retry' || spliced));
  // chat.js `placeMarker` (evidencePlacement): the returned reply — the first one standing, or an adopted
  // retry, never a spliced one — has its one valid marker moved into place with no model call.
  let evidenceMoved = false;
  if (final.ok && !spliced) {
    const placed = evidencePlacement(final.text, req);
    if (placed) { final = { ...final, text: placed }; evidenceMoved = true; }
  }
  const entry = {
    id: item.id,
    mode: item.mode,
    language: item.language,
    specialty: item.specialty,
    adversarial_type: item.adversarial?.type ?? null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    request: {
      prompt_version: req.promptVersion,
      socratic: req.socratic,
      rescuing: req.rescuing,
      route_language: req.language,
      evidence_marker: req.evidenceMarker,     // the guidance was on AND chat.js checks this turn
      physician_wrote_thai: decision?.physicianWroteThai ?? null,
      router: req.router,                      // request.mjs ROUTER_MODES
      sticky: req.sticky,                      // the deep_mode latch the backend would have sent
      max_tokens: req.maxTokens,               // the first call's (and a full retry's) ceiling
      thinking: req.tierApplied ? req.deep : null,   // the `thinking` field sent, or null (none sent)
      messages: req.messages,                 // AS SENT: de-identified by rimpl's filter
      identifiers_sent: req.identifiersSent,
    },
    first,
    retry: retryRec ? {
      reason: retryRec.reason, citation: retryRec.citation, language: retryRec.language, rescue: retryRec.rescue,
      evidence: retryRec.evidence,
      ok: retryRec.ok, error: retryRec.error, ms: retryRec.ms,
      // Both token counts: the retry resends the whole conversation plus the first reply, so its
      // input is the larger of the two calls' and a spend figure that omits it undercounts.
      prompt_tokens: retryRec.prompt_tokens, completion_tokens: retryRec.completion_tokens,
      // A retry whose reply is not the final one (a failed language-only retry, or the line-only
      // answer the evidence line was spliced from) keeps its text here for the record.
      // (Kept too when the adopted retry's marker was then moved: the final text is no longer its own.)
      ...(finalFrom === 'retry' && !evidenceMoved ? {} : { text: retryRec.text }),
    } : null,
    retry_skipped: skipped,                 // chat.js `retrySkipped`: an optional retry past the cutoff
    language_retry: languageRetry,          // = chat.js response field `language_retry`
    evidence_retry: evidenceRetry,          // = chat.js response field `evidence_retry`
    // chat.js moved a misplaced marker (no model call). Not a chat.js response field: on a streamed turn
    // production records it as superseded_reason 'evidence'; on a plain JSON turn it leaves no trace.
    evidence_moved: evidenceMoved,
    // = chat.js `evidence_level`: null with the marker off, on a rescue turn, or with no single line.
    evidence_level: req.evidenceMarker && final.ok ? extractEvidenceLevel(final.text) : null,
    final: { ...final, from: evidenceMoved ? `${finalFrom} + evidence line moved (no model call)` : finalFrom },
    latency_ms_total: (first.ms ?? 0) + (retryRec?.ms ?? 0),
  };
  // The backend hangs up at its chat deadline and fails the turn closed: past it, production delivers
  // NOTHING, so this reply is not one a physician would see. Kept for inspection, flagged. (A lower
  // bound on production's turn time: it leaves out rimpl's work before the call, e.g. the rescue
  // classifier, and the harness's own transport-retry waits.)
  entry.deadline_exceeded = entry.latency_ms_total > turnDeadlineMs;
  // = chat.js `middleware_flags` (the harness has no fail-over, so failed_over_from is always null).
  entry.middleware_flags = middlewareFlags(req, { evidenceLevel: entry.evidence_level });
  entry.checks = checkReply(item, entry);
  return entry;
}

/* ------------------------------------------------------------ deadline */

/** How many turns ran past the backend's chat deadline (runItem `deadline_exceeded`): k/n with its
 *  Wilson interval, over every item in the report. */
export function deadlineSummary(items, turnDeadlineMs = null) {
  const k = items.filter((e) => e.deadline_exceeded === true).length;
  return { ...(turnDeadlineMs != null ? { turn_deadline_ms: turnDeadlineMs } : {}), exceeded: wilson(k, items.length) };
}

/* -------------------------------------------------------------- router */

const msOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dist = (vals) => ({ n: vals.length, p50: percentile(vals, 50), p95: percentile(vals, 95) });

/** The router figures of a report: how often it went deep (k/n with its Wilson interval), why, and the
 *  TTFT distributions of the STREAMED first calls. `ttft_first_ms` is when the physician first sees
 *  ANYTHING — the `status` event (first reasoning signal) or the first text, whichever is earlier: the
 *  number the router's latency gate is written against (docs/QUALITY-GATES.md). Nearest-rank
 *  percentiles (probe/lib.mjs), null with no data. */
export function routerSummary(items) {
  const routed = items.filter((e) => e.middleware_flags?.tier != null);
  const deepK = routed.filter((e) => e.middleware_flags.tier === 'deep').length;
  const reasons = {};
  for (const e of routed) reasons[e.middleware_flags.reason] = (reasons[e.middleware_flags.reason] ?? 0) + 1;
  const streamed = items.filter((e) => e.first?.streamed && e.first?.ok);
  const first = (c) => {
    const seen = [msOf(c.ttft_reasoning_ms), msOf(c.ttft_content_ms)].filter((v) => v != null);
    return seen.length ? Math.min(...seen) : null;
  };
  const pick = (arr, f) => arr.map(f).filter((v) => v != null);
  const byTier = (tier) => streamed.filter((e) => e.middleware_flags?.tier === tier);
  // A FAST turn that reasoned anyway (the model ignored enable_thinking=false): chat.js sends `status`
  // on ANY reasoning signal while the router is on, so these are "thinking…" shown on a fast turn.
  const fastStreamed = byTier('fast');
  return {
    n: routed.length,
    deep: wilson(deepK, routed.length),
    reasons,
    streamed: streamed.length,
    status_on_fast: wilson(fastStreamed.filter((e) => msOf(e.first.ttft_reasoning_ms) != null).length, fastStreamed.length),
    deadline_exceeded: deadlineSummary(items).exceeded,
    ttft_first_ms: dist(pick(streamed, (e) => first(e.first))),
    ttft_content_ms: dist(pick(streamed, (e) => msOf(e.first.ttft_content_ms))),
    ttft_content_fast_ms: dist(pick(byTier('fast'), (e) => msOf(e.first.ttft_content_ms))),
    ttft_content_deep_ms: dist(pick(byTier('deep'), (e) => msOf(e.first.ttft_content_ms))),
    ttft_reasoning_ms: dist(pick(streamed, (e) => msOf(e.first.ttft_reasoning_ms))),
    total_ms: dist(pick(items.filter((e) => e.final?.ok), (e) => msOf(e.latency_ms_total))),
  };
}

/* ---------------------------------------------------------------- spend */

/** Tokens and USD recorded so far: every call's input and output (first AND retry). Reports written
 *  before the retry's prompt_tokens were recorded count 0 for it, so their figure is a lower bound. */
export function spendOf(items, { inPerMtok, outPerMtok }) {
  let inTok = 0;
  let outTok = 0;
  for (const e of items) {
    for (const c of [e.first, e.retry]) {
      if (!c) continue;
      inTok += c.prompt_tokens ?? 0;
      outTok += c.completion_tokens ?? 0;
    }
  }
  return { in_tokens: inTok, out_tokens: outTok, usd: (inTok * inPerMtok + outTok * outPerMtok) / 1e6 };
}

/** On --resume: tokens billed to attempts that are about to be replaced (failed items), plus any the
 *  prior report already carried. Counted by the spend ceiling so a re-run cannot hide them. */
export function carriedTokens(prior) {
  const now = spendOf((prior?.items ?? []).filter((e) => !e.final?.ok), { inPerMtok: 0, outPerMtok: 0 });
  return {
    in_tokens: (prior?.replaced_attempts_tokens?.in_tokens ?? 0) + now.in_tokens,
    out_tokens: (prior?.replaced_attempts_tokens?.out_tokens ?? 0) + now.out_tokens,
  };
}

// Sanity band for a per-MILLION-token price. A zero price would make every call free and the ceiling
// unreachable; a per-1k-token figure typed by mistake (e.g. 0.003) falls below the band.
export const PRICE_BAND_USD_PER_MTOK = [0.05, 200];

/** --max-usd and its two prices, validated. null when no ceiling was asked for. */
export function budgetFromFlags(flags) {
  if (flags['max-usd'] === undefined) return null;
  const maxUsd = floatArg(flags, 'max-usd', NaN);
  const inPerMtok = floatArg(flags, 'usd-per-mtok-in', NaN);
  const outPerMtok = floatArg(flags, 'usd-per-mtok-out', NaN);
  const [lo, hi] = PRICE_BAND_USD_PER_MTOK;
  if (!(maxUsd > 0)) fail('--max-usd must be a positive number of US dollars');
  if (Number.isNaN(inPerMtok) || Number.isNaN(outPerMtok)) {
    fail('--max-usd needs the prices it converts tokens with: --usd-per-mtok-in <p> --usd-per-mtok-out <q> (USD per million tokens, from the price list on the day)');
  }
  for (const [name, v] of [['usd-per-mtok-in', inPerMtok], ['usd-per-mtok-out', outPerMtok]]) {
    if (!(v >= lo && v <= hi)) {
      fail(`--${name} ${v} is outside the sanity band ${lo}–${hi} USD per MILLION tokens. A zero price disables the ceiling; a figure per 1k tokens is 1000× too small.`);
    }
  }
  if (outPerMtok < inPerMtok) fail(`--usd-per-mtok-out (${outPerMtok}) is below --usd-per-mtok-in (${inPerMtok}); output tokens are never the cheaper side — are the two swapped?`);
  return { maxUsd, inPerMtok, outPerMtok };
}

/** Run `todo` through `runOne` with `concurrency` workers. `shouldStop()` is asked before each item
 *  starts; once it says yes, no further item starts and the in-flight ones finish. */
export async function runQueue(todo, runOne, { concurrency = 1, shouldStop = () => false } = {}) {
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < todo.length) {
      if (shouldStop()) { stopped = true; return; }
      await runOne(todo[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), todo.length) }, worker));
  return { stopped, started: next };
}

/* ----------------------------------------------------------------- main */

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}
const slug = (s) => String(s || 'model').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export function promptLabels(artifacts, evidenceMarker = false) {
  const ag = artifacts ? ARTIFACT_GUIDANCE : '';
  const eg = (mode) => (evidenceMarker ? EVIDENCE_GUIDANCE[mode] : '');
  return {
    natural: promptLabel('chat', RIMPL_SYSTEM_PROMPT_NATURAL + ag + eg('natural')),
    examiner: promptLabel('chat', RIMPL_SYSTEM_PROMPT_EXAMINER + ag + eg('examiner')),
    rescue: promptLabel('chat', RIMPL_SYSTEM_PROMPT_RESCUE),
  };
}

async function main() {
  const { flags } = parseArgs();
  const arm = flags.arm && flags.arm !== true ? String(flags.arm) : 'local';
  if (!ARMS[arm]) fail(`--arm must be one of ${Object.keys(ARMS).join(' | ')} (got ${arm})`);
  const armSpec = ARMS[arm];
  // The router options every request of this arm is built with (request.mjs buildChatRequest). A router
  // arm only runs once its provider is known to honour `thinking` (armThinkingProblem, below).
  const routerOpts = { router: armSpec.router, thinkingSupported: armSpec.thinking, stream: armSpec.stream, deepMaxTokens: CHAT_DEEP_MAX_TOKENS };
  const dryRun = Boolean(flags['dry-run']);
  if (arm === 'anthropic' && !flags['allow-paid']) {
    fail('--arm anthropic spends real Anthropic API credit and is OFF by default.\n' +
      '  Get budget approval first (docs/LOCAL-AI-BUDGET-PLAN.md), then re-run with --allow-paid.');
  }
  const budget = budgetFromFlags(flags);
  const concurrency = Math.max(1, intArg(flags, 'concurrency', 1));
  const attempts = Math.max(1, intArg(flags, 'attempts', 2));
  const turnDeadlineMs = intArg(flags, 'turn-deadline-ms', TURN_DEADLINE_DEFAULT_MS);
  if (!(turnDeadlineMs > 0)) fail('--turn-deadline-ms must be a positive number of milliseconds (100000 = the backend default; 150000 on the local stack)');
  const limit = intArg(flags, 'limit', Infinity);
  const ids = flags.ids && flags.ids !== true ? String(flags.ids).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const artifacts = Boolean(flags.artifacts);
  const evidenceMarker = Boolean(flags['evidence-marker']);
  const retry = !flags['no-retry'];
  const maxTokens = CHAT_MAX_TOKENS;

  let bank;
  try { bank = await loadBank(); } catch (e) { fail(e.message); }
  let items;
  try { items = selectItems(bank.items, { ids, limit }); } catch (e) { fail(e.message); }
  if (!items.length) fail('no items selected');

  if (dryRun) {
    hr('tutor-audit — DRY RUN (nothing is sent, nothing is written)');
    console.log(`  arm ${arm}${arm === 'anthropic' ? ` (${productionAnthropicModel()})` : ''} · ${items.length} item(s) · bank ${bank.sha} · max_tokens ${maxTokens} · retry ${retry ? 'on' : 'off'} · artifacts ${artifacts ? 'on' : 'off'} · evidence marker ${evidenceMarker ? 'on' : 'off'}`);
    console.log(`  rag ${RAG_NOTE}`);
    console.log(`  turn deadline ${turnDeadlineMs} ms (a turn past it is flagged deadline_exceeded)`);
    if (armSpec.router !== 'off') {
      console.log(`  router ${armSpec.router} · ${ROUTER_LABEL} · deep max_tokens ${CHAT_DEEP_MAX_TOKENS} · ${dim(`assumes ${armSpec.prefix}THINKING_STYLE is set — a real run refuses without it`)}`);
    }
    for (const it of items) {
      const req = buildChatRequest(it, { artifacts, evidenceMarker, maxTokens, ...routerOpts });
      hr(`${it.id}  [${it.mode} · ${it.language} · ${it.specialty}${it.adversarial ? ` · ${it.adversarial.type}` : ''}]`);
      console.log(`  system  ${cyan(req.promptVersion)}  ${dim(`(${req.systemPrompt.length} chars; ${it.mode === 'rescue' ? 'RIMPL_SYSTEM_PROMPT_RESCUE' : it.mode === 'examiner' ? 'RIMPL_SYSTEM_PROMPT_EXAMINER' : 'RIMPL_SYSTEM_PROMPT_NATURAL'}${artifacts && it.mode !== 'rescue' ? ' + ARTIFACT_GUIDANCE' : ''}${evidenceMarker && it.mode !== 'rescue' ? ' + EVIDENCE_GUIDANCE' : ''})`)}`);
      console.log(`  route   socratic=${req.socratic} rescuing=${req.rescuing} language=${req.language}${req.route ? ` · tier ${req.route.tier} (${req.route.reason}) · thinking ${req.tierApplied ? req.deep : 'not sent'} · max_tokens ${req.maxTokens}${req.sticky ? ' · sticky (an earlier turn went deep)' : ''}` : ''}`);
      req.messages.forEach((m, i) => console.log(`  [${i}] ${m.role.padEnd(9)} ${m.content.replace(/\n/g, '\n            ')}`));
      if (it.identifiers?.length) {
        console.log(`  ${req.identifiersSent.length ? yellow('identifiers reaching the model: ' + req.identifiersSent.join(', ')) : green('all synthetic identifiers masked by rimpl\'s PII filter')}`);
      }
    }
    console.log(`\n  ${dim('dry run complete — 0 requests sent.')}`);
    return;
  }

  let complete;
  let target;
  if (arm === 'local') {
    const cfg = readConfig({ needModel: true });
    printTarget(cfg, { items: String(items.length), concurrency: String(concurrency) });
    complete = (req) => chatCompletion(cfg, req);
    target = { arm, provider: 'local', base_url: cfg.baseUrl, model_requested: cfg.model, timeout_ms: cfg.timeoutMs,
      think_preopened: cfg.thinkPreopened };
  } else if (armSpec.provider === 'local-tutor') {
    const cfg = readConfig({ needModel: true, prefix: armSpec.prefix });
    const problem = armThinkingProblem(arm, cfg);
    if (problem) fail(problem);
    printTarget(cfg, { items: String(items.length), concurrency: String(concurrency), router: `${armSpec.router} (${ROUTER_LABEL})` });
    complete = localComplete(cfg);
    // The box address is NOT written into the report: committed runs redact it, so these arms never
    // record it in the first place.
    target = { arm, provider: 'local-tutor', base_url: '(redacted: on-prem tutor box, LOCAL_TUTOR_AI_BASE_URL)',
      model_requested: cfg.model, timeout_ms: cfg.timeoutMs, think_preopened: cfg.thinkPreopened,
      thinking_style: cfg.thinkingStyle, router: armSpec.router };
  } else {
    if (!budget) {
      fail('--arm anthropic needs a spend ceiling: --max-usd <x> --usd-per-mtok-in <p> --usd-per-mtok-out <q>.\n' +
        '  No item starts once the recorded spend reaches <x>.');
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) fail('--arm anthropic --allow-paid needs ANTHROPIC_API_KEY in the environment.');
    const model = productionAnthropicModel();
    const timeoutMs = Math.max(1000, parseInt(process.env.PROBE_TIMEOUT_MS || '180000', 10));
    complete = makeAnthropicArm({ apiKey, model, timeoutMs });
    target = { arm, provider: 'anthropic', base_url: 'https://api.anthropic.com/v1', model_requested: model, timeout_ms: timeoutMs };
    console.log(`  ${yellow('PAID ARM')} ${model} — ${items.length} item(s), up to ${items.length * 2} calls; ceiling $${budget.maxUsd} at $${budget.inPerMtok}/$${budget.outPerMtok} per Mtok in/out.`);
  }

  const label = flags.label && flags.label !== true ? slug(flags.label) : `${arm}-${slug(target.model_requested)}-${stamp()}`;
  await mkdir(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `${label}.json`);

  let prior = null;
  if (flags.resume) {
    prior = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
    if (!prior) fail(`--resume: no report at ${file}`);
    if (prior.provenance?.bank_sha !== bank.sha) console.log(`  ${yellow('⚠')} bank changed since this report started (${prior.provenance?.bank_sha} → ${bank.sha}); resumed items keep their original wording.`);
  }
  const done = new Map((prior?.items ?? []).filter((e) => e.final?.ok).map((e) => [e.id, e]));
  const todo = items.filter((it) => !done.has(it.id));
  // A failed item is re-run and its entry replaced; the tokens its earlier attempt was billed for are
  // carried forward here so the spend figure still counts them.
  const replaced = carriedTokens(prior);

  const report = {
    schema: REPORT_SCHEMA,
    label,
    started_at: prior?.started_at ?? new Date().toISOString(),
    finished_at: null,
    target,
    provenance: {
      git_commit: gitCommit(),
      bank_sha: bank.sha,
      bank_files: bank.files,
      prompt_versions: promptLabels(artifacts, evidenceMarker),
      max_tokens: maxTokens,
      temperature: null,
      retry: retry ? `chat.js single corrective retry (citation/❓ + language guard, #109${evidenceMarker ? ' + evidence marker' : ''})` : 'off (--no-retry)',
      artifacts,
      evidence_marker: evidenceMarker,
      rag: RAG_NOTE,
      // The fast/deep router (rimpl/src/services/router.js): which rules, and the ceilings each tier ran under.
      turn_deadline_ms: turnDeadlineMs,
      router: armSpec.router === 'off' ? { mode: 'off' } : {
        mode: armSpec.router, version: ROUTER_VERSION, label: ROUTER_LABEL,
        rules_sha256: ROUTER_RULES_SHA256, keywords_sha256: ROUTER_KEYWORDS_SHA256,
        fast_max_tokens: maxTokens, deep_max_tokens: CHAT_DEEP_MAX_TOKENS, first_call_streamed: armSpec.stream,
      },
      checks_version: CHECKS_VERSION,
      synthetic: 'every question, case and identifier is invented — replies are safe to store',
    },
    composition: composition(items),
    ...(replaced.in_tokens || replaced.out_tokens ? { replaced_attempts_tokens: replaced } : {}),
    items: [...done.values()],
  };

  console.log(`  report  ${file}${done.size ? `  (resuming: ${done.size} done, ${todo.length} to go)` : ''}`);
  console.log(`  expect  ~${Math.ceil((todo.length * 70) / 60 / concurrency)} min at ~60–70 s/turn on the DGX (retries add more)\n`);

  let finished = 0;
  const order = new Map(items.map((it, i) => [it.id, i]));
  const spendNow = () => {
    if (!budget) return null;
    const s = spendOf(report.items, budget);
    const inTok = s.in_tokens + replaced.in_tokens;
    const outTok = s.out_tokens + replaced.out_tokens;
    return { in_tokens: inTok, out_tokens: outTok, usd: (inTok * budget.inPerMtok + outTok * budget.outPerMtok) / 1e6 };
  };
  const recordSpend = (stoppedEarly) => {
    if (!budget) return;
    const s = spendNow();
    report.spend = {
      max_usd: budget.maxUsd, usd_per_mtok_in: budget.inPerMtok, usd_per_mtok_out: budget.outPerMtok,
      in_tokens: s.in_tokens, out_tokens: s.out_tokens, usd: Number(s.usd.toFixed(4)), stopped_early: stoppedEarly,
      note: 'recorded tokens of every call (first + retry, plus replaced failed attempts) at the given prices — an estimate, not the invoice; transport-failed calls record no usage',
    };
  };
  const save = () => {
    report.items.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    recordSpend(report.spend?.stopped_early ?? false);
    return writeAtomic(file, report);
  };
  let saving = Promise.resolve();
  if (budget) console.log(`  spend   $${spendNow().usd.toFixed(4)} recorded so far · ceiling $${budget.maxUsd}`);
  const runOne = async (it) => {
    progress(`[${finished + 1}/${todo.length}] ${it.id}…`);
    const entry = await runItem(it, complete, { maxTokens, retry, artifacts, attempts, evidenceMarker, turnDeadlineMs, ...routerOpts });
    report.items = report.items.filter((e) => e.id !== it.id).concat(entry);
    finished += 1;
    progressDone();
    const f = entry.final;
    const crit = entry.checks.flags.filter((x) => x.severity === 'critical').map((x) => x.code);
    console.log(`  ${f.ok ? green('✔') : red('✘')} ${it.id.padEnd(30)} ${String(entry.latency_ms_total).padStart(7)} ms  ${f.completion_tokens || 0} tok${entry.retry ? dim(` (retry: ${entry.retry.reason}${entry.retry.ok ? '' : ', failed'})`) : ''}${crit.length ? '  ' + red(crit.join(',')) : ''}${f.ok ? '' : '  ' + red(f.error)}`);
    saving = saving.then(save);   // serialise writes; save after EVERY item so a crash loses one
  };
  const shouldStop = () => budget != null && spendNow().usd >= budget.maxUsd;
  const { stopped, started } = await runQueue(todo, runOne, { concurrency, shouldStop });
  await saving;
  recordSpend(stopped);
  if (stopped) {
    console.log(`\n  ${red('STOPPED by --max-usd')}: recorded spend $${spendNow().usd.toFixed(4)} ≥ $${budget.maxUsd}; ${todo.length - started} item(s) not started. Raise the ceiling and re-run with --resume.`);
  }

  report.finished_at = new Date().toISOString();
  const models = [...new Set(report.items.map((e) => e.final.response_model).filter(Boolean))];
  const fps = [...new Set(report.items.map((e) => e.final.system_fingerprint).filter(Boolean))];
  report.provenance.models_reported = models;
  report.provenance.system_fingerprints = fps;
  const bankById = new Map(bank.items.map((it) => [it.id, it]));
  const results = report.items.filter((e) => bankById.has(e.id)).map((e) => ({ id: e.id, language: e.language, mode: e.mode, result: e.checks }));
  report.checks_summary = summarize(results);
  report.deadline_summary = deadlineSummary(report.items, turnDeadlineMs);
  if (armSpec.router !== 'off') report.router_summary = routerSummary(report.items);
  await save();

  hr('summary');
  console.log(`  models reported by the server: ${models.join(', ') || '—'}${models.length > 1 ? red('  (MORE THAN ONE — the run is not single-model)') : ''}`);
  if (fps.length) console.log(`  system_fingerprint(s): ${fps.join(', ')}`);
  const retried = report.items.filter((e) => e.retry);
  console.log(`  corrective retries: ${retried.length}/${report.items.length} turns · language guard fired on ${retried.filter((e) => e.retry.language).length}, its reply delivered on ${report.items.filter((e) => e.language_retry).length}`);
  const skippedRetries = report.items.filter((e) => e.retry_skipped).length;
  if (skippedRetries) console.log(`  optional retries skipped past the deadline cutoff: ${skippedRetries} (chat.js delivers the first reply on these)`);
  if (evidenceMarker) {
    const marked = report.items.filter((e) => e.evidence_level != null).length;
    console.log(`  evidence marker: fired the retry on ${retried.filter((e) => e.retry.evidence).length}, its reply delivered on ${report.items.filter((e) => e.evidence_retry).length} · final replies carrying one marker ${marked}/${report.items.length}`);
  }
  console.log(`  turns past the ${turnDeadlineMs} ms deadline (production would 502 them): ${fmtRate(report.deadline_summary.exceeded)}`);
  if (report.router_summary) {
    const rs = report.router_summary;
    const p = (d) => (d.n ? `p50 ${Math.round(d.p50)} ms · p95 ${Math.round(d.p95)} ms (n ${d.n})` : 'no data');
    console.log(`  router ${armSpec.router}: deep ${fmtRate(rs.deep)} · reasons ${Object.entries(rs.reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
    console.log(`  TTFT, first thing the physician sees (status or text): ${p(rs.ttft_first_ms)}`);
    console.log(`  TTFT, first text: ${p(rs.ttft_content_ms)} · fast turns ${p(rs.ttft_content_fast_ms)} · deep turns ${p(rs.ttft_content_deep_ms)}`);
    console.log(`  fast turns that reasoned anyway (status shown on a fast turn): ${fmtRate(rs.status_on_fast)}`);
  }
  if (report.spend) console.log(`  spend: $${report.spend.usd} (${report.spend.in_tokens} in / ${report.spend.out_tokens} out tokens) · ceiling $${report.spend.max_usd}${report.spend.stopped_early ? red(' · stopped early') : ''}`);
  printSummary(report.checks_summary);
  console.log(`\n  ${bold('next:')} node scripts/quality/cite-verify.mjs ${path.relative(process.cwd(), file)}`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) await main();
