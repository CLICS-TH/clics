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
