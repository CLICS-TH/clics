// #474 invariant: the folded run of each pass (look-alike dashes, middle dots, circled and keycap digits, mathematical
// letters) only adds masks. Over seeded random strings that mix identifiers, look-alikes and clinical text, every
// character stripPii masks with the folds turned off (master's view alone) must still be masked with them on.
const filter = require('../src/services/pii-filter');

const { stripPii } = filter;

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

function generator(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const digits = (n, first) => Array.from({ length: n }, (_, i) => (i === 0 && first !== undefined ? first : Math.floor(r() * 10)));
  const write = (ds) => { const s = pick(SCRIPTS); return ds.map((d) => s(d)).join(''); };
  const groups = (sizes, first) => {
    const ds = digits(sizes.reduce((a, b) => a + b, 0), first);
    const sep = pick([' ', '-', '', ...DASHES, ...DOTS]);
    const out = [];
    let i = 0;
    for (const n of sizes) { out.push(write(ds.slice(i, i + n))); i += n; }
    return out.join(sep);
  };
  const day = () => String(1 + Math.floor(r() * 28));
  const month = () => String(1 + Math.floor(r() * 12));
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
    () => `${day()} ${pick(['Oct', 'ต.ค.', 'ตุลาคม', 'March'])} ${pick(['1967', '2510', '67'])}`,
    () => `${pick(['somchai', 'a.b', 'jd_12'])}${pick(['@', '·@'])}${pick(['example.com', 'example·com', 'x.co.th'])}`,
    () => `อายุ ${digits(2, 4).join('')} ปี`,
    () => `age ${digits(2, 6).join('')}`,
    () => `ward ${digits(1, 5).join('')}A`,
    () => `บ้านเลขที่ ${digits(2, 9).join('')}/1`,
  ];
  const CLINICAL = ['BP 120/80', 'Na 140', 'Hb 12·5', 'K 3.5–5.0', 'Cr 1·05 1·12 1·20', 'dose 5–10 mg', 'titrate 10-12-14 mg',
    '⑴ ASA ⑵ P2Y12', '⒈ aspirin', 'VERSION 2024.10.1', 'Section: 1.2.10', 'ปวดท้อง', 'ผู้ป่วยมีไข้', 'G2P1A0', 'L4-5',
    'WBC 12 x 10³/µL', 'pH 7·35', 'on 3 Jan 10:30', 'since October 2024', 'grade 2-3', 'seen'];
  const MARKS = ['1️⃣', '①', '⑴', '⒈', '𝐀', '𝐇𝐍', '❶', '𝟏', '⓵', '2⃣'];
  const JOIN = ['', ' ', ' ', '/', '-', ', ', ...DASHES, ...DOTS, ' – ', ' · '];
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

describe('#474 the folded run only adds masks', () => {
  afterEach(() => filter._setFoldsForTest(true));

  test('over 4000 seeded random strings, every character masked without the folds is masked with them', () => {
    const next = generator(474);
    const lost = [];
    let compared = 0;
    let foldsMasked = 0;
    const N = 4000;
    for (let n = 0; n < N; n += 1) {
      const input = next();
      if (/[[\]]/.test(input)) continue;
      filter._setFoldsForTest(false);
      const off = stripPii(input);
      filter._setFoldsForTest(true);
      const on = stripPii(input);
      if (on !== off) foldsMasked += 1;
      const a = maskedSet(input, off);
      const b = maskedSet(input, on);
      if (!a || !b) continue;
      compared += 1;
      const at = a.findIndex((m, i) => m && !b[i]);
      if (at >= 0) lost.push({ input, off, on, at });
    }
    expect(lost.slice(0, 5)).toEqual([]);
    // The check is not vacuous: most strings align, and the folds change many outputs.
    expect(compared).toBeGreaterThan(N * 0.8);
    expect(foldsMasked).toBeGreaterThan(N * 0.2);
  });
});
