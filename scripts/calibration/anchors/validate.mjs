#!/usr/bin/env node
/*
 * Validate every anchor fixture against AUTHORING.md, then write manifest.json (sha256 per fixture).
 *
 *   node scripts/calibration/anchors/validate.mjs           # validate + rewrite manifest.json
 *   node scripts/calibration/anchors/validate.mjs --check   # validate + verify manifest.json, write nothing
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
 * quietly encode level (reported; |r| > MAX_LENGTH_R fails). The pilot's first draft came in at
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

const require = createRequire(import.meta.url);
const { stripPii, makeRegistry } = require('../../../rimpl/src/services/pii-filter.js');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../../../rimpl/src/services/post-filter.js');

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, 'fixtures');
export const MANIFEST_PATH = path.join(HERE, 'manifest.json');
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

export const MAX_LENGTH_R = 0.4;

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
  const results = [];
  for (const name of names) {
    const buf = await readFile(path.join(dir, name));
    let doc = null;
    let parseError = null;
    try { doc = JSON.parse(buf.toString('utf8')); } catch (e) { parseError = e.message; }
    const id = name.replace(/\.json$/, '');
    const r = parseError ? { errors: [`invalid JSON: ${parseError}`], warnings: [], stats: null } : validateFixture(doc, name, rows.get(id));
    results.push({ id, sha256: sha256(buf), row: rows.get(id), ...r });
  }
  const ok = results.filter((r) => r.stats && r.row);
  const lengthR = pearson(ok.map((r) => r.stats.physician_chars), ok.map((r) => r.row.target_composite));
  const manifest = {
    note: 'sha256 of each committed anchor fixture. Targets are NOT here — they live only in design.json. Regenerate with validate.mjs.',
    design_seed: design.seed,
    rubric_version: design.rubric_version,
    n: results.length,
    physician_chars_vs_target_r: lengthR == null ? null : Math.round(lengthR * 1000) / 1000,
    fixtures: Object.fromEntries(results.map((r) => [r.id, { sha256: r.sha256, ...(r.stats ?? {}) }])),
  };
  return { results, manifest, lengthR, design };
}

export const serialiseManifest = (m) => JSON.stringify(m, null, 2) + '\n';

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  const { results, manifest, lengthR } = await validateAll();
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
  const piiTotal = results.reduce((a, r) => a + (r.stats?.pii_hits ?? 0), 0);
  console.log(`\n  pii-filter hits: ${piiTotal}  (rimpl/src/services/pii-filter.js stripPii; any hit fails)`);
  console.log(`  citations checked against ${CITATIONS.length} allowlisted sources (citations.mjs)`);
  console.log(`  physician chars vs target composite: r = ${lengthR == null ? '—' : lengthR.toFixed(3)}  (|r| > ${MAX_LENGTH_R} fails — length must not encode level)`);
  if (lengthR != null && Math.abs(lengthR) > MAX_LENGTH_R) { console.log('  ✖ length tracks the target'); failed++; }

  const want = serialiseManifest(manifest);
  if (check) {
    let have = null;
    try { have = await readFile(MANIFEST_PATH, 'utf8'); } catch { /* missing */ }
    if (have !== want) { console.log(`  ✖ manifest.json is stale — run validate.mjs without --check`); failed++; }
    else console.log('  manifest.json matches the fixtures');
  } else if (!failed) {
    await writeFile(MANIFEST_PATH, want);
    console.log(`  wrote ${path.relative(process.cwd(), MANIFEST_PATH)}`);
  }
  console.log(failed ? `\n✖ ${failed} problem(s)\n` : `\n✔ all ${results.length} fixture(s) valid  (domains ${DOMAINS.length}, design n=${manifest.n})\n`);
  process.exit(failed ? 1 : 0);
}
