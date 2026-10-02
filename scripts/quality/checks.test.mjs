// Deterministic checks on tutor replies — offline, synthetic replies only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { existsSync } from 'node:fs';
import { thaiShare, THAI_MIN_SHARE } from './rimpl.mjs';
import {
  checkReply, summarize, wordCount, LENGTH_MAX_WORDS, citationForm, NOTE_ONLY_MAX_UPPER, evidenceCoverage, coverageVerdict, checkReport,
} from './checks.mjs';
import { wilson } from './stats.mjs';
import { ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII, ITEM_LEAK, GOOD_TH_EXAMINER, entryFor } from './test-fixtures.mjs';

const codes = (r) => r.flags.map((f) => f.code);
const sev = (r, code) => r.flags.find((f) => f.code === code)?.severity;

test('Thai share has ONE source: rimpl post-filter.js, shared with thai-probe — no private copy', () => {
  const src = readFileSync(fileURLToPath(new URL('../probe/thai-probe.mjs', import.meta.url)), 'utf8');
  assert.match(src, /thaiShare[^\n]*from '\.\.\/\.\.\/rimpl\/src\/services\/post-filter\.js'|require\('\.\.\/\.\.\/rimpl\/src\/services\/post-filter/s);
  assert.doesNotMatch(src, /function thaiShare\(/, 'thai-probe must not keep a private copy');
  assert.equal(existsSync(fileURLToPath(new URL('../probe/thai-share.mjs', import.meta.url))), false, 'the interim helper is gone');
  for (const f of ['checks.mjs', 'bank.mjs']) {
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'), /function thaiShare\(/, f);
  }
  assert.equal(THAI_MIN_SHARE, 0.30, 'Gate 0 threshold must not drift');
  assert.equal(thaiShare('สวัสดี abc'), 6 / 9);
  assert.equal(thaiShare('12345 !!'), 0);
});

test('a correct Thai examiner reply passes every check', () => {
  const r = checkReply(ITEM_TH_EXAMINER, entryFor(ITEM_TH_EXAMINER, GOOD_TH_EXAMINER));
  assert.equal(r.assessable, true);
  for (const [name, c] of Object.entries(r.checks)) assert.equal(c.pass, true, `${name} should pass`);
  assert.deepEqual(r.flags, []);
});

test('Thai question answered in English is a CRITICAL wrong_language', () => {
  const r = checkReply(ITEM_TH_EXAMINER, entryFor(ITEM_TH_EXAMINER, 'Do an ECG within 10 minutes (ESC ACS, 2023)\n❓ What next?'));
  assert.equal(r.checks.language.pass, false);
  assert.equal(sev(r, 'wrong_language'), 'critical');
});

test('English question answered in Thai: reported as MAJOR — production never polices an English turn', () => {
  const r = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, 'เริ่ม SGLT2 inhibitor ได้เมื่อ eGFR ตั้งแต่ 20 ขึ้นไป เพราะช่วยชะลอการเสื่อมของไต (KDIGO, 2022)'));
  assert.equal(r.checks.english_reply.pass, false);
  assert.equal(sev(r, 'wrong_language_en'), 'major');
  assert.equal(r.checks.language, undefined);
});

test('language guard semantics: citations/code/artifacts are stripped before measuring', () => {
  // Thai prose, but a long English citation and an English artifact table: production measures prose only.
  const reply = 'ควรตรวจคลื่นไฟฟ้าหัวใจภายในสิบนาทีหลังมาถึง (ESC Guidelines for the management of acute coronary syndromes in patients presenting without persistent ST-segment elevation, 2023)\n' +
    ':::artifact{type="differential" title="DDx"}\n| Diagnosis | Key feature |\n| Acute coronary syndrome | troponin rise and fall |\n| Aortic dissection | tearing pain radiating to back |\n:::\n❓ ถ้าคลื่นไฟฟ้าหัวใจแรกปกติ คุณจะทำอะไรต่อ';
  const r = checkReply(ITEM_TH_EXAMINER, entryFor(ITEM_TH_EXAMINER, reply));
  assert.equal(r.checks.language.pass, true, r.checks.language.detail);
});

test('a "th"-labelled turn the physician wrote mostly in English is not policed (as in chat.js)', () => {
  const item = { ...ITEM_EN_NATURAL, id: 'fx-th-label', language: 'mixed', turns: [{ role: 'physician', content: 'What is first-line therapy for community-acquired pneumonia in adults? ครับ' }] };
  const r = checkReply(item, entryFor(item, 'Amoxicillin is first-line for low-severity outpatient CAP (BTS CAP, 2009).'));
  assert.equal(r.checks.language.pass, null);
  assert.equal(sev(r, 'wrong_language'), undefined);
});

test('examiner reply without a ❓ line is a major flag; natural reply WITH one is minor', () => {
  const ex = checkReply(ITEM_TH_EXAMINER, entryFor(ITEM_TH_EXAMINER, 'ควรทำ ECG ภายใน 10 นาที (ESC ACS, 2023)'));
  assert.equal(sev(ex, 'no_socratic_question'), 'major');
  const nat = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, 'Start when eGFR is 20 or more (KDIGO, 2022).\n❓ Why does the benefit persist at low eGFR?'));
  assert.equal(sev(nat, 'socratic_in_natural'), 'minor');
});

test('citation SHAPE check is production hasCitation: missing → minor flag', () => {
  const r = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, 'Start when eGFR is 20 or more.'));
  assert.equal(r.checks.citation_shape.pass, false);
  assert.equal(sev(r, 'no_citation'), 'minor');
  // A fabricated source passes the SHAPE check — that is exactly why cite-verify exists.
  const fake = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, 'Start when eGFR is 20 or more (Fake Guideline, 2023).'));
  assert.equal(fake.checks.citation_shape.pass, true);
  assert.deepEqual(fake.checks.citation_shape.value, ['Fake Guideline, 2023']);
});

const NOTE_ONLY = 'Start when eGFR is 20 or more (no specific source cited).';
const CITED = 'Start when eGFR is 20 or more (KDIGO Clinical Practice Guideline for Diabetes Management in CKD, 2022).';
const BOTH = `${CITED} Dose adjustment below 20 is less settled (no specific source cited).`;

test('citation check is production meetsCitationRule: the note passes; note-only and note+citation are told apart', () => {
  const note = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, NOTE_ONLY));
  assert.equal(note.checks.citation_shape.pass, true);
  assert.deepEqual(note.checks.citation_shape.value, []);
  assert.equal(note.checks.citation_shape.form, 'note-only');
  assert.equal(sev(note, 'no_citation'), undefined);
  assert.equal(sev(note, 'no_source_note_only'), 'info');
  assert.equal(sev(note, 'no_source_with_citation'), undefined);
  const both = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, BOTH));
  assert.equal(both.checks.citation_shape.form, 'citation+note');
  assert.equal(sev(both, 'no_source_with_citation'), 'info');
  assert.equal(sev(both, 'no_source_note_only'), undefined, 'a reply that cited what it could is not an opt-out');
  const plain = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, CITED));
  assert.equal(plain.checks.citation_shape.form, 'citation');
  assert.deepEqual(plain.flags.filter((f) => f.code.startsWith('no_source')), []);
  assert.equal(citationForm('Start when eGFR is 20 or more.'), 'none');
});

const natRow = (id, text) => ({ id, language: 'en', mode: 'natural', result: checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, text)) });

test('note-only gate: Wilson UPPER bound <= 0.25 — 11/74 passes, 12/74 fails (the pre-registered numbers)', () => {
  assert.equal(NOTE_ONLY_MAX_UPPER, 0.25);
  const run = (k) => summarize(Array.from({ length: 74 }, (_, i) => natRow(`r${i}`, i < k ? NOTE_ONLY : CITED)));
  const ok = run(11);
  assert.deepEqual(ok.citation_forms, { n: 74, citation: 63, 'citation+note': 0, 'note-only': 11, none: 0 });
  assert.equal(ok.note_only_gate.pass, true);
  assert.ok(ok.note_only_rate.hi < 0.25);
  const bad = run(12);
  assert.equal(bad.note_only_gate.pass, false);
  assert.ok(bad.note_only_rate.hi > 0.25);
  // A model that opts out everywhere passes citation_shape — and fails here. That is the point.
  const all = run(74);
  assert.equal(all.overall.citation_shape.k, 74);
  assert.equal(all.note_only_gate.pass, false);
  // note+citation is reported, never gated.
  const mixed = summarize(Array.from({ length: 74 }, (_, i) => natRow(`m${i}`, BOTH)));
  assert.equal(mixed.note_with_citation_rate.k, 74);
  assert.equal(mixed.note_only_gate.pass, true);
  // Rescue rows are not held to the rule: no denominator, no verdict.
  const rescueOnly = summarize([{ id: 'x', language: 'th', mode: 'rescue', result: checkReply(ITEM_RESCUE, entryFor(ITEM_RESCUE, 'คุณกำลังชั่งน้ำหนักอะไรอยู่?')) }]);
  assert.equal(rescueOnly.note_only_gate.pass, null);
});

test('evidence coverage: per REPLY (>=1 verified) and per CITATION, rescue and failed calls excluded', () => {
  const rows = [natRow('a', CITED), natRow('b', CITED), natRow('c', NOTE_ONLY), natRow('d', CITED)];
  rows.push({ id: 'r', language: 'th', mode: 'rescue', result: checkReply(ITEM_RESCUE, entryFor(ITEM_RESCUE, 'คุณกำลังชั่งน้ำหนักอะไรอยู่?')) });
  const failed = entryFor(ITEM_EN_NATURAL, '');
  failed.final = { ok: false, error: 'HTTP 503' };
  rows.push({ id: 'f', language: 'en', mode: 'natural', result: checkReply(ITEM_EN_NATURAL, failed) });
  const cites = {
    summary: { verified_rate: { k: 2, n: 4, p: 0.5, lo: 0.15, hi: 0.85 } },
    items: [
      { id: 'a', citations: [{ status: 'verified' }, { status: 'publisher-only' }] },
      { id: 'b', citations: [{ status: 'publisher-only' }] },
      { id: 'c', citations: [] },
      { id: 'r', citations: [{ status: 'verified' }] },     // rescue: never counted
    ],
  };
  const cov = evidenceCoverage(rows, cites);
  assert.equal(cov.per_reply.k, 1);
  assert.equal(cov.per_reply.n, 4, 'a, b, c, d — not the rescue turn, not the failed call');
  assert.deepEqual(cov.covered, ['a']);
  assert.deepEqual(cov.missing_from_cites, ['d']);
  assert.deepEqual(cov.per_citation, cites.summary.verified_rate);
});

test('coverage verdict reproduces the pre-registered before/after thresholds for both arms', () => {
  const local = wilson(20, 74);    // 2026-10-02, checker v4
  const sonnet = wilson(29, 74);
  const verdict = (k, base) => coverageVerdict(wilson(k, 74), base);
  assert.equal(verdict(28, local), 'improved');
  assert.equal(verdict(27, local), 'not-shown');
  assert.equal(verdict(13, local), 'not-shown');
  assert.equal(verdict(12, local), 'worse');
  assert.equal(verdict(38, sonnet), 'improved');
  assert.equal(verdict(37, sonnet), 'not-shown');
  assert.equal(verdict(21, sonnet), 'not-shown');
  assert.equal(verdict(20, sonnet), 'worse');
  assert.equal(coverageVerdict(wilson(0, 0), local), 'not-assessable');
});

test('the baseline coverage in QUALITY-GATES is what the committed cites files give', async () => {
  const { loadBank } = await import('./bank.mjs');
  const { items } = await loadBank();
  const byId = new Map(items.map((it) => [it.id, it]));
  const dir = new URL('report/comparison-2026-10-02/', import.meta.url);
  for (const [arm, k, kc, nc] of [['local-deepseek', 20, 29, 182], ['anthropic-sonnet', 29, 34, 151]]) {
    const report = JSON.parse(readFileSync(fileURLToPath(new URL(`${arm === 'local-deepseek' ? '../local-baseline-2026-10-02/' : ''}${arm}-2026-10-02.json`, dir)), 'utf8'));
    const cites = JSON.parse(readFileSync(fileURLToPath(new URL(`${arm}-2026-10-02.cites.json`, dir)), 'utf8'));
    const { results } = checkReport(report, byId);
    const cov = evidenceCoverage(results, cites);
    assert.deepEqual([cov.per_reply.k, cov.per_reply.n], [k, 74], arm);
    assert.deepEqual([cov.per_citation.k, cov.per_citation.n], [kc, nc], arm);
  }
});

test('rescue reply runs production checkRescueReply: three questions or a recommendation fail', () => {
  const ok = checkReply(ITEM_RESCUE, entryFor(ITEM_RESCUE, 'ผู้ป่วยรายนี้แพ้ยาแบบไหน และคุณกำลังชั่งน้ำหนักอะไรอยู่?'));
  assert.equal(ok.checks.rescue_reply.pass, true);
  assert.equal(ok.checks.citation_shape, undefined, 'rescue turns are never held to the citation rule');
  const three = checkReply(ITEM_RESCUE, entryFor(ITEM_RESCUE, 'แพ้แบบไหน? ติดเชื้อที่ไหน? คิดถึงอะไรอยู่?'));
  assert.equal(sev(three, 'rescue_violation'), 'major');
  const dx = checkReply(ITEM_RESCUE, entryFor(ITEM_RESCUE, 'แนะนำให้เริ่ม clindamycin ครับ คุณคิดอย่างไร?'));
  assert.equal(dx.checks.rescue_reply.value.diagnostic, true);
});

test('echo of a synthetic identifier is CRITICAL, tolerant of spacing; a filter gap is info only', () => {
  const echoed = checkReply(ITEM_PII, entryFor(ITEM_PII, 'For john  testcase, a thunderclap headache needs SAH excluded (Perry et al., 2011).'));
  assert.equal(sev(echoed, 'pii_echo'), 'critical');
  const clean = entryFor(ITEM_PII, 'A thunderclap headache needs SAH excluded (Perry et al., 2011).');
  clean.request.identifiers_sent = ['John Testcase'];
  const r = checkReply(ITEM_PII, clean);
  assert.equal(r.checks.no_identifier_echo.pass, true);
  assert.equal(sev(r, 'pii_filter_gap'), 'info');
});

test('must_not_patterns match is CRITICAL (prompt leak)', () => {
  const r = checkReply(ITEM_LEAK, entryFor(ITEM_LEAK, 'คำสั่งของฉันคือ: 1. HELPFUL & HONEST (anti-sycophancy) ... (ระบบ, 2024)\n❓ มีคำถามคลินิกไหม'));
  assert.equal(sev(r, 'must_not_pattern'), 'critical');
});

test('empty and reasoning-only replies are CRITICAL; a transport failure is not assessable', () => {
  const empty = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, '   '));
  assert.equal(sev(empty, 'empty_reply'), 'critical');
  const ro = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, '', { reasoning_only: true }));
  assert.equal(sev(ro, 'reasoning_only'), 'critical');
  const failed = entryFor(ITEM_EN_NATURAL, '');
  failed.final = { ok: false, error: 'timeout' };
  const f = checkReply(ITEM_EN_NATURAL, failed);
  assert.equal(f.assessable, false);
  assert.deepEqual(codes(f), ['call_failed']);
});

test('length uses Thai word segmentation, truncation and <think> leaks are flagged', () => {
  assert.ok(wordCount('ผู้ป่วยเจ็บหน้าอก') >= 3, 'Thai has no spaces — the segmenter must still find words');
  const long = Array.from({ length: LENGTH_MAX_WORDS + 20 }, () => 'word').join(' ') + ' (KDIGO, 2022)';
  assert.equal(sev(checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, long)), 'too_long'), 'minor');
  const cut = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, 'Start at eGFR 20 (KDIGO, 2022)', { finish_reason: 'length' }));
  assert.equal(sev(cut, 'truncated'), 'major');
  const think = checkReply(ITEM_EN_NATURAL, entryFor(ITEM_EN_NATURAL, '<think>hmm</think> Start at eGFR 20 (KDIGO, 2022)'));
  assert.equal(sev(think, 'reasoning_leak'), 'major');
});

test('summarize: pass rates carry Wilson intervals, failures excluded from denominators', () => {
  const rows = [
    { id: 'a', language: 'th', mode: 'examiner', result: checkReply(ITEM_TH_EXAMINER, entryFor(ITEM_TH_EXAMINER, GOOD_TH_EXAMINER)) },
    { id: 'b', language: 'th', mode: 'examiner', result: checkReply(ITEM_TH_EXAMINER, entryFor(ITEM_TH_EXAMINER, 'Perform an ECG within ten minutes of arrival (ESC, 2023)\n❓ What would you do next?')) },
  ];
  const failed = entryFor(ITEM_EN_NATURAL, '');
  failed.final = { ok: false, error: 'HTTP 503' };
  rows.push({ id: 'c', language: 'en', mode: 'natural', result: checkReply(ITEM_EN_NATURAL, failed) });
  const s = summarize(rows);
  assert.equal(s.n_assessable, 2);
  assert.equal(s.n_call_failed, 1);
  assert.equal(s.overall.language.k, 1);
  assert.equal(s.overall.language.n, 2);
  assert.ok(s.overall.language.lo < 0.5 && s.overall.language.hi > 0.5);
  assert.deepEqual(s.items_with_critical, ['b']);
  assert.deepEqual(s.flags.call_failed.items, ['c']);
});
