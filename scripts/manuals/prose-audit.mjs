#!/usr/bin/env node
/*
 * Prose audit — the checks the rendering gates cannot make.
 *
 * npm run test:readability already proves the manual is LEGIBLE: contrast, the 12px Thai floor, no
 * clipping. None of that says the words are RIGHT. A bilingual manual has a failure mode no pixel
 * measurement can see: the two languages quietly stop saying the same thing. A reader picks one and
 * gets that version only, so a warning dropped from the English half is invisible to every Thai
 * reader who reviews it, and vice versa.
 *
 * WHAT IS MECHANICAL AND WHAT IS NOT. Structure and numbers are objective — a `warn` in one language
 * and a `note` in the other is a defect, not a style choice, and "10 minutes" in Thai against "ten
 * minutes" in English is a parity question with a right answer. Those FAIL. Wording, register and
 * tone are judgment; this file flags them and stops there. The readable skill's rule: fix the
 * objective gates, flag VOICE and READ for a human.
 *
 *   node scripts/manuals/prose-audit.mjs            # everything
 *   node scripts/manuals/prose-audit.mjs --advice   # include the advisory checks
 *
 * Exit 0 = no objective defect. Exit 1 = at least one. Advisory findings never change the exit code.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSections } from './lib/parse.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ADVICE = process.argv.includes('--advice');
const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };

const MANUALS = ['physician', 'auditor'];

// ---- terminology --------------------------------------------------------------------------------
// One concept, one word — per language. A reader who meets an episode called three different things
// has to work out whether they are three things. Each rule lists the ACCEPTED term first; every
// other entry is a variant that must not appear. Deliberately short: a list nobody trusts gets
// edited around rather than obeyed.
const TERMS = {
  th: [
    { use: 'ผู้ตรวจประเมิน', avoid: ['ผู้ประเมินคะแนน'], why: 'the product calls the role ผู้ตรวจประเมิน' },
    { use: 'บทเรียน', avoid: ['เอพิโสด', 'อีพิโสด', 'เซสชัน'],
      why: 'transliterating "session"/"episode" reads as a foreign word next to บทเรียน' },
  ],
  en: [
    { use: 'episode', avoid: ['session'], why: '"session" is the database word; a reader sees an episode' },
    // `unless` keeps a real second role out of the rule: an admin doing PRIVACY review is a
    // reviewer, and is not the auditor. A rule that cannot express that gets ignored wholesale.
    { use: 'auditor', avoid: ['assessor'], why: 'the role is named auditor throughout the product' },
    { use: 'auditor', avoid: ['reviewer'], unless: /privacy|identity/i,
      why: 'the scoring role is the auditor; only privacy/identity review has a "reviewer"' },
  ],
};

// ---- English tells ------------------------------------------------------------------------------
// Phrases that mark prose as machine-written or as padding. Advisory: each one is occasionally the
// right words, which is exactly why a human decides.
const TELLS = [
  "it's worth noting", 'it is worth noting', 'it should be noted', 'please note that',
  'delve', 'seamless', 'robust', 'leverage', 'utilize', 'in order to',
  'a wide range of', 'plays a crucial role', 'plays a key role', 'it is important to note',
  'that being said', 'at the end of the day', 'needless to say',
];

const findings = [];
const add = (level, check, file, line, msg, detail) => findings.push({ level, check, file, line, msg, detail });

// ADVISORY, not a gate — and the reason is worth recording, because the instinct is to keep
// tightening it. Cross-language numeric parity cannot be decided mechanically: Thai writes the unit
// before the figure as often as after ("จำนวนรอบ ≥ 4"), spells numbers as words (หนึ่ง) alongside
// digits, and uses classifiers (ตัว, ข้อ, หลัก) that map onto no single English word. Every
// iteration of this check found a bug in ITSELF and none in the content. So it prints as a prompt to
// go and re-read a section, and PARITY below — block shape and callout severity, which are exact —
// is the check that actually fails the build.
//
// Only figures a reader ACTS ON are compared, and only when they carry a unit: "10 minutes",
// "4 exchanges", "all 5 confirmations", "0.75". Comparing every numeral instead produced a finding
// in almost every section — English writes "one of the two ways" where Thai writes "สองทาง", and
// neither is wrong. A check that fires on correct prose teaches people to ignore it, so this one is
// deliberately narrow: it catches a dropped THRESHOLD, which is the figure that changes what a
// reader does, and stays silent about everything else.
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// A unit CLASS, so a Thai unit and its English counterpart compare equal.
const UNITS = [
  ['time', /(?:นาที|minutes?)/],
  ['turns', /(?:รอบ(?:สนทนา)?|exchanges?|turns?)/],
  ['items', /(?:ข้อ|ตัว|items?|boxes|box|confirmations?|checkboxes|criteria|criterion|things?)/],
  ['domains', /(?:ด้าน|หมวด|domains?)/],
  ['episodes', /(?:ครั้ง|บทเรียน|episodes?)/],
  ['digits', /(?:หลัก|digits?)/],
  ['percent', /%/],
];

/**
 * Unit-qualified figures, as a comparable set of "class:value" strings.
 *
 * Chips are stripped first — they are verbatim product strings, identical in both files by design,
 * so leaving them in would guarantee a match and hide a real difference in the prose around them.
 */
function figures(text) {
  const src = text.replace(/\[\[[^\]]*\]\]/g, ' ');
  const out = new Set();

  for (const [cls, unit] of UNITS) {
    // digits, then the unit, within a few characters (Thai puts the unit straight after; English
    // allows an adjective: "4 further exchanges").
    const digit = new RegExp(`(\\d+(?:\\.\\d+)?)[\\s-]*(?:[a-zA-Z\\u0E00-\\u0E7F]{0,8}[\\s-]*)?${unit.source}`, 'gi');
    for (const m of src.matchAll(digit)) out.add(`${cls}:${Number(m[1])}`);

    // spelled-out English, same shape
    const words = Object.keys(WORD_NUM).join('|');
    const word = new RegExp(`\\b(${words})\\b\\s*(?:[a-zA-Z]{0,12}\\s*)?${unit.source}`, 'gi');
    for (const m of src.matchAll(word)) out.add(`${cls}:${WORD_NUM[m[1].toLowerCase()]}`);
  }

  // Bare decimals are always thresholds in this domain (the ICC gate is 0.75).
  for (const m of src.matchAll(/\b0\.\d+\b/g)) out.add(`ratio:${Number(m[0])}`);
  return [...out];
}

const blockShape = (b) => (b.t === 'callout' ? `callout:${b.kind}` : b.t);

/**
 * The independently-readable units in a block.
 *
 * A list is not one long sentence and a table is not one at all — joining them and measuring the
 * result reported a seven-row rubric table as a "716-character run", which is noise that buries the
 * one real finding. Each bullet, each step and each cell is read on its own, so each is measured on
 * its own.
 */
function textUnits(b) {
  if (b.items) return b.items.map((i) => i.map((s) => s.v).join(''));
  if (b.t === 'table') return [...b.head, ...b.rows.flat()];
  const t = blockText(b);
  return t ? [t] : [];
}

/** Flatten a block's words, for the text-level checks. */
function blockText(b) {
  if (b.spans) return b.spans.map((s) => s.v).join('');
  if (b.items) return b.items.map((i) => i.map((s) => s.v).join('')).join(' ');
  if (b.t === 'h3') return b.text;
  if (b.t === 'table') return [...b.head, ...b.rows.flat()].join(' ');
  if (b.t === 'figure') return [b.alt, b.caption].filter(Boolean).join(' ');
  return '';
}

/** Line number of a section heading, for a clickable finding. */
function lineOf(src, id) {
  const i = src.split('\n').findIndex((l) => l.trim().startsWith(`## ${id} `) || l.trim().startsWith(`## ${id}|`));
  return i < 0 ? 1 : i + 1;
}

async function readIf(p) { return readFile(join(ROOT, p), 'utf8').catch(() => null); }

for (const name of MANUALS) {
  const [thSrc, enSrc] = await Promise.all([
    readIf(`docs/manuals/content/${name}.th.md`),
    readIf(`docs/manuals/content/${name}.en.md`),
  ]);
  if (!thSrc) continue;

  const th = parseSections(thSrc, { file: `${name}.th.md` });
  const en = enSrc ? parseSections(enSrc, { file: `${name}.en.md` }) : null;

  // --- objective: the two languages describe the same document -----------------------------------
  if (en) {
    for (const [i, a] of th.entries()) {
      const b = en[i];
      if (!b || b.id !== a.id) continue; // parseManual already fails the build on id mismatch
      const file = `docs/manuals/content/${name}.en.md`;
      const line = lineOf(enSrc, b.id);

      // Block shape, in order. A `warn` demoted to a `note` in translation is a severity change
      // the reader cannot see, and it is the single most likely bilingual defect.
      const sa = a.blocks.map(blockShape);
      const sb = b.blocks.map(blockShape);
      if (sa.join(',') !== sb.join(',')) {
        const kinds = (s) => s.filter((x) => x.startsWith('callout')).join(' ');
        add('FAIL', 'PARITY', file, line,
          `section "${a.id}": the Thai and English halves are not the same shape`,
          `  th: ${sa.join(' ')}\n  en: ${sb.join(' ')}`
          + (kinds(sa) !== kinds(sb) ? `\n  callout severities differ — th: ${kinds(sa) || '(none)'} · en: ${kinds(sb) || '(none)'}` : ''));
      }

      // Thresholds a reader acts on. Advisory — see the note on figures() for why this cannot be
      // decided mechanically across Thai and English.
      const na = figures(a.blocks.map(blockText).join(' '));
      const nb = figures(b.blocks.map(blockText).join(' '));
      const only = (x, y) => [...new Set(x)].filter((v) => !y.includes(v));
      const missTh = only(na, nb);
      const missEn = only(nb, na);
      if (missTh.length || missEn.length) {
        add('ADVICE', 'NUMBERS', file, line,
          `section "${a.id}": a threshold appears in one language and not the other`,
          (missTh.length ? `  in Thai only: ${missTh.join(', ')}\n` : '')
          + (missEn.length ? `  in English only: ${missEn.join(', ')}` : ''));
      }
    }
  }

  // --- objective: one concept, one word ----------------------------------------------------------
  for (const [lang, src] of [['th', thSrc], ['en', enSrc]]) {
    if (!src) continue;
    const file = `docs/manuals/content/${name}.${lang}.md`;
    // Quoted product labels are exempt: they say whatever the product says.
    // Comments are blanked LINE BY LINE, not collapsed: replacing a multi-line comment with a
    // single space shifts every line number after it, and a finding that points at the wrong line
    // is worse than no finding — the reader looks, sees nothing wrong, and stops trusting the check.
    const body = src
      .replace(/\[\[[^\]]*\]\]/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    const lines = body.split('\n');
    for (const rule of TERMS[lang]) {
      for (const bad of rule.avoid) {
        lines.forEach((l, i) => {
          if (rule.unless && rule.unless.test(l)) return;
          const re = new RegExp(lang === 'en' ? `\\b${bad}\\b` : bad, 'gi');
          if (re.test(l)) {
            add('FAIL', 'TERMS', file, i + 1,
              `"${bad}" — use "${rule.use}"`, `  ${rule.why}\n  ${l.trim().slice(0, 100)}`);
          }
        });
      }
    }
  }

  // --- advisory: sentence length and English tells ------------------------------------------------
  if (!ADVICE) continue;
  for (const [lang, src, sections] of [['th', thSrc, th], ['en', enSrc, en]]) {
    if (!src || !sections) continue;
    const file = `docs/manuals/content/${name}.${lang}.md`;
    for (const s of sections) {
      const line = lineOf(src, s.id);
      for (const b of s.blocks) {
        for (const unit of textUnits(b)) {
        const text = unit.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // Thai has no sentence-final punctuation and no inter-word spaces, so a "sentence" is
        // approximated by a run between the clause breaks Thai actually uses. Crude by necessity —
        // it is a prompt to re-read, not a verdict.
        const runs = lang === 'th'
          ? text.split(/(?:\s—\s|·|:|\s\/\s)/)
          : text.split(/(?<=[.!?])\s+/);
        for (const r of runs) {
          const len = [...r.trim()].length;
          const cap = lang === 'th' ? 220 : 200;
          if (len > cap) {
            add('ADVICE', 'LENGTH', file, line,
              `section "${s.id}": a ${len}-character run — consider breaking it`,
              `  ${r.trim().slice(0, 110)}…`);
          }
        }
        if (lang === 'en') {
          for (const t of TELLS) {
            if (text.toLowerCase().includes(t)) {
              add('ADVICE', 'VOICE', file, line, `section "${s.id}": "${t}" reads as padding`, null);
            }
          }
        }
        }
      }
    }
  }
}

// ---- report --------------------------------------------------------------------------------------
const fails = findings.filter((f) => f.level === 'FAIL');
const advice = findings.filter((f) => f.level === 'ADVICE');

for (const group of [fails, advice]) {
  for (const f of group) {
    const mark = f.level === 'FAIL' ? `${C.red}✗${C.reset}` : `${C.yellow}·${C.reset}`;
    console.log(`${mark} ${C.bold}${f.check}${C.reset}  ${f.file}:${f.line}\n  ${f.msg}`);
    if (f.detail) console.log(`${C.dim}${f.detail}${C.reset}`);
    console.log('');
  }
}

if (!fails.length) {
  console.log(`${C.green}✓${C.reset} prose audit — the two languages match in shape and figures, terminology is consistent`);
}
if (advice.length) {
  console.log(`${C.dim}${advice.length} advisory finding(s). Wording is the author's call — nothing here is auto-fixed.${C.reset}`);
} else if (!ADVICE) {
  console.log(`${C.dim}Run with --advice for sentence-length and voice suggestions.${C.reset}`);
}

process.exit(fails.length ? 1 : 0);
