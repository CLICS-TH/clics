// #474: the seeded string generator and the mask alignment the folds-only-add and master-differential tests share.
// The generator mixes identifiers, look-alikes and clinical text; it writes no name, so stripPii only replaces spans
// with [CAT-n] tokens and maskedSet can tell which input characters were masked. historyGenerator writes names too, for
// the texts of one call, so it is checked by clearCounts alone.
// mulberry32: a small seeded generator, so a failure replays.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCRIPTS = [
  (d) => d,
  (d) => d,
  (d) => d,
  (d) => String.fromCodePoint(0x0e50 + d), // Thai
  (d) => String.fromCodePoint(0xff10 + d), // full-width
  (d) => (d === 0 ? '⓪' : String.fromCodePoint(0x2460 + d - 1)), // circled
  (d) => `${d}️⃣`, // keycap
];
const DASHES = ['-', '–', '‑', '−', '—'];
const DOTS = ['·', '・', '∙'];

// `ascii`: digits, dashes and dots as plain ASCII only, so the joiners and separators are '.', '-' and '/' and the
// strings test the run on master's view alone.
function generator(seed, { ascii = false } = {}) {
  const scripts = ascii ? [(d) => d] : SCRIPTS;
  const dashes = ascii ? ['-'] : DASHES;
  const dots = ascii ? ['.'] : DOTS;
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const digits = (n, first) => Array.from({ length: n }, (_, i) => (i === 0 && first !== undefined ? first : Math.floor(r() * 10)));
  const write = (ds) => { const s = pick(scripts); return ds.map((d) => s(d)).join(''); };
  const groups = (sizes, first) => {
    const ds = digits(sizes.reduce((a, b) => a + b, 0), first);
    const sep = pick([' ', '-', '', ...dashes, ...dots]);
    const out = [];
    let i = 0;
    for (const n of sizes) { out.push(write(ds.slice(i, i + n))); i += n; }
    return out.join(sep);
  };
  const day = () => String(1 + Math.floor(r() * 28));
  const month = () => String(1 + Math.floor(r() * 12));
  // A chain of 3 to 7 date numbers joined by '.', '-', '/' and the look-alike dashes (20.6.2026-4-3-5,
  // 17.3.2026/11/1/5, 2024.10.1.20/10/2569): no pass may cut a date master masks in it. Half open with a dotted date.
  const chain = () => {
    const nums = () => pick([day, month, day, () => pick(['2569', '2026', '2024', '69', '25'])])();
    const dotted = r() < 0.5;
    const out = [dotted ? `${day()}.${month()}.${pick(['2569', '2026', '25'])}` : nums()];
    for (let n = dotted ? 1 + Math.floor(r() * 4) : 2 + Math.floor(r() * 5); n > 0; n -= 1) {
      out.push(pick(['.', '-', '/', ...dashes]), nums());
    }
    return out.join('');
  };
  const ID = [
    () => groups([3, 3, 4], 0),
    () => groups([2, 3, 4], 0),
    () => groups([10], 0),
    () => groups([1, 4, 5, 2, 1]),
    () => groups([13]),
    () => `+66 ${groups([2, 3, 4])}`,
    () => `${pick(['HN', 'HN:', 'MRN', 'AN', '𝐇𝐍', 'HN·'])} ${groups([pick([4, 6, 7])])}${pick(['', '', `/${digits(2).join('')}`])}`,
    () => `${day()}${pick(['/', '.', '-', '·', '–'])}${month()}${pick(['/', '.', '-', '·', '–'])}${pick(['2569', '2026', '69'])}`,
    () => `${pick(['2569', '2026'])}${pick(['-', '.', '/', '·', '–'])}${month()}${pick(['-', '.', '/', '·', '–'])}${day()}`,
    chain,
    chain,
    () => `${day()} ${pick(['Oct', 'ต.ค.', 'ตุลาคม', 'March'])} ${pick(['1967', '2510', '67'])}`,
    () => `${pick(['somchai', 'a.b', 'jd_12'])}${pick(['@', '·@'])}${pick(['example.com', 'example·com', 'x.co.th'])}`,
    // A date or ID beside an 11-digit run, one digit too many for a phone (Seen 2026-01-02 0262769).
    () => `${pick([() => `2026-0${month() % 9 + 1}-${10 + Math.floor(r() * 18)}`, () => `${day()}/${month()}/${pick(['2569', '68'])}`,
      () => groups([13]), () => `${pick(['HN', 'MRN'])} ${groups([7])}`])()}${pick([' ', '-', '', ...dashes])}${groups([3, 4, 4], 0)}`,
    // An unlabelled age beside a middle-dot email (45 years old@example·com, 45 y/o·bob@example.com).
    () => `${digits(2, 4).join('')} ${pick(['years old', 'y/o', 'ปี'])}${pick(['', '·', ' '])}${pick(['', 'bob', 'a·b·'])}`
      + `${pick(['@', '·@'])}${pick(['example.com', 'example·com'])}`,
    // 40 to 130 spaces inside an HN, MRN or phone (HN + 44 spaces + 12 34…, 08 + gaps of 8 spaces + digits).
    () => {
      const gaps = (ds, lo) => ds.map((d, i) => (i ? ' '.repeat(lo + Math.floor(r() * (9 - lo))) : '') + d).join('');
      const pad = ' '.repeat(40 + Math.floor(r() * 91));
      return pick([
        () => `${pick(['HN', 'MRN', 'AN', 'HN:'])}${pad}${groups(pick([[2, 2], [4], [7], [2, 5]]))}`,
        () => gaps(digits(pick([10, 13]), 0), 5),
        () => `HN${digits(4).join('')}/${gaps(digits(10, 0), 4)}`,
      ])();
    },
    // A long house-number chain, then date groups (บ้านเลขที่ 1/1/…/1-20-10-2569-55-6).
    () => `${pick(['บ้านเลขที่ ', 'เลขที่', 'เลขที่ '])}${Array.from({ length: 5 + Math.floor(r() * 30) }, () => digits(1 + Math.floor(r() * 2)).join(''))
      .join(pick(['/', '-', '/', ...dashes]))}${pick(['', `-${chain()}`, `/${chain()}`])}`,
    () => `อายุ ${digits(2, 4).join('')} ปี`,
    () => `age ${digits(2, 6).join('')}`,
    () => `ward ${digits(1, 5).join('')}A`,
    () => `บ้านเลขที่ ${digits(2, 9).join('')}/1`,
  ];
  const CLINICAL = ['BP 120/80', 'Na 140', 'Hb 12·5', 'K 3.5–5.0', 'Cr 1·05 1·12 1·20', 'dose 5–10 mg', 'titrate 10-12-14 mg',
    '⑴ ASA ⑵ P2Y12', '⒈ aspirin', 'VERSION 2024.10.1', 'Section: 1.2.10', 'version 1.2.10', 'Section 5.10.69', 'ปวดท้อง',
    'ผู้ป่วยมีไข้', 'G2P1A0', 'L4-5', 'WBC 12 x 10³/µL', 'pH 7·35', 'on 3 Jan 10:30', 'since October 2024', 'grade 2-3', 'seen'];
  const MARKS = ['1️⃣', '①', '⑴', '⒈', '𝐀', '𝐇𝐍', '❶', '𝟏', '⓵', '2⃣'];
  const JOIN = ['', ' ', ' ', '/', '-', ', ', ...dashes, ...dots, ' – ', ' · '];
  return () => {
    const parts = [];
    for (let n = 2 + Math.floor(r() * 5); n > 0; n -= 1) {
      const k = r();
      parts.push(k < 0.55 ? pick(ID)() : k < 0.8 ? pick(CLINICAL) : pick(MARKS));
      parts.push(pick(JOIN));
    }
    return parts.join('');
  };
}

// Which characters of `input` `output` masked. stripPii only replaces spans with [CAT-n] tokens here (the generator
// writes no name, so no NAME pass adds text), so the text between tokens appears in the input in order. Each literal
// piece is placed leftmost and rightmost; when the two agree for every non-empty piece, the placement is the only one.
// null when the output cannot be aligned or the placement is ambiguous.
const TOKEN_RE = /\[[A-Z]+-\d+\]/;
function maskedSet(input, output) {
  const lits = output.split(TOKEN_RE);
  const k = lits.length - 1;
  if (!input.startsWith(lits[0]) || !input.endsWith(lits[k])) return null;
  const left = [0];
  for (let i = 1; i <= k; i += 1) {
    const p = i === k ? input.length - lits[k].length : input.indexOf(lits[i], left[i - 1] + lits[i - 1].length + 1);
    if (p < 0 || p < left[i - 1] + lits[i - 1].length + 1) return null;
    left.push(p);
  }
  const right = [];
  right[k] = input.length - lits[k].length;
  for (let i = k - 1; i >= 0; i -= 1) {
    const p = i === 0 ? 0 : input.lastIndexOf(lits[i], right[i + 1] - 1 - lits[i].length);
    if (p < 0 || p + lits[i].length > right[i + 1] - 1) return null;
    right[i] = p;
  }
  for (let i = 0; i <= k; i += 1) if (lits[i] && left[i] !== right[i]) return null;
  const masked = new Uint8Array(input.length).fill(1);
  for (let i = 0; i <= k; i += 1) masked.fill(0, left[i], left[i] + lits[i].length);
  return masked;
}

// Which characters `counted` takes as letters or digits of the input (per UTF-16 unit, as maskedSet indexes), less the
// spans `notCountedRe` (global) matches.
function counted(input, notCountedRe) {
  const out = new Array(input.length).fill(false);
  for (let i = 0; i < input.length;) {
    const c = String.fromCodePoint(input.codePointAt(i));
    out.fill(/[\p{L}\p{N}]/u.test(c), i, i + c.length);
    i += c.length;
  }
  for (const m of input.matchAll(notCountedRe)) out.fill(false, m.index, m.index + m[0].length);
  return out;
}

// Each letter or digit outside the [CAT-n] tokens of `out`, with how many times it appears. Needs no alignment. A
// separator between two masks (-, /) is no identifier and is not counted.
const TOKENS_RE = /\[[A-Z]+-\d+\]/g;
function clearCounts(out) {
  const n = new Map();
  for (const c of out.replace(TOKENS_RE, '')) if (/[\p{L}\p{N}]/u.test(c)) n.set(c, (n.get(c) ?? 0) + 1);
  return n;
}

// The letters and digits `head` leaves in clear more often than `master` does.
function moreInClear(head, master) {
  const m = clearCounts(master);
  return [...clearCounts(head)].filter(([c, k]) => k > (m.get(c) ?? 0)).map(([c]) => c);
}

// The texts of one call (2 to 4), for the multi-text differential. A person is written in full in one text, in a shape
// where a pass of this branch can eat the context master's name pass reads (a Latin title after Ward: or ward#, a
// given name that is also a month, a name before a middle-dot email, a Thai name after คุณ, นาย or ชื่อ), and by a bare
// part in the others, before or after it; the identifier strings of `generator` fill the rest.
function historyGenerator(seed, { ascii = false } = {}) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const text = generator(seed + 7919, { ascii });
  const LATIN = [['Smith'], ['Brown'], ['Lee'], ['Somchai', 'Jaidee'], ['John', 'Smith'], ['Mary', 'Brown']];
  const MONTHS = ['June', 'May', 'April', 'March', 'August'];
  const THAI = [['สมชาย', 'ใจดี'], ['สมศรี', 'ทองคำ'], ['มานี', 'มีสุข'], ['วีระ'], ['ประเสริฐ', 'ศรีสุข']];
  const title = () => pick(['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Dr.', 'Prof']);
  const people = [
    () => { const n = pick(LATIN); return { full: `${pick(['Ward:', 'ward#', 'Ward#', 'ward: ', 'Ward: ', 'WARD:'])}${pick(['', ' '])}${title()} ${n.join(' ')}`, parts: n }; },
    () => {
      const g = pick(MONTHS);
      const n = r() < 0.5 ? [g] : [g, pick(['Smith', 'Lee'])];
      const tail = pick([` ${1 + Math.floor(r() * 28)}, 2024`, ` ${1 + Math.floor(r() * 28)} 2025`, '', ' 3']);
      return { full: `${pick(['Seen by ', '', 'with '])}${title()} ${n.join(' ')}${tail}`, parts: n };
    },
    () => { const n = pick(LATIN); return { full: `${pick(['', 'Dr. ', 'Mr '])}${n.join(' ')}${pick(['·', '・', '∙'])}${pick(['md', 'j', 'x.y'])}@${pick(['hospital.com', 'x.com', 'x.co.th'])}`, parts: n }; },
    () => { const n = pick(THAI); return { full: `${pick(['คุณ', 'นาย', 'นาง', 'ชื่อ ', 'ชื่อ'])}${n.join(' ')}`, parts: n }; },
  ];
  const bare = (part) => (/[ก-๛]/.test(part)
    ? pick([`${part}มาด้วยไข้`, `ญาติของ${part}โทรมา`, `${part} บอกว่าปวดท้อง`, part])
    : pick([`${part} reports chest pain`, `${part} has fever`, `Called ${part} back`, `${part}.`, part]));
  return () => {
    const texts = Array.from({ length: 2 + Math.floor(r() * 3) }, () => (r() < 0.6 ? text() : ''));
    for (let n = 1 + Math.floor(r() * 2); n > 0; n -= 1) {
      const p = pick(people)();
      const at = Math.floor(r() * texts.length);
      texts[at] = [texts[at], p.full].filter(Boolean).join(pick([' ', ', ', '. ']));
      texts.forEach((t, i) => {
        if (i !== at) texts[i] = [t, bare(pick(p.parts))].filter(Boolean).join(pick([' ', '. ']));
      });
    }
    return texts;
  };
}

module.exports = { generator, historyGenerator, maskedSet, counted, clearCounts, moreInClear };
