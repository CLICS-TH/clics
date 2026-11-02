const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';
// A chat may make up to 2 Claude calls (initial + citation retry) AND wait in RIMPL's concurrency
// queue under load, so the wrapper timeout must cover queue-wait + generation. Env-tunable; raised
// from 75s -> 100s to recover burst-tail calls that previously aborted while queued.
const CHAT_TIMEOUT_MS = parseInt(process.env.RIMPL_CHAT_TIMEOUT_MS || '100000', 10);
// Evaluation timeout must cover RIMPL's concurrency-queue wait + one provider attempt + retries —
// the old hard-coded 30s aborted burst-tail evals (end-of-cohort) while they were still queued,
// mis-routing sessions to manual QA / stranding credit.
//
// 180s, no longer defaulting to the chat value: both providers now use a 150s client ceiling (the
// on-prem model measured 82.5s and 87.8s on real transcripts, so the previous 85s sat mid-
// distribution). This outer bound MUST stay above that inner one — invert them and the backend hangs
// up on an evaluation the provider was about to return, which reads as a provider failure in the
// logs and costs the physician their credit for a call that actually succeeded.
//
// KEEP IT AT 480, and in particular below the drain's lease. EVAL_LEASE_S (services/eval-drain.js) is
// 600: a claimed row whose lease has expired is re-claimed on the drain's next tick, at most
// EVAL_DRAIN_INTERVAL_MS (60s) later. A timeout of 660s or more therefore guarantees a window where one
// row is evaluated twice, and anything above 600 risks it. 480 leaves 120s under the lease. rimpl's
// anthropic provider assumes this number for its late-retry cutoff
// (rimpl/src/services/providers/anthropic.js EVAL_LATE_RETRY_MS); change both together.
//
// 480s since the evaluation drain: the PIS-7 call left the physician's HTTP path entirely (it is
// claimed from the ple_pass queue in the background), and with the consistency layer a local
// evaluation is 2–3 serial ~70s calls plus rimpl's own queue wait. The criteria call is different —
// it still runs inside /end while the physician waits — so it keeps its own, shorter ceiling.
const EVAL_TIMEOUT_MS = parseInt(process.env.RIMPL_EVAL_TIMEOUT_MS || '480000', 10);
const CRITERIA_TIMEOUT_MS = parseInt(process.env.RIMPL_CRITERIA_TIMEOUT_MS || '180000', 10);

// A RIMPL HTTP error with the status attached, so callers can tell a DETERMINISTIC bad-output
// failure (400 bad request / 422 / 502 "evaluator returned out-of-range/invalid output") — which a
// retry can never fix — from a TRANSIENT one (500 infra / timeout / network) worth retrying. Without
// this, the reconcile sweep retries a deterministically-failing eval forever, re-paying Anthropic.
async function rimplError(path, res) {
  const status = typeof res === 'number' ? res : res?.status;
  // rimpl's queue/size errors carry a machine-readable body ({ code, retry_after_s }) and, for a
  // full queue, a Retry-After header. Surface both so the drain can back off by the server's own
  // estimate rather than a guess, and so a 413 can be told apart from any other deterministic 4xx.
  let body = null;
  if (res && typeof res === 'object') {
    try { body = typeof res.json === 'function' ? await res.json() : null; } catch { body = null; }
  }
  const err = errorFromBody(path, status, body);
  if (res && typeof res === 'object') {
    const hdr = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(hdr) && hdr > 0) err.retryAfterMs = hdr * 1000;
  }
  return err;
}

// The same error from a status and an already-parsed body — also how a streamed reply's final
// `done` event reports a failure (readChatStream).
function errorFromBody(path, status, body) {
  const err = new Error(`RIMPL ${path} error: ${status}`);
  err.status = status;
  if (body && typeof body === 'object') {
    if (typeof body.code === 'string') err.code = body.code;
    if (typeof body.error === 'string') err.detail = body.error.slice(0, 200);
    const ra = Number(body.retry_after_s);
    if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
  }
  return err;
}

// 400/422/502 from RIMPL are deterministic (malformed request / validation / un-parseable or
// out-of-range model output). A 401/403 is an INTERNAL_TOKEN misconfig — also not self-healing.
// 413 is the transcript exceeding the evaluator's context (rimpl's proactive backstop or the body
// limit): re-sending the same oversized transcript cannot make it fit, so it must route to a human,
// not loop. 503 (queue full / provider down) and 429 stay transient — the drain backs off on them.
const DETERMINISTIC_STATUSES = new Set([400, 401, 403, 413, 422, 502]);
function isDeterministicRimplError(err) {
  return err && typeof err.status === 'number' && DETERMINISTIC_STATUSES.has(err.status);
}

// rimpl now routes each AI call to a provider — the Anthropic cloud, or the on-prem local model —
// and reports which one ACTUALLY served the call on every response. Stamp it on the parsed body so
// no caller downstream has to guess when it prices the call.
//
// The fallback is 'anthropic' on purpose, i.e. the PAID rate: an older rimpl that predates the
// provider field (or a partial rollout) must make the backend over-bill, never silently meter real
// cloud spend at $0 — that would defeat the per-user budget cap and under-invoice the council.
const DEFAULT_PROVIDER = 'anthropic';
async function parseWithProvider(res) {
  const body = await res.json();
  if (body && typeof body === 'object' && !body.provider) body.provider = DEFAULT_PROVIDER;
  return body;
}

// `patient_ref` (the physician's structured patient identifier) is forwarded to RIMPL on-prem SOLELY
// so RIMPL can scrub it from the narrative/transcript before any cloud call — it is never forwarded
// to the cloud AI. See docs/constraints.md (data boundary).
//
// `stream: true` asks rimpl for server-sent events (rimpl/src/lib/sse.js): each `delta` / `replace`
// event is handed to `onEvent(name, data)` as it arrives, and the call still resolves with the same
// body (or throws the same error) as a non-streamed call — taken from the final `done` event. rimpl
// answers a rescue turn, and any failure before the first word, in plain JSON; both are read as before.
async function rimplChat({ ple_id, history, message, language, chief_complaint, patient_ref, socratic, artifacts, evidence_marker, router_enabled, deep_mode, rescue_active, already_qualified, rescue_rounds, booth_mode, booth_bank, booth_typed, stream = false, onEvent }, { timeoutMs = CHAT_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '',
      ...(stream ? { accept: 'text/event-stream' } : {}),
    },
    // rescue_active / already_qualified are latches from the `ples` row. RIMPL is stateless, so
    // without them it would re-run the qualifying classifier on every turn past the fourth.
    // rescue_rounds must travel too: RIMPL defaults it to 0, so dropping it here silently disables
    // the eight-round rescue ceiling and re-assesses a never-recovering session on every turn.
    // evidence_marker likewise: RIMPL defaults it to false, so a field missing here would leave the
    // setting ON and the marker silently never asked for. An older RIMPL strips the key (zod).
    // router_enabled (setting chat_router_enabled) and deep_mode (the ples.deep_mode_at latch) the same
    // way: RIMPL is stateless, so a session that went deep stays deep only if deep_mode travels.
    body: JSON.stringify({ ple_id, history, message, language, chief_complaint, patient_ref,
      socratic: !!socratic, artifacts: !!artifacts, evidence_marker: !!evidence_marker,
      router_enabled: !!router_enabled, deep_mode: !!deep_mode,
      rescue_active: !!rescue_active, already_qualified: !!already_qualified,
      rescue_rounds: Math.max(0, Number(rescue_rounds) || 0),
      ...(booth_mode ? { booth_mode: true } : {}),
      ...(booth_mode && booth_bank ? { booth_bank } : {}),
      ...(booth_mode && booth_typed ? { booth_typed } : {}),
      ...(stream ? { stream: true } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await rimplError('/chat', res);
  if (stream && /text\/event-stream/i.test(res.headers?.get?.('content-type') || '')) return readChatStream(res, onEvent);
  return parseWithProvider(res);
}

// Read rimpl's chat event stream. Events other than `done` go to onEvent in order; `done` carries
// { status, body }: a 2xx resolves with the body (provider stamped as parseWithProvider does), any
// other status throws the error rimplError would have thrown. A stream that ends without `done` (rimpl
// died mid-reply) throws a 502: nothing was produced that could be stored.
async function readChatStream(res, onEvent) {
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (block) => {
    const name = /^event: ?(.*)$/m.exec(block)?.[1]?.trim();
    const raw = /^data: ?(.*)$/m.exec(block)?.[1];
    if (!name || raw == null) return null;
    let data;
    try { data = JSON.parse(raw); } catch { return null; }
    if (name === 'done') return { done: data };
    if (onEvent) onEvent(name, data);
    return null;
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const r = handle(block);
      if (r) {
        const { status, body } = r.done || {};
        if (typeof status !== 'number' || status >= 400) throw errorFromBody('/chat', status ?? 502, body);
        if (body && typeof body === 'object' && !body.provider) body.provider = DEFAULT_PROVIDER;
        return body;
      }
    }
  }
  throw errorFromBody('/chat', 502, { error: 'the reply stream ended before it finished' });
}

// Auditor calibration chat: discuss a PLE's AI evaluation vs the auditor's own scores. The transcript
// is sent so RIMPL can de-identify it on-prem before the cloud call (stored raw); patient_ref gives
// the scrub hints. Metered against the auditor's SEPARATE budget pool by the caller.
// chief_complaint is NOT shown to the model: it seeds RIMPL's token numbering so the discussion reads
// the transcript with the same tokens as the auditor's de-identified view (rimplDeidentify below).
async function rimplAuditDiscuss({ history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref, chief_complaint }) {
  const res = await fetch(`${RIMPL_URL}/audit-discuss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ history, message, language, transcript, ai_scores, ai_rationale, auditor_scores, patient_ref,
      chief_complaint: chief_complaint ?? null }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/audit-discuss', res);
  return parseWithProvider(res);
}

// De-identified copy of a stored transcript for a HUMAN reader who must not see identifiers (the
// auditor; docs/CONSENT-TEMPLATE.md). RIMPL masks every turn under ONE registry seeded with the chief
// complaint and the patient_ref hints, in the order /chat uses, and makes no AI call. The raw
// transcript stays in the DB as the evidentiary record; nothing is written back.
//
// Throws on ANY failure — a non-2xx, a timeout, a body that is not the same number of string turns it
// was given. The caller must fail closed (no fallback to the raw text): see routes/auditor.js.
// Short timeout: there is no model behind it, only the on-prem filter, and an auditor is waiting.
const DEIDENTIFY_TIMEOUT_MS = parseInt(process.env.RIMPL_DEIDENTIFY_TIMEOUT_MS || '15000', 10);
async function rimplDeidentify({ messages, patient_ref, chief_complaint }) {
  const res = await fetch(`${RIMPL_URL}/deidentify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ messages, patient_ref: patient_ref ?? null, chief_complaint: chief_complaint ?? null }),
    signal: AbortSignal.timeout(DEIDENTIFY_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/deidentify', res);
  const body = await res.json();
  const out = body?.messages;
  if (!Array.isArray(out) || out.length !== messages.length || out.some(m => typeof m?.content !== 'string')) {
    throw new Error('RIMPL /deidentify returned a malformed transcript');
  }
  return body;
}

// `shadow: false` opts out of RIMPL's shadow evaluation. The calibration harness sets it because a
// --mode rescore run re-scores the real cohort through this route and would otherwise overwrite the
// pilot's accumulated shadow rows with calibration-run rows.
//
// `chief_complaint` (here and on rimplEvaluateCriteria) is NEVER shown to the model: RIMPL runs it
// through the token registry first and discards it, so the transcript is numbered as /chat numbered it
// and the persisted PII map, the auditor's view and the evaluator's input agree on every token. A
// caller that omits it (the calibration harness) gets the transcript-only numbering, recorded as such
// in provenance.deid. An older RIMPL ignores the key (its zod schemas strip unknown keys).
async function rimplEvaluate({ ple_id, transcript, patient_ref, chief_complaint, shadow, weights_sha256, lock_declaration_sha256 }, { timeoutMs = EVAL_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    // weights_sha256: the DECLARED Model Lock checksum (§10.2). RIMPL cannot read it — the weights
    // file sits on the DGX, not behind the inference API — so it is stamped onto the score from the
    // declaration instead, and its absence is recorded as "not locked" rather than hidden.
    // lock_declaration_sha256: the digest of the whole declaration behind the lock in force
    // (services/model-lock.js lockDeclarationDigest), which rimpl folds into config_fingerprint. The key
    // is ABSENT when unlocked, not null, so an unlocked request is byte-identical to before. A config
    // hash, never a transcript or an identifier; rimpl stamps it on the score and sends it nowhere else.
    // An older rimpl strips the key (zod) and answers 200 anyway; services/ple-evaluation.js's echo check
    // then refuses to save the score and defers it, so deploy rimpl first.
    body: JSON.stringify({ ple_id, transcript, patient_ref, chief_complaint: chief_complaint ?? null, shadow, weights_sha256: weights_sha256 ?? null,
      ...(lock_declaration_sha256 ? { lock_declaration_sha256 } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await rimplError('/evaluate', res);
  return parseWithProvider(res);
}

async function rimplEvaluateCriteria({ transcript, patient_ref, chief_complaint }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ transcript, patient_ref, chief_complaint: chief_complaint ?? null }),
    signal: AbortSignal.timeout(CRITERIA_TIMEOUT_MS),
  });
  if (!res.ok) throw await rimplError('/evaluate-criteria', res);
  return parseWithProvider(res);
}

// Readiness probe for the backend's GET /health/deep: fetch RIMPL's own deep check and return its
// HTTP status + parsed body WITHOUT throwing on a non-200 (unlike the chat/eval calls — here a 503
// is a meaningful "RIMPL degraded" answer, not a transport failure). Network/timeout still throws,
// which the health route maps to a `down` rimpl status. Short timeout — this is an ops probe.
const HEALTH_PROBE_TIMEOUT_MS = parseInt(process.env.HEALTH_RIMPL_TIMEOUT_MS || '2500', 10);
async function probeRimplDeep({ timeoutMs = HEALTH_PROBE_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/health/deep`, {
    method: 'GET',
    headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' }, // harmless; /health/deep is open
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { httpStatus: res.status, body };
}

// Ask RIMPL whether a provider is fit to serve a purpose, BEFORE switching to it. Separate from
// probeRimplDeep because that reports what is already running; this asks about something that is
// not running yet, which is the only question a switch gate cares about.
//
// Longer timeout than the deep probe: an embedding probe makes a real vendor round-trip, and this
// runs on a deliberate admin action rather than a monitor's schedule.
const PROVIDER_PROBE_TIMEOUT_MS = parseInt(process.env.HEALTH_PROVIDER_PROBE_TIMEOUT_MS || '20000', 10);
async function probeRimplProvider({ name, purpose = 'chat', timeoutMs = PROVIDER_PROBE_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/health/provider/${encodeURIComponent(name)}?purpose=${encodeURIComponent(purpose)}`, {
    headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RIMPL provider probe returned ${res.status}`);
  return res.json();
}

// The model manifest (CCME R2): rimpl's GET /manifest, behind the internal token. Returns the parsed
// body, { manifest, sha256, claimed_sha256, file, code_match, live, drift }, and THROWS on anything
// else: network error, timeout, non-2xx (an older rimpl answers 404), or a body that is not a JSON
// object. No judgement here: whether the manifest is good enough to freeze is services/model-lock.js's
// call, and it fails closed. Short timeout: rimpl answers from memory and probes no provider.
const MANIFEST_TIMEOUT_MS = parseInt(process.env.RIMPL_MANIFEST_TIMEOUT_MS || '8000', 10);
async function fetchRimplManifest({ timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  const res = await fetch(`${RIMPL_URL}/manifest`, {
    headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await rimplError('/manifest', res);
  const body = await res.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('RIMPL /manifest returned a body that is not a JSON object');
  }
  return body;
}

module.exports = { rimplChat, rimplAuditDiscuss, rimplDeidentify, rimplEvaluate, rimplEvaluateCriteria, isDeterministicRimplError, RIMPL_URL, probeRimplDeep, probeRimplProvider, fetchRimplManifest, DEFAULT_PROVIDER };
