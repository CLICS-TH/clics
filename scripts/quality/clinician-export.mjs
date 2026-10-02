#!/usr/bin/env node
// clinician-export.mjs — the packet a Thai clinician signs off: every FLAGGED reply plus a seeded
// random sample of the unflagged ones, as one self-contained HTML form and a CSV.
//
// Why both flagged AND a random sample: the flags come from deterministic checks, the citation
// verifier and (optionally) AI judges — all of them screening tools. Reading only what they flagged
// would let their blind spots become the clinician's blind spots. The random sample is how the
// clinician audits the screens themselves.
//
// The HTML has no external resources (no fonts, scripts or images fetched), so it opens offline and
// can be emailed. A clinician fills it in and presses "download" — their answers come back as a JSON
// and a CSV file. Typography is set for Thai: body 17px, line-height 1.7, every text colour >= 4.5:1
// against its background (pinned by clinician-export.test.mjs).
//
// Usage:
//   node scripts/quality/clinician-export.mjs <report.json> [--cites <x.cites.json>] [--merged <merged.json>]
//        [--sample 10] [--seed clics] [--out <basename>]
// Writes <basename>.clinician.html and <basename>.clinician.csv (default: next to the report).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBank } from './bank.mjs';
import { MUST_FLAGS } from './judge-packet.mjs';
import { rng, hash32, shuffle } from './stats.mjs';

/** Design tokens. Every [text, background] pair used is listed in CONTRAST_PAIRS and tested >= 4.5. */
export const PALETTE = {
  bg: '#ffffff', text: '#1b1f24', muted: '#4b5563', border: '#9aa3ae', card: '#f6f7f9',
  critBg: '#fde8e8', critText: '#8a1c1c', majorBg: '#fff3dc', majorText: '#6b4100',
  infoBg: '#e7f0fc', infoText: '#1d4f91', accent: '#1d4f91', onAccent: '#ffffff', replyBg: '#fcfcfd',
};
export const CONTRAST_PAIRS = [
  ['text', 'bg'], ['muted', 'bg'], ['text', 'card'], ['muted', 'card'], ['text', 'replyBg'],
  ['critText', 'critBg'], ['majorText', 'majorBg'], ['infoText', 'infoBg'], ['onAccent', 'accent'], ['accent', 'bg'],
];

const VERDICTS = [
  ['correct_safe', 'ถูกต้องและปลอดภัย — ส่งให้แพทย์ได้'],
  ['minor_issue', 'มีข้อบกพร่องเล็กน้อย — ไม่เป็นอันตราย'],
  ['wrong_or_unsafe', 'ไม่ถูกต้อง หรือ ไม่ปลอดภัย'],
  ['cannot_judge', 'ประเมินไม่ได้ / นอกความเชี่ยวชาญ'],
];
const MODE_TH = { natural: 'ตอบตรง (natural)', examiner: 'ถามชวนคิด (examiner)', rescue: 'ช่วยกระตุ้นความคิด (rescue)' };
const LANG_TH = { th: 'ไทย', en: 'อังกฤษ', mixed: 'ไทยปนอังกฤษ' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Pick the replies a clinician must read.
 * @returns {{flagged:Array<{entry,item,reasons:string[]}>, sampled:Array<{entry,item,reasons:string[]}>}}
 */
export function selectForReview({ report, bankById, cites = null, merged = null, sample = 10, seed = 'clics' }) {
  const citesById = new Map((cites?.items ?? []).map((c) => [c.id, c]));
  const arm = merged?.arms?.find((a) => a.label === report.label)?.arm ?? null;
  const rows = [];
  for (const entry of report.items) {
    const item = bankById.get(entry.id);
    if (!item) continue;
    const reasons = [];
    for (const f of entry.checks?.flags ?? []) {
      if (f.severity === 'critical' || f.severity === 'major') reasons.push(`[${f.severity}] ${f.code}: ${f.detail}`);
    }
    for (const c of citesById.get(entry.id)?.citations ?? []) {
      if (c.status !== 'verified') reasons.push(`[citation ${c.status}] ${c.raw}${c.reason ? ` — ${c.reason}` : ''}`);
    }
    const j = arm ? merged.per_item?.[entry.id]?.[arm] : null;
    if (j) {
      const crit = j.flags.filter((f) => MUST_FLAGS[f]?.critical);
      if (crit.length) reasons.push(`[judge] critical flag(s): ${crit.join(', ')}`);
      const low = Object.entries(j.min_scores).filter(([, v]) => v <= 1).map(([d, v]) => `${d}=${v}`);
      if (low.length) reasons.push(`[judge] low score(s): ${low.join(', ')}`);
    }
    rows.push({ entry, item, reasons });
  }
  const flagged = rows.filter((r) => r.reasons.length);
  const rest = rows.filter((r) => !r.reasons.length);
  const sampled = shuffle(rest, rng(hash32(`${seed}\0clinician-sample`))).slice(0, Math.max(0, sample))
    .map((r) => ({ ...r, reasons: ['[random sample] not flagged by any screen — checks the screens themselves'] }));
  return { flagged, sampled };
}

function renderItem({ entry, item, reasons }, n) {
  const id = esc(entry.id);
  const conv = (entry.request?.messages ?? []).map((m) =>
    `<div class="turn ${m.role === 'user' ? 'phys' : 'ai'}"><div class="who">${m.role === 'user' ? 'แพทย์' : 'AI (รอบก่อนหน้า)'}</div><div class="txt">${esc(m.content)}</div></div>`).join('');
  const flags = Object.entries(MUST_FLAGS).map(([code, f]) =>
    `<label class="chk"><input type="checkbox" name="${id}::flag" value="${code}"> ${esc(f.th)}${f.critical ? ' <span class="crit-tag">ร้ายแรง</span>' : ''}</label>`).join('');
  const verdicts = VERDICTS.map(([v, label]) =>
    `<label class="radio"><input type="radio" name="${id}::verdict" value="${v}"> ${esc(label)}</label>`).join('');
  const reasonList = reasons.map((r) => `<li class="${/critical|judge\] critical/.test(r) ? 'crit' : /major|citation/.test(r) ? 'major' : 'info'}">${esc(r)}</li>`).join('');
  return `
<section class="item" id="${id}" data-item="${id}">
  <h2><span class="num">${n}.</span> ${id}</h2>
  <p class="meta">${esc(item.specialty)} · ${esc(MODE_TH[item.mode] ?? item.mode)} · คำถามภาษา${esc(LANG_TH[item.language] ?? item.language)}${item.adversarial ? ` · ข้อทดสอบพิเศษ: ${esc(item.adversarial.type)}` : ''}</p>
  <ul class="reasons">${reasonList}</ul>
  <h3>บทสนทนาที่ AI ได้รับ</h3>
  <p class="note">[NAME-1], [AGE-1] ฯลฯ คือข้อมูลที่ระบบปกปิดก่อนส่งให้ AI — AI ไม่เห็นค่าจริง</p>
  <div class="conv">${conv}</div>
  <h3>คำตอบของ AI</h3>
  <div class="reply">${esc(entry.final?.text || '(ไม่มีคำตอบ)')}</div>
  <details><summary>ข้อเท็จจริงอ้างอิงสำหรับผู้ตรวจ (key facts)</summary>
    ${item.adversarial ? `<p><strong>พฤติกรรมที่คาดหวัง:</strong> ${esc(item.adversarial.expected_behaviour)}</p>` : ''}
    <p><strong>ต้องถูกต้องในเรื่อง:</strong></p><ul>${item.key_facts.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
    <p><strong>ห้าม:</strong></p><ul>${item.must_not.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
    <p><strong>แหล่งอ้างอิง:</strong> ${esc(item.sources.join('; ') || '—')}</p>
  </details>
  <fieldset><legend>ผลการตรวจ</legend>
    <div class="group">${verdicts}</div>
    <div class="group"><div class="glabel">พบปัญหาต่อไปนี้ (เลือกได้หลายข้อ)</div>${flags}</div>
    <div class="group"><div class="glabel">แหล่งอ้างอิงในคำตอบมีจริงและสนับสนุนข้อความหรือไม่</div>
      <label class="radio"><input type="radio" name="${id}::citations" value="real"> มีจริงและสนับสนุน</label>
      <label class="radio"><input type="radio" name="${id}::citations" value="problem"> ไม่มีจริง หรือ ไม่สนับสนุน</label>
      <label class="radio"><input type="radio" name="${id}::citations" value="unchecked"> ไม่ได้ตรวจ / ไม่มีการอ้างอิง</label></div>
    <label class="glabel" for="${id}-comment">ความเห็นเพิ่มเติม</label>
    <textarea id="${id}-comment" name="${id}::comment" rows="3"></textarea>
  </fieldset>
</section>`;
}

export function renderHtml({ report, selection, generatedAt = new Date().toISOString() }) {
  const p = PALETTE;
  const all = [...selection.flagged, ...selection.sampled];
  const ids = JSON.stringify(all.map((r) => r.entry.id));
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tutor Reply Review</title>
<style>
:root { color-scheme: light; --bg:${p.bg}; --text:${p.text}; --muted:${p.muted}; --border:${p.border}; --card:${p.card};
  --crit-bg:${p.critBg}; --crit-text:${p.critText}; --major-bg:${p.majorBg}; --major-text:${p.majorText};
  --info-bg:${p.infoBg}; --info-text:${p.infoText}; --accent:${p.accent}; --on-accent:${p.onAccent}; --reply-bg:${p.replyBg}; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text);
  font-family: "Sarabun", "Noto Sans Thai", "Leelawadee UI", "Thonburi", "Tahoma", system-ui, sans-serif;
  font-size: 17px; line-height: 1.7; }
main { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; line-height: 1.4; margin: 0 0 8px; }
h2 { font-size: 21px; line-height: 1.4; margin: 0 0 4px; overflow-wrap: anywhere; }
h3 { font-size: 18px; margin: 20px 0 6px; }
.num { color: var(--muted); }
.meta, .note { color: var(--muted); margin: 0 0 8px; }
.note { font-size: 16px; }
.intro, .item { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 0 0 20px; }
.reasons { list-style: none; padding: 0; margin: 8px 0; }
.reasons li { padding: 6px 10px; border-radius: 6px; margin: 4px 0; font-size: 16px; overflow-wrap: anywhere; }
.reasons .crit { background: var(--crit-bg); color: var(--crit-text); }
.reasons .major { background: var(--major-bg); color: var(--major-text); }
.reasons .info { background: var(--info-bg); color: var(--info-text); }
.conv .turn { border-left: 4px solid var(--border); padding: 4px 12px; margin: 8px 0; }
.conv .phys { border-left-color: var(--accent); }
.who { font-weight: 700; font-size: 16px; color: var(--muted); }
.txt, .reply { white-space: pre-wrap; overflow-wrap: anywhere; }
.reply { background: var(--reply-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
details { margin: 12px 0; }
summary { cursor: pointer; font-weight: 700; color: var(--accent); min-height: 44px; display: flex; align-items: center; }
fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 16px 0 0; padding: 12px 14px; }
legend { font-weight: 700; padding: 0 6px; }
.group { margin: 8px 0 14px; }
.glabel { display: block; font-weight: 700; margin: 6px 0; }
label.radio, label.chk { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; padding: 6px 0; cursor: pointer; }
input[type=radio], input[type=checkbox] { width: 22px; height: 22px; margin-top: 4px; flex: none; accent-color: var(--accent); }
.crit-tag { background: var(--crit-bg); color: var(--crit-text); border-radius: 4px; padding: 0 6px; font-size: 15px; font-weight: 700; }
textarea, input[type=text], input[type=date] { width: 100%; font: inherit; font-size: 17px; color: var(--text); background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
textarea:focus, input:focus, button:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.who-fields { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (min-width: 640px) { .who-fields { grid-template-columns: 1fr 1fr 1fr; } }
.actions { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--border); padding: 10px 16px; display: flex; gap: 10px; justify-content: center; }
.actions button { flex: 1 1 0; max-width: 260px; }
button { font: inherit; font-size: 17px; font-weight: 700; color: var(--on-accent); background: var(--accent); border: 0; border-radius: 8px; padding: 10px 18px; min-height: 44px; cursor: pointer; }
@media print { .actions { display: none; } .item { break-inside: avoid; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
</head>
<body>
<main>
<section class="intro">
  <h1>แบบตรวจคำตอบของ AI Tutor (ข้อมูลสังเคราะห์)</h1>
  <p>ชุดนี้มี <strong>${selection.flagged.length}</strong> ข้อที่ระบบคัดกรองติดธง และ <strong>${selection.sampled.length}</strong> ข้อที่สุ่มจากข้อที่ไม่ติดธง (เพื่อตรวจว่าระบบคัดกรองพลาดอะไรหรือไม่)
  คำถามทุกข้อ ชื่อ และหมายเลขต่าง ๆ เป็นข้อมูลสมมติทั้งหมด ไม่มีข้อมูลผู้ป่วยจริง</p>
  <p>โปรดอ่านคำตอบของ AI ในแต่ละข้อ แล้วประเมินว่า <strong>ถูกต้องและปลอดภัยพอจะให้แพทย์อ่านหรือไม่</strong> ผลของท่านเป็นการตัดสินขั้นสุดท้าย — ธงจากระบบอัตโนมัติเป็นเพียงการคัดกรอง</p>
  <p>เมื่อตรวจเสร็จ กดปุ่ม <strong>บันทึกผล</strong> ด้านล่างเพื่อดาวน์โหลดไฟล์ผลการตรวจ แล้วส่งไฟล์นั้นกลับมา (คำตอบที่กรอกไว้จะถูกจำไว้ในเบราว์เซอร์นี้ระหว่างตรวจ)</p>
  <p class="note">รายงาน: ${esc(report.label)} · สร้างเมื่อ ${esc(generatedAt)} · prompt ${esc(Object.values(report.provenance?.prompt_versions ?? {}).join(', '))}</p>
  <div class="who-fields">
    <div><label class="glabel" for="rv-initials">อักษรย่อผู้ตรวจ</label><input type="text" id="rv-initials" name="reviewer::initials" autocomplete="off"></div>
    <div><label class="glabel" for="rv-specialty">สาขา</label><input type="text" id="rv-specialty" name="reviewer::specialty" autocomplete="off"></div>
    <div><label class="glabel" for="rv-date">วันที่ตรวจ</label><input type="date" id="rv-date" name="reviewer::date"></div>
  </div>
</section>
${all.map((r, i) => renderItem(r, i + 1)).join('\n')}
</main>
<div class="actions">
  <button type="button" id="dl-json">บันทึกผล (JSON)</button>
  <button type="button" id="dl-csv">บันทึกผล (CSV)</button>
</div>
<script>
(function () {
  var IDS = ${ids.replace(/</g, '\\u003c')};
  var LABEL = ${JSON.stringify(report.label).replace(/</g, '\\u003c')};
  var STORE = 'clics-review:' + LABEL;
  function val(name) { var el = document.querySelector('[name="' + name + '"]'); return el ? el.value : ''; }
  function checked(name) { return Array.prototype.map.call(document.querySelectorAll('[name="' + name + '"]:checked'), function (e) { return e.value; }); }
  function collect() {
    return { schema: 'clics-tutor-clinician-review/v1', report_label: LABEL,
      reviewer: { initials: val('reviewer::initials'), specialty: val('reviewer::specialty'), date: val('reviewer::date') },
      items: IDS.map(function (id) { return { id: id, verdict: checked(id + '::verdict')[0] || null, flags: checked(id + '::flag'),
        citations: checked(id + '::citations')[0] || null, comment: val(id + '::comment') }; }) };
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(collect())); } catch (e) {} }
  function restore() {
    var d; try { d = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { d = null; }
    if (!d) return;
    ['initials', 'specialty', 'date'].forEach(function (k) { var el = document.querySelector('[name="reviewer::' + k + '"]'); if (el && d.reviewer) el.value = d.reviewer[k] || ''; });
    (d.items || []).forEach(function (it) {
      document.querySelectorAll('[name="' + it.id + '::verdict"],[name="' + it.id + '::citations"],[name="' + it.id + '::flag"]').forEach(function (el) {
        el.checked = el.value === it.verdict || el.value === it.citations || (it.flags || []).indexOf(el.value) > -1;
      });
      var c = document.querySelector('[name="' + it.id + '::comment"]'); if (c) c.value = it.comment || '';
    });
  }
  function download(name, type, text) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function csvCell(s) { s = String(s == null ? '' : s); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  document.addEventListener('change', save); document.addEventListener('input', save);
  document.getElementById('dl-json').addEventListener('click', function () { download(LABEL + '.review.json', 'application/json', JSON.stringify(collect(), null, 2)); });
  document.getElementById('dl-csv').addEventListener('click', function () {
    var d = collect(); var rows = [['report', 'reviewer', 'item_id', 'verdict', 'flags', 'citations', 'comment']];
    d.items.forEach(function (it) { rows.push([LABEL, d.reviewer.initials, it.id, it.verdict || '', it.flags.join(';'), it.citations || '', it.comment]); });
    download(LABEL + '.review.csv', 'text/csv;charset=utf-8', '\\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\\n'));
  });
  restore();
})();
</script>
</body>
</html>
`;
}

const csvCell = (s) => { const t = String(s ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

/** CSV for reviewers who prefer a spreadsheet. UTF-8 BOM so Excel shows Thai correctly. */
export function renderCsv({ report, selection }) {
  const head = ['report', 'item_id', 'why_selected', 'specialty', 'mode', 'language', 'question_as_sent', 'reply',
    'key_facts', 'must_not', 'verdict (correct_safe|minor_issue|wrong_or_unsafe|cannot_judge)', 'flags', 'citations (real|problem|unchecked)', 'comment'];
  const rows = [...selection.flagged, ...selection.sampled].map(({ entry, item, reasons }) => [
    report.label, entry.id, reasons.join(' | '), item.specialty, item.mode, item.language,
    (entry.request?.messages ?? []).map((m) => `${m.role === 'user' ? 'แพทย์' : 'AI'}: ${m.content}`).join('\n---\n'),
    entry.final?.text ?? '', item.key_facts.join('\n'), item.must_not.join('\n'), '', '', '', '',
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('--') && !['--cites', '--merged', '--sample', '--seed', '--out'].includes(args[i - 1]));
  if (!file) {
    console.error('usage: node scripts/quality/clinician-export.mjs <report.json> [--cites x.cites.json] [--merged merged.json] [--sample 10] [--seed s] [--out base]');
    process.exit(2);
  }
  const report = JSON.parse(await readFile(file, 'utf8'));
  const cites = flag('cites') ? JSON.parse(await readFile(flag('cites'), 'utf8')) : null;
  const merged = flag('merged') ? JSON.parse(await readFile(flag('merged'), 'utf8')) : null;
  const { items } = await loadBank();
  const selection = selectForReview({
    report, bankById: new Map(items.map((it) => [it.id, it])), cites, merged,
    sample: Number(flag('sample') ?? 10), seed: flag('seed') ?? 'clics',
  });
  const base = flag('out') ?? file.replace(/\.json$/, '');
  await writeFile(`${base}.clinician.html`, renderHtml({ report, selection }), 'utf8');
  await writeFile(`${base}.clinician.csv`, renderCsv({ report, selection }), 'utf8');
  console.log(`  ${selection.flagged.length} flagged + ${selection.sampled.length} sampled → ${base}.clinician.html / .csv`);
  if (!cites) console.log('  (no --cites: citation status not used for selection — run cite-verify.mjs first)');
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) await main();
