#!/usr/bin/env node
/*
 * Validate every anchor fixture against AUTHORING.md, then write manifest.json (sha256 per fixture).
 *
 *   node scripts/calibration/anchors/validate.mjs           # validate + rewrite manifest.json
 *   node scripts/calibration/anchors/validate.mjs --check   # validate + verify manifest.json, write nothing
 *   node scripts/calibration/anchors/validate.mjs --batch 3            # INTAKE one authoring batch (batches.json)
 *   node scripts/calibration/anchors/validate.mjs --only anc-0NN,anc-0MM  # INTAKE named fixtures
 *
 *   node scripts/calibration/anchors/validate.mjs --record-batch 3 [--confirm-extra-review anc-0NN]
 *                                                     # intake 3 and, if it passes, log it as accepted
 *
 * HELD-OUT LOCK. A held-out fixture is locked only after its batch PASSED intake: `--record-batch N`
 * runs the full `--batch N` intake (budget deviations are errors there), refuses an `extra_review` row
 * unless `--confirm-extra-review <id>` names it, and only then appends the batch, with each fixture's
 * sha256, to intake-log.json. The full run (no flags) then writes manifest.json and locks, into
 * HELDOUT-LOCK.json, exactly the held-out fixtures whose current bytes are in the intake log. Any other
 * held-out fixture present is an ERROR and blocks the write. A locked fixture may never change.
 * Fixing a held-out anchor before it is locked is authoring (AUTHORING.md §7.5): fix it and record its
 * batch again.
 *
 * Intake mode (--batch / --only) writes nothing. It reports, for those ids only: every per-fixture
 * error, the CUE BUDGET each was assigned in batches.json (length, acknowledgements, numerals, list
 * lines, rubric echo — a deviation is an ERROR here, a warning in the full run), the planted-claim
 * checks, and the batch's CONTRIBUTION to the cohort cue gate: each gated pair's r over the cohort
 * without the batch and with it, and, for a pair the batch pushes toward failure, which of its
 * fixtures push it most (leave-one-out). Exit 1 if anything in the batch must go back to its author.
 *
 * Checks, per fixture:
 *   schema     exactly {ple_id, patient_ref:null, transcript}; ple_id == file name; roles
 *              physician/assistant alternate from physician, end on assistant, then at most one
 *              `reflection` turn (production's shape: backend/src/services/reflection.js)
 *   design     a design.json row exists; physician-turn count == design.physician_turns (4-8);
 *              reflection turn present iff design.reflection == 'reflection_turn'
 *   blind      no target leakage — no d1..d7 / PIS / rubric / domain names / level talk
 *   PII        rimpl's own stripPii (rimpl/src/services/pii-filter.js) must leave every turn
 *              unchanged. A change is a possible PII hit — and, even when it is a false positive,
 *              it means the evaluator would read different text than the fixture holds.
 *   language   Thai share of physician + tutor turns matches design.language
 *   tutor      every tutor turn carries a (Source, Year) citation from citations.mjs; examiner
 *              turns end on a ❓ line, natural turns carry none
 *
 * Cohort-level: Pearson r between physician characters and target composite, so length cannot
 * quietly encode level — gated, with the other surface cues, by cues.mjs CUE_RULE. The pilot's first draft came in at
 * r = 0.45-0.60: authors write more when the target is higher, without meaning to.
 *
 * Package-free. Prints fixture ids and problems, and the masked spans of a PII hit (the fixtures are
 * synthetic, so the span is the only way to fix it) — never whole turns.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITATIONS, checkCitation } from './citations.mjs';
import { DOMAINS } from './design.mjs';
import { cueFeatures, cueCheck, formatCueMatrix, applyPilotFreeze, PILOT_FREEZE } from './cues.mjs';

const require = createRequire(import.meta.url);
const { stripPii, makeRegistry } = require('../../../rimpl/src/services/pii-filter.js');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../../../rimpl/src/services/post-filter.js');

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, 'fixtures');
export const MANIFEST_PATH = path.join(HERE, 'manifest.json');
export const PLANTED_PATH = path.join(HERE, 'planted-claims.json');
// Per-anchor sidecars, so parallel authors never edit one shared file: planted/anc-NNN.json =
// {"claims":[…same entry shape as planted-claims.json…]}, every entry's id equal to the file's id.
export const PLANTED_DIR = path.join(HERE, 'planted');
export const BATCHES_PATH = path.join(HERE, 'batches.json');

export const INTAKE_LOG_PATH = path.join(HERE, 'intake-log.json');

export async function loadIntakeLog(p = INTAKE_LOG_PATH) {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { entries: [] }; throw e; }
}

/**
 * The intake log is append-only: `was` (master's entries) must be a prefix of `is`. Returns null when
 * it holds, otherwise the first violation as a sentence. Pure.
 */
export function appendOnlyViolation(was = [], is = []) {
  if (is.length < was.length) return `${is.length} entries here, ${was.length} on master: entries were removed`;
  const i = was.findIndex((e, k) => JSON.stringify(is[k]) !== JSON.stringify(e));
  return i < 0 ? null : `entry ${i} (batch ${was[i].batch}) differs from master's: the log is append-only`;
}

/** id → the sha256 the LATEST accepted intake recorded for it. */
export function intakeAccepted(log) {
  const out = {};
  for (const e of log?.entries ?? []) for (const [id, sha] of Object.entries(e.fixtures ?? {})) out[id] = sha;
  return out;
}

/**
 * Append one accepted batch to the intake log. Pure. Refuses (errors, log unchanged) when the batch
 * still has intake failures, or an extra_review row was not explicitly confirmed.
 * @param {{batch, ids: string[], shas: object, bad: number, extraReview: string[], confirmed: string[], at?: string}} x
 */
export function recordIntake(log, { batch, ids, shas, bad, extraReview, confirmed, at = new Date().toISOString() }) {
  const errors = [];
  if (bad) errors.push(`batch ${batch} did not pass intake (${bad} item(s) to return) — nothing recorded`);
  for (const id of extraReview) if (!confirmed.includes(id)) errors.push(`${id} is extra_review: name it in --confirm-extra-review after the coordinator has read it`);
  for (const id of confirmed) if (!extraReview.includes(id)) errors.push(`--confirm-extra-review ${id}: not an extra_review row of batch ${batch}`);
  if (errors.length) return { log, errors };
  const entry = { batch, recorded_at: at, confirmed_extra_review: [...confirmed].sort(),
    fixtures: Object.fromEntries(ids.map((id) => [id, shas[id]])) };
  return { log: { note: 'Batches that PASSED intake (validate.mjs --record-batch), with each fixture\'s sha256 at that moment. Only these bytes may be locked as held-out. Append-only.', entries: [...(log?.entries ?? []), entry] }, errors };
}

/**
 * Held-out lock bookkeeping. Pure. Returns the lock as it should be after this run, plus:
 * `changed` = locked ids whose current sha differs (always an error); `added` = held-out fixtures
 * whose current bytes passed intake (intake log) and are now locked; `unrecorded` = held-out fixtures
 * present that are neither locked nor accepted at intake with these bytes (an error: they never
 * passed their batch's intake). Without an intake log argument every unlocked fixture is unrecorded.
 */
export function updateHeldOutLock(split, lock, results, accepted = {}) {
  const locked = { ...(lock?.locked ?? {}) };
  if (!split) return { lock, changed: [], unlocked: [], added: [], unrecorded: [] };
  const held = new Set(split.held_out);
  const changed = [], unlocked = [], unrecorded = [];
  for (const r of results) {
    if (!held.has(r.id)) continue;
    if (locked[r.id] == null) (accepted[r.id] === r.sha256 ? unlocked : unrecorded).push(r.id);
    else if (locked[r.id] !== r.sha256) changed.push(r.id);
  }
  for (const id of unlocked) locked[id] = results.find((r) => r.id === id).sha256;
  const next = {
    note: 'sha256 of every held-out anchor fixture, recorded at intake by validate.mjs. A locked fixture never changes (AUTHORING.md §7.5); no held-out anchor is scored before all are locked (§9). Never edit by hand.',
    split_seed: split.seed,
    held_out_total: split.held_out.length,
    locked: Object.fromEntries(Object.entries(locked).sort(([a], [b]) => a.localeCompare(b))),
  };
  return { lock: next, changed, unlocked, added: unlocked, unrecorded };
}

/** All planted-claim entries: planted-claims.json plus every planted/anc-NNN.json sidecar. */
export async function loadPlanted() {
  const errs = [];
  const claims = [];
  try { claims.push(...(JSON.parse(await readFile(PLANTED_PATH, 'utf8')).claims ?? [])); }
  catch (e) { errs.push(`planted-claims.json unreadable: ${e.message}`); }
  for (const f of (await readdir(PLANTED_DIR).catch(() => [])).filter((x) => /^anc-\d{3}\.json$/.test(x)).sort()) {
    const id = f.slice(0, -5);
    try {
      const side = JSON.parse(await readFile(path.join(PLANTED_DIR, f), 'utf8')).claims ?? [];
      for (const c of side) {
        if (c.id !== id) errs.push(`planted/${f}: entry for ${c.id} — a sidecar holds only its own anchor`);
        claims.push(c);
      }
    } catch (e) { errs.push(`planted/${f} unreadable: ${e.message}`); }
  }
  const seen = new Set();
  for (const c of claims) {
    const k = `${c.file}|${c.turn}|${c.claim}`;
    if (seen.has(k)) errs.push(`planted claim recorded twice: ${c.id} turn ${c.turn}`);
    seen.add(k);
  }
  return { claims, errs };
}

/** Cue budgets by id from batches.json ({} when there is no plan). */
export async function loadBudgets() {
  try {
    const plan = JSON.parse(await readFile(BATCHES_PATH, 'utf8'));
    return Object.fromEntries(plan.batches.flatMap((b) => b.rows.map((r) => [r.id, { ...r.cue_budget, batch: b.batch, extra_review: r.extra_review ?? null }])));
  } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

// Tolerances around the planned surface shape: wide enough to write naturally, narrow enough that
// the cohort gate keeps its margin (batch-plan.mjs simulates both).
// Each row also gets an exact physician-length target inside its bin (cue_budget.length_chars,
// batch-plan.mjs), met to within this many characters at intake. The bins alone were not enough:
// authors drifted inside them, writing longer for higher targets (batches 1 and 3: r = 0.95 inside the
// short bin), which rebuilt the length–composite cue the bins were there to break.
export const LENGTH_CHARS_TOL = 125;
export const BUDGET_TOLERANCE = {
  length: { short: [850, 1310], medium: [1190, 1730], long: [1570, 2200] },
  numerals: { few: [0, 1.5], some: [1.5, 4], many: [3.5, Infinity] },
  list_lines: { 0: [0, 0], some: [1, 5] },
};

/** Deviations of one fixture's measured surface from its assigned budget. */
export function checkBudget(features, physicianTurns, b) {
  if (!b || !features) return [];
  const out = [];
  const [lo, hi] = BUDGET_TOLERANCE.length[b.length];
  if (features.length < lo || features.length > hi) out.push(`length ${features.length} chars, budget ${b.length} (${lo}–${hi})`);
  else if (b.length_chars != null && Math.abs(features.length - b.length_chars) > LENGTH_CHARS_TOL) {
    out.push(`length ${features.length} chars, target ${b.length_chars} ±${LENGTH_CHARS_TOL}`);
  }
  const acks = Math.round(features.acks * physicianTurns);
  if (acks !== b.ack_turns) out.push(`${acks} acknowledgement token(s), budget ${b.ack_turns}`);
  const [nlo, nhi] = BUDGET_TOLERANCE.numerals[b.numerals];
  if (features.numbers < nlo || features.numbers > nhi) out.push(`${features.numbers.toFixed(1)} numerals per physician turn, budget ${b.numerals} (${nlo}–${nhi === Infinity ? '…' : nhi})`);
  const [llo, lhi] = BUDGET_TOLERANCE.list_lines[b.list_lines];
  if (features.list_lines < llo || features.list_lines > lhi) out.push(`${features.list_lines} list line(s), budget ${b.list_lines} (${llo}–${lhi})`);
  if (features.rubric_echo > (b.rubric_echo ?? 0)) out.push(`${features.rubric_echo} rubric-descriptor word(s) (${Object.keys(features.echo_hits).join('; ')}), budget 0`);
  return out;
}

const CITED_RE = /\([^()]*\b(?:19|20)\d{2}\)/;

/**
 * planted-claims.json: every tutor statement written wrong (or unqualified) on purpose for the
 * physician to appraise. Checked against the fixture bytes so the list cannot drift from the text:
 * the claim is verbatim in that assistant turn, a later assistant turn corrects it, and — the
 * §1.5/§1.6 reconciliation — a FALSE claim never shares its line with a citation (except the one
 * recorded legacy instance). `readDoc(file)` returns the parsed fixture or null.
 */
export function checkPlanted(planted, readDoc) {
  const errs = [];
  for (const [k, c] of (planted?.claims ?? []).entries()) {
    const at = `planted-claims #${k} (${c.id} turn ${c.turn})`;
    const doc = readDoc(c.file);
    if (!doc) { errs.push(`${at}: ${c.file} not found`); continue; }
    if (path.basename(c.file, '.json') !== c.id) errs.push(`${at}: id does not match ${c.file}`);
    const t = doc.transcript ?? [];
    const turn = t[c.turn];
    if (turn?.role !== 'assistant') { errs.push(`${at}: turn ${c.turn} is not a tutor turn`); continue; }
    const line = String(turn.content).split('\n').find((l) => l.includes(c.claim));
    if (!line) { errs.push(`${at}: claim text not found verbatim in that turn`); continue; }
    const cited = CITED_RE.test(line);
    if (cited !== Boolean(c.citation_on_claim)) errs.push(`${at}: citation_on_claim is ${c.citation_on_claim} but the line ${cited ? 'carries' : 'carries no'} citation`);
    if (c.kind === 'false' && cited && !c.legacy) errs.push(`${at}: a deliberately false claim may not carry a citation on its line (AUTHORING.md §5)`);
    if (!['false', 'unqualified', 'attribution', 'unplanted'].includes(c.kind)) errs.push(`${at}: kind must be false|unqualified|attribution|unplanted`);
    // 'unplanted' = an authoring inaccuracy found after the text was panel-rated, kept byte for byte and
    // recorded instead of edited; nothing in the transcript corrects it, so corrected_in_turn is null.
    if (c.kind === 'unplanted') { if (c.corrected_in_turn != null) errs.push(`${at}: an unplanted inaccuracy has corrected_in_turn null`); }
    else if (!(c.corrected_in_turn > c.turn) || t[c.corrected_in_turn]?.role !== 'assistant') errs.push(`${at}: corrected_in_turn must be a later tutor turn`);
  }
  return errs;
}
const DESIGN_PATH = path.join(HERE, 'design.json');

// Production's reflection headings — backend/src/services/reflection.js asTranscriptTurn. Copied
// because that module needs supabase to load; anchors.test.mjs re-reads the source and fails if
// these ever drift from it.
export const REFLECTION_HEADINGS = [
  'เรียนรู้อะไร / What I learned:',
  'ความไม่แน่นอน / What remains uncertain:',
  'จะตรวจสอบ/นำไปใช้อย่างไร / How I will verify or apply it:',
];

// Target leakage. Clinical risk scores (HEART, CURB-65 …) are legitimate content, so bare "score" is
// NOT banned — only rubric vocabulary and self-assessment talk.
export const LEAK_PATTERNS = [
  /\bd[1-7]\b/i,
  /\bPIS-?7?\b/i,
  /rubric|รูบริก/i,
  /\bdomains?\b/i,
  /composite/i,
  /\banchors?\b/i,
  /\banc-\d+/i,
  /synthetic|สังเคราะห์ข้อมูล/i,
  /clinical question intelligence|reasoning depth|contextual integration|iterative inquiry|critical appraisal|reflective synthesis|AI literacy|prompt skill/i,
  /\blevel\s*[0-5]\b|ระดับ\s*[0-5]\b/i,
  /\b(my|your|target|this)\s+score\b|คะแนน(ของ(ผม|ฉัน|หมอ|คุณ)|เป้าหมาย|ที่ได้)/i,
  /evaluator|ผู้ประเมิน|CME credit|เครดิต/i,
];

const THAI = /[฀-๿]/g;
const LATIN = /[A-Za-z]/g;
export function thaiShare(text) {
  const th = (String(text).match(THAI) ?? []).length;
  const la = (String(text).match(LATIN) ?? []).length;
  return th + la ? th / (th + la) : 0;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Spans stripPii changed: [{from, to}] pairs, by diffing on the mask tokens it inserts. */
function piiDiff(original, masked) {
  if (original === masked) return [];
  const hits = [];
  for (const m of masked.matchAll(/\[[A-Z_]+-\d+\]/g)) hits.push(m[0]);
  return hits.length ? hits : ['(text changed without a mask token)'];
}

/**
 * Validate one parsed fixture.
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
export function validateFixture(doc, fileName, row) {
  const errors = [];
  const warnings = [];
  const id = fileName.replace(/\.json$/, '');
  const err = (m) => errors.push(m);

  // ---- schema
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { errors: ['not a JSON object'], warnings, stats: null };
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'patient_ref,ple_id,transcript') err(`keys must be exactly ple_id, patient_ref, transcript (got ${keys})`);
  if (doc.ple_id !== id) err(`ple_id ${JSON.stringify(doc.ple_id)} must equal the file id ${id}`);
  if (doc.patient_ref !== null) err('patient_ref must be null');
  const t = Array.isArray(doc.transcript) ? doc.transcript : [];
  if (!t.length) err('transcript is empty or not an array');
  t.forEach((turn, i) => {
    const k = turn && typeof turn === 'object' ? Object.keys(turn).sort().join(',') : '';
    if (k !== 'content,role') err(`turn ${i}: keys must be exactly role, content`);
    if (typeof turn?.content !== 'string' || !turn.content.trim()) err(`turn ${i}: empty content`);
    if (!['physician', 'assistant', 'reflection'].includes(turn?.role)) err(`turn ${i}: role ${JSON.stringify(turn?.role)}`);
  });
  const reflIdx = t.map((x, i) => (x?.role === 'reflection' ? i : -1)).filter((i) => i >= 0);
  if (reflIdx.length > 1) err('more than one reflection turn');
  if (reflIdx.length === 1 && reflIdx[0] !== t.length - 1) err('the reflection turn must be last');
  const chat = t.filter((x) => x?.role !== 'reflection');
  chat.forEach((x, i) => {
    const want = i % 2 === 0 ? 'physician' : 'assistant';
    if (x?.role !== want) err(`chat turn ${i} is ${x?.role}, expected ${want} (strict alternation from physician)`);
  });
  if (chat.length && chat.at(-1)?.role !== 'assistant') err('the chat must end on an assistant turn');

  const phys = chat.filter((x) => x?.role === 'physician');
  const tutor = chat.filter((x) => x?.role === 'assistant');
  const refl = t.find((x) => x?.role === 'reflection');

  // ---- design
  if (!row) err(`no design.json row for ${id}`);
  if (phys.length < 4 || phys.length > 8) err(`${phys.length} physician turns (must be 4-8; build-fixtures' bar is 4)`);
  if (row && phys.length !== row.physician_turns) err(`${phys.length} physician turns, design says ${row.physician_turns}`);
  if (row) {
    const wantRefl = row.reflection === 'reflection_turn';
    if (wantRefl && !refl) err('design.reflection is reflection_turn but there is no reflection turn');
    if (!wantRefl && refl) err(`design.reflection is ${row.reflection} but a reflection turn is present`);
  }
  if (refl) {
    const blocks = refl.content.split(/\n\n(?=[^\n]*\/ [A-Z][^\n]*:\n)/);
    let last = -1;
    for (const b of blocks) {
      const h = REFLECTION_HEADINGS.indexOf(b.split('\n')[0]);
      if (h < 0) { err(`reflection block does not start with a production heading: ${JSON.stringify(b.split('\n')[0].slice(0, 60))}`); continue; }
      if (h <= last) err('reflection blocks out of production order');
      if (!b.split('\n').slice(1).join('\n').trim()) err(`reflection block "${REFLECTION_HEADINGS[h]}" has no text`);
      last = h;
    }
  }

  // ---- blind
  for (const [i, turn] of t.entries()) {
    for (const re of LEAK_PATTERNS) {
      const m = String(turn?.content ?? '').match(re);
      if (m) err(`turn ${i} (${turn.role}): possible target leakage ${JSON.stringify(m[0])}`);
    }
    if (/\[\s*(PHYSICIAN|ASSISTANT|SYSTEM|USER|AI|REFLECTION)\b/i.test(turn?.content ?? '')) err(`turn ${i}: contains a bracketed role marker`);
    if (/:::artifact/.test(turn?.content ?? '')) err(`turn ${i}: artifact fence (clinical_artifacts is OFF by default)`);
  }

  // ---- PII: production's filter must change nothing. One registry per transcript, as build-fixtures.
  const registry = makeRegistry();
  const piiHits = [];
  for (const [i, turn] of t.entries()) {
    const c = String(turn?.content ?? '');
    const masked = stripPii(c, registry, []);
    const diff = piiDiff(c, masked);
    if (diff.length) {
      piiHits.push({ turn: i, masks: diff });
      // Show the masked line(s) only, so the author can find the span. Synthetic text; still no whole turns.
      const lines = masked.split('\n').filter((l) => /\[[A-Z_]+-\d+\]/.test(l)).map((l) => l.slice(0, 140));
      err(`turn ${i} (${turn.role}): pii-filter changed the text — ${diff.join(' ')} :: ${lines.join(' | ')}`);
    }
  }

  // ---- language
  const thPhys = thaiShare(phys.map((x) => x.content).join('\n'));
  const thTutor = thaiShare(tutor.map((x) => x.content).join('\n'));
  if (row?.language === 'th') {
    if (thPhys < 0.4) err(`language th but physician Thai share ${thPhys.toFixed(2)} < 0.40`);
    if (thTutor < 0.4) err(`language th but tutor Thai share ${thTutor.toFixed(2)} < 0.40 (tutor must reply in the physician's language)`);
  } else if (row?.language === 'en') {
    if (thPhys > 0 || thTutor > 0) err(`language en but Thai characters present (physician ${thPhys.toFixed(2)}, tutor ${thTutor.toFixed(2)})`);
  }

  // ---- tutor turns
  tutor.forEach((x, k) => {
    const label = `tutor turn ${k + 1}`;
    if (!hasCitation(x.content)) err(`${label}: no (Source, Year) citation`);
    for (const ref of extractReferences(x.content)) {
      if (!checkCitation(ref.source).ok) err(`${label}: citation not on the allowlist (citations.mjs): (${ref.source})`);
    }
    const q = extractSocraticQuestion(x.content);
    if (row?.tutor_mode === 'examiner') {
      const lastLine = x.content.trim().split('\n').at(-1).trim();
      if (!lastLine.startsWith('❓')) err(`${label}: examiner mode — the last line must be a ❓ question`);
      if ((x.content.match(/❓/g) ?? []).length !== 1) err(`${label}: examiner mode — exactly one ❓`);
    } else if (row?.tutor_mode === 'natural' && q !== null) {
      err(`${label}: natural mode must not carry a ❓ question`);
    }
    if (x.content.length > 2600) warnings.push(`${label}: ${x.content.length} chars — the tutor prompt asks for under ~400 words`);
  });

  const stats = {
    turns: t.length,
    physician_turns: phys.length,
    physician_chars: phys.reduce((a, x) => a + x.content.length, 0),
    tutor_chars: tutor.reduce((a, x) => a + x.content.length, 0),
    reflection_chars: refl ? refl.content.length : 0,
    thai_share_physician: Math.round(thPhys * 100) / 100,
    thai_share_tutor: Math.round(thTutor * 100) / 100,
    citations: tutor.reduce((a, x) => a + extractReferences(x.content).length, 0),
    pii_hits: piiHits.length,
  };
  return { errors, warnings, stats };
}

export function pearson(xs, ys) {
  if (xs.length < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  return den ? num / den : null;
}

/** Validate every fixture in `dir`. Pure apart from reading files; returns the would-be manifest. */
export async function validateAll({ dir = FIXTURES_DIR, designPath = DESIGN_PATH } = {}) {
  const design = JSON.parse(await readFile(designPath, 'utf8'));
  const rows = new Map(design.anchors.map((a) => [a.id, a]));
  const names = (await readdir(dir).catch(() => [])).filter((f) => /^anc-\d{3}\.json$/.test(f)).sort();
  const budgets = await loadBudgets();
  const results = [];
  for (const name of names) {
    const buf = await readFile(path.join(dir, name));
    let doc = null;
    let parseError = null;
    try { doc = JSON.parse(buf.toString('utf8')); } catch (e) { parseError = e.message; }
    const id = name.replace(/\.json$/, '');
    const r = parseError ? { errors: [`invalid JSON: ${parseError}`], warnings: [], stats: null } : validateFixture(doc, name, rows.get(id));
    const ex = rows.get(id)?.excluded;
    if (ex) r.errors.push(`${id} was excluded under §7.4 (replaced by ${ex.replaced_by}); its fixture belongs in ${ex.archived_fixture}, not in the active cohort`);
    const features = doc ? cueFeatures(doc) : null;
    const budget = budgets[id] ? checkBudget(features, r.stats?.physician_turns ?? 1, budgets[id]) : [];
    for (const d of budget) r.warnings.push(`cue budget: ${d}`);
    results.push({ id, sha256: sha256(buf), row: rows.get(id), features, budget, ...r });
  }
  // §7.4 archive: every excluded anchor's last fixture is kept, byte for byte, where design.json says.
  const archive = [];
  for (const a of design.anchors.filter((x) => x.excluded)) {
    let buf = null;
    try { buf = await readFile(path.join(path.dirname(designPath), a.excluded.archived_fixture)); } catch { /* missing */ }
    if (!buf) archive.push(`${a.id}: archived fixture ${a.excluded.archived_fixture} is missing`);
    else if (sha256(buf) !== a.excluded.sha256) archive.push(`${a.id}: archived fixture ${a.excluded.archived_fixture} does not match its recorded sha256`);
  }
  const ok = results.filter((r) => r.stats && r.row && !r.row.excluded);
  const lengthR = pearson(ok.map((r) => r.stats.physician_chars), ok.map((r) => r.row.target_composite));
  const manifest = {
    note: 'sha256 of each committed anchor fixture. Targets are NOT here — they live only in design.json. Regenerate with validate.mjs.',
    design_seed: design.seed,
    rubric_version: design.rubric_version,
    n: results.length,
    physician_chars_vs_target_r: lengthR == null ? null : Math.round(lengthR * 1000) / 1000,
    fixtures: Object.fromEntries(results.map((r) => [r.id, { sha256: r.sha256, ...(r.stats ?? {}) }])),
  };
  const cues = cueCheck(ok.filter((r) => r.features).map((r) => ({ id: r.id, features: r.features, row: r.row })));
  Object.assign(cues, applyPilotFreeze(cues.failures, { fixtureShas: Object.fromEntries(results.map((r) => [r.id, r.sha256])) }));
  const { claims, errs: plantedLoad } = await loadPlanted();
  const files = {};
  for (const c of claims) {
    if (!(c.file in files)) { try { files[c.file] = JSON.parse(await readFile(path.join(HERE, c.file), 'utf8')); } catch { files[c.file] = null; } }
  }
  const planted = [...plantedLoad, ...checkPlanted({ claims }, (f) => files[f] ?? null)];
  const cueEntries = ok.filter((r) => r.features).map((r) => ({ id: r.id, features: r.features, row: r.row }));
  return { results, manifest, lengthR, design, cues, archive, planted, claims, cueEntries };
}

export const serialiseManifest = (m) => JSON.stringify(m, null, 2) + '\n';

/**
 * A batch's contribution to the cohort cue gate. Pure. For every gated pair: r without the batch, r
 * with it, and whether it fails with it. For pairs the batch moves away from 0 (or that fail), the
 * batch fixtures whose removal moves r back toward 0 the most (leave-one-out over the full cohort).
 */
export function batchCueContribution(entries, ids) {
  const inBatch = new Set(ids);
  const withB = cueCheck(entries);
  const without = cueCheck(entries.filter((e) => !inBatch.has(e.id)));
  const pairs = [];
  for (const [f, targets] of Object.entries(withB.matrix)) {
    for (const [k, c] of Object.entries(targets)) {
      if (!c.gated) continue;
      const before = without.matrix[f][k];
      const worse = c.r != null && before.r != null && Math.abs(c.r) > Math.abs(before.r) + 0.01;
      let pushers = [];
      if (worse || c.fails) {
        pushers = ids.filter((id) => entries.some((e) => e.id === id)).map((id) => {
          const loo = cueCheck(entries.filter((e) => e.id !== id)).matrix[f][k];
          return { id, effect: Math.abs(c.r) - Math.abs(loo.r ?? 0) };
        }).filter((x) => x.effect > 0.005).sort((a, b) => b.effect - a.effect).slice(0, 3);
      }
      pairs.push({ feature: f, target: k, r_without: before.r, r_with: c.r, lower: c.lower, upper: c.upper, fails: c.fails, worse, pushers });
    }
  }
  return { n_with: withB.n, n_without: without.n, pairs, failures: withB.failures };
}

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const argOf = (k) => { const i = argv.indexOf(`--${k}`); return i > -1 ? argv[i + 1] : null; };
  if (argOf('record-batch')) await recordBatchCli(argOf);
  if (argOf('only') || argOf('batch')) process.exit((await intake(argv, argOf)) ? 1 : 0);
  const check = process.argv.includes('--check');
  const { results, manifest, lengthR, cues, archive, planted } = await validateAll();
  let failed = 0;
  console.log(`\nanchor fixtures — ${results.length} file(s) in ${path.relative(process.cwd(), FIXTURES_DIR)}\n`);
  console.log('  id        status  turns  phys  phys-chars  th-phys  th-tutor  cites  target');
  for (const r of results) {
    const s = r.stats ?? {};
    const status = r.errors.length ? 'FAIL' : (r.warnings.length ? 'warn' : 'ok');
    if (r.errors.length) failed++;
    console.log(`  ${r.id}   ${status.padEnd(6)} ${String(s.turns ?? '—').padStart(5)} ${String(s.physician_turns ?? '—').padStart(5)}`
      + ` ${String(s.physician_chars ?? '—').padStart(11)} ${String(s.thai_share_physician ?? '—').padStart(8)}`
      + ` ${String(s.thai_share_tutor ?? '—').padStart(9)} ${String(s.citations ?? '—').padStart(6)}  ${r.row ? `${r.row.language} ${r.row.target_composite}` : '—'}`);
    for (const e of r.errors) console.log(`      ✖ ${e}`);
    for (const w of r.warnings) console.log(`      ! ${w}`);
  }
  for (const e of archive) console.log(`  ✖ excluded-anchor archive: ${e}`);
  failed += archive.length;
  for (const e of planted) console.log(`  ✖ ${e}`);
  failed += planted.length;
  const piiTotal = results.reduce((a, r) => a + (r.stats?.pii_hits ?? 0), 0);
  console.log(`\n  pii-filter hits: ${piiTotal}  (rimpl/src/services/pii-filter.js stripPii; any hit fails)`);
  console.log(`  citations checked against ${CITATIONS.length} allowlisted sources (citations.mjs)`);
  console.log(`  physician chars vs target composite: r = ${lengthR == null ? '—' : lengthR.toFixed(3)}  (gated below as length:composite)`);

  console.log('\n' + formatCueMatrix(cues));
  const ci = (f) => `r = ${f.r.toFixed(2)}${f.lower == null ? '' : `, 95% CI ${f.lower.toFixed(2)}…${f.upper.toFixed(2)}`}`;
  for (const f of cues.counted) console.log(`  ✖ surface cue: ${f.feature} tracks ${f.target} (${ci(f)})`);
  for (const f of cues.frozen) console.log(`  ! known (pilot freeze): ${f.feature} tracks ${f.target} (${ci(f)})`);
  if (cues.frozen.length) console.log(`    ${PILOT_FREEZE.reason}. Applies only to the 20 pilot files byte for byte; capped at the recorded r.`);
  failed += cues.counted.length;
  const echo = results.filter((r) => r.features?.rubric_echo >= 3);
  if (echo.length) {
    console.log('\n  rubric echo (descriptor phrases in physician text, AUTHORING.md §3) — fixtures with >= 3 hits:');
    for (const r of echo) console.log(`    ${r.id} (target ${r.row?.target_composite}, d5 ${r.row?.targets.d5}): ${Object.entries(r.features.echo_hits).map(([k, v]) => `${k} ×${v}`).join(' · ')}`);
  }

  // Held-out lock (needs SPLIT-anchors.json; an author checkout has none and skips this).
  const { loadAnchorSplit, loadHeldOutLock, LOCK_PATH } = await import('./anchor-split.mjs');
  const split = await loadAnchorSplit();
  const lockNow = await loadHeldOutLock();
  const lk = updateHeldOutLock(split, lockNow, results, intakeAccepted(await loadIntakeLog()));
  for (const id of lk.changed) console.log(`  ✖ ${id} is held-out and LOCKED, and its fixture changed (HELDOUT-LOCK.json) — a held-out anchor never changes after intake`);
  failed += lk.changed.length;
  for (const id of lk.unrecorded) console.log(`  ✖ ${id} is held-out and its current bytes never passed intake — run validate.mjs --record-batch <its batch> first`);
  failed += lk.unrecorded.length;
  if (split) console.log(`  held-out lock: ${Object.keys(lockNow?.locked ?? {}).length} of ${split.held_out.length} locked${lk.unlocked.length ? `; ${lk.unlocked.length} present but not yet locked (${lk.unlocked.join(' ')})` : ''}`);
  if (check && lk.unlocked.length) { console.log('  ✖ held-out fixtures not yet locked — run validate.mjs without --check to record them'); failed++; }

  const want = serialiseManifest(manifest);
  if (check) {
    let have = null;
    try { have = await readFile(MANIFEST_PATH, 'utf8'); } catch { /* missing */ }
    if (have !== want) { console.log(`  ✖ manifest.json is stale — run validate.mjs without --check`); failed++; }
    else console.log('  manifest.json matches the fixtures');
  } else if (!failed) {
    await writeFile(MANIFEST_PATH, want);
    console.log(`  wrote ${path.relative(process.cwd(), MANIFEST_PATH)}`);
    if (split && lk.added.length) {
      await writeFile(LOCK_PATH, JSON.stringify(lk.lock, null, 2) + '\n');
      console.log(`  locked ${lk.added.length} held-out fixture(s) in ${path.relative(process.cwd(), LOCK_PATH)}: ${lk.added.join(' ')}`);
    }
  }
  console.log(failed ? `\n✖ ${failed} problem(s)\n` : `\n✔ all ${results.length} fixture(s) valid  (domains ${DOMAINS.length}, design n=${manifest.n})\n`);
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------------ intake (one batch) */

async function intake(argv, argOf) {
  let ids;
  if (argOf('batch')) {
    const plan = JSON.parse(await readFile(BATCHES_PATH, 'utf8'));
    const b = plan.batches.find((x) => String(x.batch) === String(argOf('batch')));
    if (!b) { console.error(`✖ no batch ${argOf('batch')} in batches.json`); process.exit(2); }
    ids = b.rows.map((r) => r.id);
  } else ids = String(argOf('only')).split(',').map((x) => x.trim()).filter(Boolean);
  const { results, cueEntries, planted, claims } = await validateAll();
  let bad = 0;
  console.log(`\nanchor INTAKE — ${ids.length} id(s): ${ids.join(' ')}\n`);
  for (const id of ids) {
    const r = results.find((x) => x.id === id);
    if (!r) { console.log(`  ${id}  MISSING — no fixtures/${id}.json`); bad++; continue; }
    const errs = r.errors;
    const budget = r.budget ?? [];
    const others = r.warnings.filter((w) => !w.startsWith('cue budget:'));
    const status = errs.length || budget.length ? 'RETURN' : 'ok';
    if (status !== 'ok') bad++;
    const f = r.features ?? {};
    console.log(`  ${id}  ${status.padEnd(6)}  target ${r.row?.target_composite ?? '—'} ${r.row?.language ?? ''}  `
      + `len ${f.length ?? '—'}  acks ${f.acks != null ? Math.round(f.acks * (r.stats?.physician_turns ?? 1)) : '—'}  num/turn ${f.numbers?.toFixed(1) ?? '—'}  lists ${f.list_lines ?? '—'}  echo ${f.rubric_echo ?? '—'}  pii ${r.stats?.pii_hits ?? '—'}`);
    for (const e of errs) console.log(`      ✖ ${e}`);
    for (const d of budget) console.log(`      ✖ cue budget: ${d}`);
    for (const w of others) console.log(`      ! ${w}`);
    const extra = (await loadBudgets())[id]?.extra_review;
    if (extra) console.log(`      ⚠ EXTRA REVIEW before intake — ${extra}`);
    const mine = planted.filter((e) => e.includes(`(${id} `));
    for (const e of mine) console.log(`      ✖ ${e}`);
    bad += mine.length ? 1 : 0;
    const n = claims.filter((c) => c.id === id).length;
    if (r.row?.targets?.d5 >= 4 && !n) console.log('      ! d5 >= 4 and no planted/unqualified claim recorded — fine only if the appraisal targets true claims stated without their limits, and those are recorded too');
  }
  const present = ids.filter((id) => cueEntries.some((e) => e.id === id));
  if (present.length) {
    const c = batchCueContribution(cueEntries, present);
    console.log(`\n  cohort cue gate, without this batch (n=${c.n_without}) → with it (n=${c.n_with}); a gated pair fails when its 95% CI lies beyond ±0.1`);
    for (const p of c.pairs) {
      const fmt = (v) => (v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2));
      const mark = p.fails ? '✖ FAILS' : p.worse ? '↑ worse' : '';
      if (!p.fails && !p.worse) continue;
      console.log(`    ${(p.feature + ':' + p.target).padEnd(22)} ${fmt(p.r_without)} → ${fmt(p.r_with)}  [${fmt(p.lower)}, ${fmt(p.upper)}]  ${mark}${p.pushers.length ? `   pushed most by ${p.pushers.map((x) => `${x.id} (${x.effect.toFixed(3)})`).join(', ')}` : ''}`);
    }
    if (!c.pairs.some((p) => p.fails || p.worse)) console.log('    no gated pair moves away from 0 by more than 0.01');
    if (c.failures.length) { console.log(`  ✖ the cohort fails the cue gate with this batch (${c.failures.map((x) => `${x.feature}:${x.target}`).join(', ')})`); bad++; }
  }
  console.log(bad ? `\n✖ ${bad} item(s) to return to authors — nothing was written\n` : `\n✔ batch accepted by the validator — record it with validate.mjs --record-batch <N>, then run validate.mjs (no flags)\n`);
  return bad;
}

async function recordBatchCli(argOf) {
  const n = argOf('record-batch');
  const plan = JSON.parse(await readFile(BATCHES_PATH, 'utf8'));
  const b = plan.batches.find((x) => String(x.batch) === String(n));
  if (!b) { console.error(`✖ no batch ${n} in batches.json`); process.exit(2); }
  const bad = await intake(['--batch', n], (k) => (k === 'batch' ? n : null));
  const { results } = await validateAll();
  const shas = Object.fromEntries(results.map((r) => [r.id, r.sha256]));
  const confirmed = String(argOf('confirm-extra-review') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const extraReview = b.rows.filter((r) => r.extra_review).map((r) => r.id);
  const { log, errors } = recordIntake(await loadIntakeLog(), { batch: b.batch, ids: b.rows.map((r) => r.id), shas, bad, extraReview, confirmed });
  if (errors.length) { for (const e of errors) console.error(`✖ ${e}`); process.exit(1); }
  await writeFile(INTAKE_LOG_PATH, JSON.stringify(log, null, 2) + '\n');
  console.log(`✔ batch ${b.batch} recorded in ${path.relative(process.cwd(), INTAKE_LOG_PATH)} — now run validate.mjs (no flags) to write manifest.json and lock its held-out fixtures`);
  process.exit(0);
}
