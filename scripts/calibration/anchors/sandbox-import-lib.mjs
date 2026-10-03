// Pure planning core for putting anchor fixtures in front of human auditors (plan item 2.7).
//
// import-sandbox.mjs turns fixtures into SANDBOX `ples` + `messages` + `ple_reflections` rows;
// import-shadow.mjs turns a score-local run into `shadow_evaluations` rows for those PLEs. Both are
// thin CLIs over this file, so every rule that decides WHAT gets written lives here, is pure, and is
// tested hermetically (sandbox-import.test.mjs) — no DB, no network, no AI.
//
// Package-free on purpose (node:crypto + rimpl's package-free composite/versions), like the rest of
// the anchor tooling: CI's `node --check` and `node --test` run on a bare checkout.
import { createHash } from 'node:crypto';
import { rng } from './design.mjs';
import compositeLib from '../../../rimpl/src/lib/composite.js';
import versionsLib from '../../../rimpl/src/lib/versions.js';

const { compositeOf } = compositeLib;
const { modelVersion } = versionsLib;

export const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

/**
 * Fixed UUIDv5 namespace for anchor PLE ids. NEVER change it: the PLE id of an anchor is
 * uuidv5(anchor id, this), so a re-run, a rollback and import-shadow.mjs all find the same rows
 * without a lookup table, and an import is idempotent by construction.
 */
export const ANCHOR_NAMESPACE = '823151ec-4b0c-4bef-af46-1a6bf12c8804';
/** ples.provider_used for every imported anchor — the marker rollback and import-shadow check. */
export const PROVIDER_USED = 'anchor-synthetic';
/** councils.code of the only council an import may touch (db/migration-sandbox-specialties.sql). */
export const SANDBOX_CODE = 'SANDBOX';
/** Seed of the queue-order shuffle. Changing it re-times every anchor, so it is pinned. */
export const SCHEDULE_SEED = 20261007;
/** First session slot. In the past (sessions dated after "now" would look like clock skew). */
export const BASE_TIME = '2026-09-01T01:00:00.000Z';
/** One slot per designed anchor; a session never outlasts its slot, so no two sessions overlap. */
export const SLOT_MS = 3 * 60 * 60 * 1000;
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

/**
 * The three reflection headings, verbatim from backend/src/services/reflection.js asTranscriptTurn
 * (sandbox-import.test.mjs fails if they drift). Production renders a reflection as
 * `${heading}\n${text}` per NON-EMPTY section, joined by a blank line.
 */
export const REFLECTION_HEADINGS = {
  learned: 'เรียนรู้อะไร / What I learned:',
  uncertainty: 'ความไม่แน่นอน / What remains uncertain:',
  application: 'จะตรวจสอบ/นำไปใช้อย่างไร / How I will verify or apply it:',
};
const REFLECTION_KEYS = Object.keys(REFLECTION_HEADINGS);

/* ------------------------------------------------------------------ uuid */

function uuidBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}
const fmtUuid = (b) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** RFC 4122 §4.3 name-based UUID, SHA-1 (version 5). */
export function uuidv5(name, namespace = ANCHOR_NAMESPACE) {
  const hash = createHash('sha1').update(Buffer.concat([uuidBytes(namespace), Buffer.from(String(name), 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  return fmtUuid(b);
}
export const anchorPleId = (anchorId) => uuidv5(anchorId, ANCHOR_NAMESPACE);
export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/* ------------------------------------------------------------ reflection */

/** Exactly what reflection.asTranscriptTurn(...).content produces for these columns. */
export function renderReflection(r) {
  return REFLECTION_KEYS.filter((k) => r[k]).map((k) => `${REFLECTION_HEADINGS[k]}\n${r[k]}`).join('\n\n');
}

/**
 * Split a fixture's reflection turn into ple_reflections columns, or explain why it cannot be.
 *
 * "Splits cleanly" = the turn is EXACTLY what production would render from the columns
 * (renderReflection round-trips to the same bytes). That is the bar because the local evaluator
 * scored the fixture's turn, and the auditor will read production's re-rendering of the columns:
 * if the two differ, the human and the model saw different evidence. A section the fixture leaves
 * out is stored as NULL, as production stores an unanswered prompt — a deliberately thin
 * reflection is part of what the anchor is designed to score (D6).
 * @returns {{ok:true, columns:{learned,uncertainty,application}} | {ok:false, reason:string}}
 */
export function splitReflection(content) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'empty reflection turn' };
  const found = [];
  for (const k of REFLECTION_KEYS) {
    const h = REFLECTION_HEADINGS[k];
    const first = content.indexOf(h);
    if (first < 0) continue;
    if (content.indexOf(h, first + 1) >= 0) return { ok: false, reason: `heading "${h}" appears twice` };
    found.push({ k, at: first });
  }
  if (!found.length) return { ok: false, reason: 'none of the three headings is present' };
  if (found.some((f, i) => i > 0 && f.at < found[i - 1].at)) return { ok: false, reason: 'headings out of production order' };
  if (found[0].at !== 0) return { ok: false, reason: 'text before the first heading' };
  const columns = { learned: null, uncertainty: null, application: null };
  for (let i = 0; i < found.length; i++) {
    const start = found[i].at + REFLECTION_HEADINGS[found[i].k].length;
    const end = i + 1 < found.length ? found[i + 1].at : content.length;
    let seg = content.slice(start, end);
    if (!seg.startsWith('\n')) return { ok: false, reason: `no newline after "${REFLECTION_HEADINGS[found[i].k]}"` };
    seg = seg.slice(1);
    if (i + 1 < found.length) {
      if (!seg.endsWith('\n\n')) return { ok: false, reason: 'sections not separated by one blank line' };
      seg = seg.slice(0, -2);
    }
    if (!seg) return { ok: false, reason: `empty section under "${REFLECTION_HEADINGS[found[i].k]}"` };
    columns[found[i].k] = seg;
  }
  if (renderReflection(columns) !== content) return { ok: false, reason: 'does not round-trip through production rendering' };
  return { ok: true, columns };
}

/* ----------------------------------------------------- fixture integrity */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Throws unless the fixture bytes are the validated ones (manifest.json) and, for a held-out anchor,
 * the locked ones (HELDOUT-LOCK.json). A fixture edited after validation must never reach an
 * auditor under its old id — the same rule score-local.mjs applies before scoring.
 */
export function verifyFixtureBytes(id, buf, { manifest, lock, heldOut }) {
  const got = sha256(buf);
  const want = manifest?.fixtures?.[id]?.sha256;
  if (!want) throw new Error(`${id} is not in manifest.json — validate it first (validate.mjs)`);
  if (want !== got) throw new Error(`${id} changed since validation (sha256 ${got.slice(0, 12)} ≠ manifest ${want.slice(0, 12)}) — refusing to import`);
  if (heldOut) {
    const locked = lock?.locked?.[id];
    if (!locked) throw new Error(`${id} is held-out but not in HELDOUT-LOCK.json — refusing to import`);
    if (locked !== got) throw new Error(`${id} is held-out and no longer has its locked bytes (HELDOUT-LOCK.json) — refusing to import`);
  }
  return got;
}

/* --------------------------------------------------------------- council */

/**
 * Throws unless `council` is the SANDBOX council row for `councilId`. Under --confirm the CLI
 * fetches the row and passes it in; the planner calls this whenever it is given one, so a
 * mis-pasted production council id is refused before a single row is built.
 */
export function assertSandboxCouncil(council, councilId) {
  if (!council) throw new Error(`council ${councilId} does not exist`);
  if (council.id !== councilId) throw new Error(`council row ${council.id} is not ${councilId}`);
  if (council.code !== SANDBOX_CODE) {
    throw new Error(`council ${councilId} is "${council.code}" (${council.name_en ?? '?'}), not ${SANDBOX_CODE} — anchors may only ever be imported into the SANDBOX council`);
  }
}

/* -------------------------------------------------------------- schedule */

/** Fisher–Yates with the cohort's mulberry32 (design.mjs rng). */
export function seededShuffle(items, seed) {
  const R = rng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(R.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * anchor id → slot index. Shuffled over EVERY designed id (not the selection), so an anchor's
 * timestamps do not depend on which subset is imported: --only and --split runs agree, and the
 * auditor queue (ended_at asc) is not anchor order.
 */
export function slotIndex(designIds, seed = SCHEDULE_SEED) {
  const order = seededShuffle([...designIds].sort(), seed);
  return new Map(order.map((id, i) => [id, i]));
}

/** Per-anchor RNG, independent of selection: seed mixed with the anchor id. */
const anchorRng = (seed, id) => rng((seed ^ parseInt(createHash('sha1').update(id).digest('hex').slice(0, 8), 16)) >>> 0);

/* ------------------------------------------------------------------ plan */

/**
 * Plan the rows for one anchor. Pure.
 * @param {{ id: string, doc: object, sha256: string }} fx
 * @returns {{ id, ple_id, sha256, ple, messages, reflection, reflection_status }}
 */
export function planAnchor(fx, { physicianId, councilId, slot, baseMs, seed = SCHEDULE_SEED }) {
  const turns = fx.doc?.transcript;
  if (!Array.isArray(turns) || !turns.length) throw new Error(`${fx.id}: fixture has no transcript`);
  const bad = turns.find((t) => !['physician', 'assistant', 'reflection'].includes(t.role) || typeof t.content !== 'string');
  if (bad) throw new Error(`${fx.id}: unexpected turn role ${JSON.stringify(bad.role)} — messages.role is physician|assistant only`);
  const chat = turns.filter((t) => t.role !== 'reflection');
  const refl = turns.filter((t) => t.role === 'reflection');

  const R = anchorRng(seed, fx.id);
  const started = baseMs + slot * SLOT_MS + Math.floor(R.next() * 45 * 60) * 1000;
  // Physician turns take longer to write than the tutor takes to answer; both scale gently with
  // length. Whole seconds, always ≥ 1 s apart, so created_at is STRICTLY increasing — the auditor
  // transcript is `order('created_at')` and a tie would let Postgres pick the order.
  let t = started + 20_000;
  const gap = (turn) => (turn.role === 'physician'
    ? 45 + Math.min(240, Math.round(turn.content.length / 12)) + Math.floor(R.next() * 60)
    : 8 + Math.min(40, Math.round(turn.content.length / 150)) + Math.floor(R.next() * 12)) * 1000;
  const pleId = anchorPleId(fx.id);
  const messages = chat.map((turn, i) => {
    if (i > 0) t += gap(turn);
    return {
      ple_id: pleId,
      role: turn.role,
      content: turn.content,
      created_at: new Date(t).toISOString(),
      token_count: 0,
      // Per-turn provenance (migration-message-provenance.sql): NULL on physician turns; the tutor
      // turns were AI-authored synthetic text, never served by a CLICS provider.
      provider: turn.role === 'assistant' ? PROVIDER_USED : null,
      model: null,
      prompt_version: null,
    };
  });
  const ended = t + 30_000;
  if (ended - started > MAX_SESSION_MS) throw new Error(`${fx.id}: planned session outlasts its slot`);

  let reflection = null;
  let reflection_status;
  if (!refl.length) reflection_status = { ok: false, reason: 'no reflection turn in the fixture' };
  else if (refl.length > 1) reflection_status = { ok: false, reason: `${refl.length} reflection turns` };
  else if (turns.at(-1).role !== 'reflection') reflection_status = { ok: false, reason: 'reflection is not the last turn (production appends it last)' };
  else reflection_status = splitReflection(refl[0].content);
  if (reflection_status.ok) {
    reflection = {
      ple_id: pleId, physician_id: physicianId, skipped: false,
      ...reflection_status.columns,
      submitted_at: new Date(ended + 60_000).toISOString(),
    };
  }

  const physicianTurns = chat.filter((m) => m.role === 'physician').length;
  return {
    id: fx.id,
    ple_id: pleId,
    sha256: fx.sha256,
    ple: {
      id: pleId,
      physician_id: physicianId,
      council_id: councilId,
      specialty_id: null,
      is_test: true,
      status: 'evaluated',
      started_at: new Date(started).toISOString(),
      ended_at: new Date(ended).toISOString(),
      created_at: new Date(started).toISOString(),
      duration_seconds: Math.round((ended - started) / 1000),
      turn_count: physicianTurns,
      token_count: 0,
      ple_code: null,
      provider_used: PROVIDER_USED,
      // Clearance stays a HUMAN superadmin action (POST /admin/ples/:id/privacy-review). Never 'passed'.
      privacy_review_status: 'pending',
      privacy_concern_open: false,
    },
    messages,
    reflection,
    reflection_status,
  };
}

/**
 * Plan a whole import. Pure; throws on anything that must stop an import before a row is built.
 * @param {{ fixtures: {id, doc, sha256}[], designIds: string[], physicianId, councilId,
 *           council?: object, seed?: number, baseTime?: string }} o
 */
export function planImport({ fixtures, designIds, physicianId, councilId, council, seed = SCHEDULE_SEED, baseTime = BASE_TIME }) {
  if (!isUuid(physicianId)) throw new Error(`--physician-id must be a UUID (got ${JSON.stringify(physicianId)})`);
  if (!isUuid(councilId)) throw new Error(`--council-id must be a UUID (got ${JSON.stringify(councilId)})`);
  if (council !== undefined) assertSandboxCouncil(council, councilId);
  const baseMs = Date.parse(baseTime);
  if (!Number.isFinite(baseMs)) throw new Error(`bad base time ${baseTime}`);
  if (!fixtures.length) throw new Error('no fixtures selected');
  const slots = slotIndex(designIds, seed);
  const anchors = fixtures.map((fx) => {
    if (!slots.has(fx.id)) throw new Error(`${fx.id} is not in design.json`);
    return planAnchor(fx, { physicianId, councilId, slot: slots.get(fx.id), baseMs, seed });
  });
  const ids = new Set(anchors.map((a) => a.ple_id));
  if (ids.size !== anchors.length) throw new Error('UUIDv5 collision between anchors');
  const withRefl = anchors.filter((a) => a.reflection);
  return {
    anchors,
    queue_order: [...anchors].sort((a, b) => a.ple.ended_at.localeCompare(b.ple.ended_at)).map((a) => a.id),
    counts: {
      ples: anchors.length,
      messages: anchors.reduce((s, a) => s + a.messages.length, 0),
      physician_messages: anchors.reduce((s, a) => s + a.ple.turn_count, 0),
      reflections: withRefl.length,
    },
    no_reflection: anchors.filter((a) => !a.reflection).map((a) => ({ id: a.id, reason: a.reflection_status.reason })),
  };
}

/** The --manifest-out document. `ple_ids` makes it a valid three-way.js --manifest as-is. */
export function importManifest(plan, { split, physicianId, councilId }) {
  return {
    note: 'Anchor PLEs imported into the SANDBOX council by scripts/calibration/anchors/import-sandbox.mjs. ple_id = uuidv5(anchor id, namespace). Feed to import-shadow.mjs --manifest, three-way.js --include-test --manifest, or import-sandbox.mjs --rollback.',
    namespace: ANCHOR_NAMESPACE,
    split,
    physician_id: physicianId,
    council_id: councilId,
    ple_ids: plan.anchors.map((a) => a.ple_id),
    anchors: Object.fromEntries(plan.anchors.map((a) => [a.id, { ple_id: a.ple_id, sha256: a.sha256, reflection: !!a.reflection }])),
  };
}

/**
 * Fold a new import into an existing manifest file, so an `--only` top-up never shrinks the record
 * that --rollback and import-shadow read. Same council + physician only; an anchor imported twice
 * must carry the same bytes.
 */
export function mergeImportManifests(prev, next) {
  if (!prev) return next;
  readImportManifest(prev);
  for (const k of ['namespace', 'council_id', 'physician_id']) {
    if (prev[k] !== next[k]) throw new Error(`existing manifest has ${k} ${prev[k]}, this import ${next[k]} — use a different --manifest-out`);
  }
  const anchors = { ...prev.anchors };
  for (const [id, v] of Object.entries(next.anchors)) {
    if (anchors[id] && anchors[id].sha256 !== v.sha256) throw new Error(`${id} was imported with different fixture bytes (${anchors[id].sha256.slice(0, 12)}) — roll back before re-importing`);
    anchors[id] = v;
  }
  const ids = Object.keys(anchors).sort();
  return {
    ...next,
    split: prev.split === next.split ? next.split : [...new Set(`${prev.split}+${next.split}`.split('+'))].sort().join('+'),
    ple_ids: ids.map((id) => anchors[id].ple_id),
    anchors: Object.fromEntries(ids.map((id) => [id, anchors[id]])),
  };
}

/** Read an import manifest back and check every id is the anchor's own UUIDv5 (no hand edits). */
export function readImportManifest(doc) {
  const anchors = doc?.anchors;
  if (!anchors || typeof anchors !== 'object' || !Object.keys(anchors).length) throw new Error('import manifest has no anchors');
  const out = [];
  for (const [id, v] of Object.entries(anchors)) {
    if (v?.ple_id !== anchorPleId(id)) throw new Error(`import manifest: ${id} maps to ${v?.ple_id}, not its UUIDv5 ${anchorPleId(id)} — refusing a hand-edited manifest`);
    out.push({ id, ple_id: v.ple_id });
  }
  return out;
}

/* ---------------------------------------------------------------- shadow */

/** Median of an odd-length integer list; throws on even length (no fractional smallint). */
export function medianInt(xs) {
  if (!xs.length || xs.length % 2 === 0) throw new Error(`median needs an odd number of runs (got ${xs.length})`);
  if (!xs.every(Number.isInteger)) throw new Error('median: non-integer score');
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) / 2];
}

/**
 * The model_version an anchor shadow row carries: production's modelVersion(served model) PLUS an
 * `+anchor-median<K>` suffix — never the live label. These rows are a different PROCEDURE (median of
 * K offline runs, failures skipped, never written) and must not pool with live shadow traffic of the
 * same model: oversight.js measures the corpus contract rate per (provider, model_version) with no
 * is_test filter, and three-way.js picks the candidate the same way, so a shared label would add ~60
 * guaranteed successes to the candidate's contract rate (live 36/40 → 96/100 passes the 95% gate).
 */
export function anchorModelVersion(model, k) {
  if (!Number.isInteger(k) || k < 1 || k % 2 === 0) throw new Error(`anchor median needs an odd K (got ${k})`);
  return `${modelVersion(model)}+anchor-median${k}`;
}

/**
 * Map a score-local run to shadow_evaluations rows for the imported PLEs. Pure.
 * Per anchor: the per-domain MEDIAN of its K runs (K = run.repeats, odd; every run present and
 * scored — otherwise the anchor is SKIPPED and listed, never padded or averaged), composite from
 * rimpl compositeOf, provenance from the run file, model_version = anchorModelVersion (its own
 * candidate identity). An anchor whose run scored different bytes from the imported fixture — or
 * whose bytes cannot be checked because either sha is missing — is refused: the score would
 * describe a transcript the auditor may never read.
 */
export function planShadow({ run, manifestAnchors, fixtureShas, runFile, runSha }) {
  if (run?.probe !== 'anchors-score-local') throw new Error(`not a score-local run file (probe=${run?.probe})`);
  if (!run.model) throw new Error('run file has no model');
  const servedModels = [...new Set((run.rows ?? []).filter((r) => r.scores).map((r) => r.model ?? run.model))];
  if (servedModels.length > 1) throw new Error(`run mixes served models (${servedModels.join(', ')}) — one candidate per shadow row set`);
  const model = servedModels[0] ?? run.model;
  const K = run.repeats;
  const label = anchorModelVersion(model, K);
  const evaluatedAt = run.finished_at ?? run.started_at ?? null;
  const rows = [];
  const skipped = [];
  for (const { id, ple_id } of manifestAnchors) {
    const runs = (run.rows ?? []).filter((r) => r.id === id);
    if (!runs.length) { skipped.push({ id, reason: 'not in run file' }); continue; }
    // Fail CLOSED: a missing sha on either side is not "no mismatch".
    if (!run.fixtures?.[id]) { skipped.push({ id, reason: 'run file has no fixture sha for this anchor' }); continue; }
    if (!fixtureShas?.[id]) { skipped.push({ id, reason: 'import manifest has no fixture sha for this anchor' }); continue; }
    if (run.fixtures[id] !== fixtureShas[id]) { skipped.push({ id, reason: 'run scored different fixture bytes than were imported' }); continue; }
    if (runs.length !== K) { skipped.push({ id, reason: `${runs.length} runs, expected K=${K}` }); continue; }
    const scored = runs.filter((r) => r.scores && DOMAINS.every((d) => Number.isInteger(r.scores[d])));
    if (scored.length !== runs.length) { skipped.push({ id, reason: `${runs.length - scored.length} of ${runs.length} runs unscored` }); continue; }
    const scores = Object.fromEntries(DOMAINS.map((d) => [d, medianInt(scored.map((r) => r.scores[d]))]));
    rows.push({
      ple_id,
      provider: 'local',
      model_version: label,
      prompt_version: run.prompt_version_used ?? null,
      rubric_version: run.rubric_version ?? null,
      ...scores,
      composite_score: compositeOf(scores),
      // No per-domain rationale survives a median. The column carries the provenance instead, so a
      // row can always be traced back to the K runs it summarises.
      domain_rationale: {
        source: 'scripts/calibration/anchors/import-shadow.mjs',
        anchor_id: id,
        aggregation: `per-domain median of ${K} runs`,
        runs: scored.sort((a, b) => a.run - b.run).map((r) => DOMAINS.map((d) => r.scores[d])),
        run_file: runFile ?? null,
        run_file_sha256: runSha ?? null,
        consistency: run.consistency ?? null,
      },
      stop_reason: null,
      error: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      evaluated_at: evaluatedAt,
    });
  }
  return { rows, skipped, model_version: label };
}

/* ------------------------------------------------- existing-row comparison */

/**
 * Is an already-present anchor PLE byte-identical to what this import would write? Pure.
 * `stored.messages` are the DB rows (role, content, created_at) in any order; `stored.reflection` is
 * the ple_reflections row or null. Returns [] when identical, else human-readable differences.
 * An import skips an existing PLE ONLY when this is empty — a half-written PLE, or one written from
 * different fixture bytes, must never be counted as imported.
 */
export function diffExisting(planned, stored) {
  const diffs = [];
  const msgs = [...(stored?.messages ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (msgs.length !== planned.messages.length) diffs.push(`${msgs.length} messages stored, ${planned.messages.length} planned`);
  const n = Math.min(msgs.length, planned.messages.length);
  for (let i = 0; i < n; i++) {
    if (msgs[i].role !== planned.messages[i].role) { diffs.push(`message ${i + 1}: role ${msgs[i].role} ≠ ${planned.messages[i].role}`); break; }
    if (msgs[i].content !== planned.messages[i].content) { diffs.push(`message ${i + 1}: content differs`); break; }
  }
  const r = stored?.reflection ?? null;
  if (!!r !== !!planned.reflection) diffs.push(`reflection ${r ? 'stored' : 'missing'}, ${planned.reflection ? 'planned' : 'not planned'}`);
  else if (r) {
    for (const k of ['learned', 'uncertainty', 'application']) {
      if ((r[k] ?? null) !== (planned.reflection[k] ?? null)) diffs.push(`reflection.${k} differs`);
    }
    if (!!r.skipped !== !!planned.reflection.skipped) diffs.push('reflection.skipped differs');
  }
  return diffs;
}
