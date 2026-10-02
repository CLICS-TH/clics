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
