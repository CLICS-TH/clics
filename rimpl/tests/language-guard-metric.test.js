// The pure language-guard metric in services/post-filter.js — shared by chat.js (production guard) and
// scripts/probe/thai-probe.mjs (raw measurement). Hermetic: no mocks needed, nothing is imported but it.
const { thaiShare, isLanguageMismatch, stripNonProse, THAI_MIN_SHARE } = require('../src/services/post-filter');

const TH = 'เมตฟอร์มินเป็นยาทางเลือกแรกสำหรับผู้ป่วยเบาหวานชนิดที่สองควรปรับขนาดยาตามไต';
const EN = 'Metformin is first-line therapy for type two diabetes and should follow renal function.';

describe('thaiShare / isLanguageMismatch (language guard metric)', () => {
  test('thaiShare is Thai codepoints / (Thai + Latin letters); digits, punctuation and emoji do not count', () => {
    expect(thaiShare('กขค abc')).toBeCloseTo(0.5);
    expect(thaiShare('กขค 123 ❓ !!!')).toBe(1);
    expect(thaiShare('123 ❓')).toBe(0);
    expect(thaiShare('')).toBe(0);
    expect(thaiShare(undefined)).toBe(0);
    expect(THAI_MIN_SHARE).toBe(0.30);
  });

  test('only language "th" is ever flagged', () => {
    expect(isLanguageMismatch(EN, 'th')).toBe(true);
    expect(isLanguageMismatch(EN, 'en')).toBe(false);
    expect(isLanguageMismatch(TH, 'th')).toBe(false);
    expect(isLanguageMismatch(TH, 'en')).toBe(false);
    expect(isLanguageMismatch(EN, undefined)).toBe(false);
  });

  test('the bar is 0.30: just under flags, just over does not', () => {
    const mk = (thai, latin) => 'ก'.repeat(thai) + 'a'.repeat(latin);
    expect(isLanguageMismatch(mk(29, 71), 'th')).toBe(true);
    expect(isLanguageMismatch(mk(31, 69), 'th')).toBe(false);
  });

  test('too little signal is not judged: a short or all-code reply never buys a retry', () => {
    expect(isLanguageMismatch('OK', 'th')).toBe(false);
    expect(isLanguageMismatch('', 'th')).toBe(false);
    expect(isLanguageMismatch('```js\nconst veryLongIdentifierName = computeSomethingExpensive(argument);\n```', 'th')).toBe(false);
  });

  test('code blocks, inline code, URLs and (Source, Year) citations are ignored; drug names are not', () => {
    const code = '```python\nprint("hello world this is English code")\n```';
    expect(isLanguageMismatch(`${TH}\n${code}`, 'th')).toBe(false);
    expect(thaiShare(`${TH}\n${code}`)).toBeLessThan(1);                 // the raw metric still counts it
    expect(stripNonProse('ดู https://example.org/a-long-english-path และ `inline code`')).not.toMatch(/example|inline/);
    expect(stripNonProse('แนวทาง (Kidney Disease: Improving Global Outcomes, 2024) ระบุ')).not.toMatch(/Kidney/);
    expect(stripNonProse('ใช้ metformin ทุกวัน')).toMatch(/metformin/);
    // An unterminated fence (truncated reply) is treated as code to its end.
    expect(stripNonProse('ข้อความ\n```sql\nSELECT everything_in_english FROM table')).not.toMatch(/SELECT/);
  });

  test('English prose is still caught when a code block is part of the reply', () => {
    expect(isLanguageMismatch(`${EN}\n\`\`\`\ncode\n\`\`\``, 'th')).toBe(true);
  });
});

describe('artifact blocks and reference lists (language guard metric)', () => {
  const LEAD = 'ผู้ป่วยรายนี้เข้าได้กับปอดอักเสบ';
  const TABLE = '| Dx | Features |\n|---|---|\n| Pneumonia | Fever, productive cough, consolidation on imaging |\n| Pulmonary embolism | Pleuritic pain, tachycardia, hypoxia |';
  const art = `:::artifact{type="differential" title="DDx"}\n${TABLE}\n:::`;

  test('a Thai lead with an English artifact: the raw share is low, the guarded one is not a mismatch', () => {
    const reply = `${LEAD}\n${art}\nขอให้พิจารณาต่อ`;
    expect(thaiShare(reply)).toBeLessThan(0.30);                 // what the reviewer measured as a false positive
    expect(isLanguageMismatch(reply, 'th')).toBe(false);
  });

  test('the whole block goes, including its closing fence, but prose after it stays', () => {
    const s = stripNonProse(`ก่อน\n${art}\nหลังจากนั้น and English tail words here`);
    expect(s).not.toMatch(/Pneumonia|artifact|:::/);
    expect(s).toMatch(/หลังจากนั้น/);
    expect(s).toMatch(/English tail/);
  });

  test('two artifacts in one reply are both removed (non-greedy)', () => {
    const s = stripNonProse(`${art}\nข้อความไทยตรงกลางระหว่างบล็อก\n${art}`);
    expect(s).toMatch(/ข้อความไทยตรงกลาง/);
    expect(s).not.toMatch(/Pneumonia/);
  });

  test('an unterminated artifact (truncated reply) is stripped to the end', () => {
    expect(stripNonProse(`${LEAD}\n:::artifact{type="evidence" title="x"}\n${TABLE}`)).not.toMatch(/Pneumonia/);
  });

  test('an English reply is still caught when an artifact is attached (only the block is ignored)', () => {
    const english = 'Metformin is first-line therapy for type two diabetes and the dose should follow renal function in every patient.';
    expect(isLanguageMismatch(`${english}\n${art}`, 'th')).toBe(true);
  });

  test('a trailing References list (any of the headings) is ignored; the heading must be on its own line', () => {
    const refs = '1. Metlay JP, Waterer GW, et al. Diagnosis and treatment of adults with community-acquired pneumonia.\n2. Mandell LA, Wunderink RG, et al. IDSA and ATS consensus guidelines on CAP in adults.';
    for (const h of ['References:', '**References**', '## References', 'เอกสารอ้างอิง', 'Bibliography:']) {
      const reply = `${LEAD}\n\n${h}\n${refs}`;
      expect(thaiShare(reply)).toBeLessThan(0.30);
      expect(isLanguageMismatch(reply, 'th')).toBe(false);
    }
    // The word in running English prose is not a heading.
    const prose = 'The references for this recommendation are strong and the evidence base is consistently good for therapy.';
    expect(isLanguageMismatch(prose, 'th')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Cost. stripNonProse / hasCitation / extractReferences run on text a physician typed (the guest
// route reaches them too), so none may be super-linear. An earlier References regex took 15 s on
// ~2000 spaces. Each case is 5000 chars; a linear implementation takes ~1 ms, so 50 ms is >10x slack
// and a quadratic one (>=25 ms at this size, rising fast) or cubic one fails.
// ---------------------------------------------------------------------------------------------
const { hasCitation, extractReferences, isThaiMessage, MESSAGE_SAMPLE_CHARS } = require('../src/services/post-filter');

const N = 5000;
const PATHOLOGICAL = {
  'References + spaces + x': `ก\nReferences${' '.repeat(N)}x`,
  'References + tabs + x': `ก\n## **References${'\t'.repeat(N)}x`,
  'heading decoration run': `ก\n${' *#'.repeat(N / 3)}x`,
  'heading + star/colon run': `ก\nReferences${' *:'.repeat(N / 3)}x`,
  'many heading-like lines': 'References x\n'.repeat(N / 12),
  'nested citation openers': '(a, '.repeat(N / 4),
  'open parens only': '('.repeat(N),
  'open parens, one close at end': `${'('.repeat(N)})`,
  'commas and whitespace in parens': `(${'a,   '.repeat(N / 5)})`,
  'citation openers with spaces': `${'('.repeat(N / 4)}${'a,   '.repeat(N / 8)}`,
  'link openers': '](' .repeat(N / 2),
  'link opener + long target': `](${'a'.repeat(N)}`,
  'unterminated fence': `\`\`\`${'a'.repeat(N)}`,
  'many fences': '```a'.repeat(N / 4),
  'many unmatched backticks': '`a\n'.repeat(N / 3),
  'artifact openers, no closer': ':::artifact{a}\n'.repeat(N / 15),
  'artifact opener without brace': `:::artifact{${'a'.repeat(N)}`,
  'artifact openers without brace': `:::artifact{${'a'.repeat(20)}\n`.repeat(N / 33),
  'artifact + closers with trailing spaces': `:::artifact{a}\n${':::  x\n'.repeat(N / 6)}`,
  'urls': 'http://'.repeat(N / 7),
  'only whitespace': ' '.repeat(N),
};

describe('every step of the language guard is linear on hostile input (< 50 ms at 5000 chars)', () => {
  test.each(Object.entries(PATHOLOGICAL))('%s', (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(N + 1000);   // roughly N chars each
    const t0 = process.hrtime.bigint();
    stripNonProse(text);
    isLanguageMismatch(text, 'th');
    isThaiMessage(text);
    hasCitation(text);
    extractReferences(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
  });

  test('a 100k-char hostile input is bounded by MAX_PROSE_CHARS and still fast', () => {
    const t0 = process.hrtime.bigint();
    stripNonProse(`ก\nReferences${' '.repeat(1e6)}x`);
    stripNonProse('(a, '.repeat(250000));
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(250);
  });

  test('isThaiMessage looks only at the first MESSAGE_SAMPLE_CHARS', () => {
    expect(MESSAGE_SAMPLE_CHARS).toBe(1000);
    const thai = 'ก'.repeat(1000);
    const eng = 'a'.repeat(1000);
    expect(isThaiMessage(thai + eng.repeat(4))).toBe(true);
    expect(isThaiMessage(eng + thai.repeat(4))).toBe(false);
    expect(isThaiMessage('')).toBe(false);
    expect(isThaiMessage(undefined)).toBe(false);
  });
});

describe('the linear citation scanner matches the regex it replaced', () => {
  const oldHas = (c) => /\([^)]+,\s*\d{4}[^)]*\)/.test(c);
  const oldRefs = (content) => {
    const refs = [];
    const pattern = /\(([^)]+,\s*\d{4}[^)]*)\)/g;
    let m;
    while ((m = pattern.exec(content)) !== null) refs.push({ source: m[1].trim(), title: m[1].split(',')[0].trim() });
    return refs;
  };

  test('on normal text', () => {
    for (const t of [
      'Use metformin (ADA, 2024) first-line',
      'แนวทาง (สมาคมโรคเบาหวาน, 2566) ระบุ และ (WHO, 2023)',
      'no citation here',
      '(ADA 2024)', '(, 2024)', '(a,2024)', '(a,\n 2024)', '(a, 202)', '(a, 20245 more)', '(a, 2024',
      '((a, 2024)', '(a (b, 2024) c)', 'x (KDIGO, 2024; ADA, 2023) y', '()', ')(', '',
    ]) {
      expect(hasCitation(t)).toBe(oldHas(t));
      expect(extractReferences(t)).toEqual(oldRefs(t));
    }
  });

  test('on 40,000 random strings over a hostile alphabet (fixed seed)', () => {
    const alpha = ['(', ')', ',', ' ', '\n', '\t', '1', '2', '0', '9', 'a', 'ก', '.', ',', '(', ')', '٣'];
    let seed = 20260101;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let n = 0; n < 40000; n++) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 30);
      for (let i = 0; i < len; i++) s += alpha[Math.floor(rnd() * alpha.length)];
      if (hasCitation(s) !== oldHas(s) || JSON.stringify(extractReferences(s)) !== JSON.stringify(oldRefs(s))) {
        throw new Error(`citation scanner differs from the regex on ${JSON.stringify(s)}`);
      }
    }
  });
});
