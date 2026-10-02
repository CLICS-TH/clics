const { hasCitation, extractSocraticQuestion, extractReferences } = require('../src/services/post-filter');

describe('hasCitation', () => {
  test('detects (Source, Year) pattern', () => {
    expect(hasCitation('Use metformin (ADA, 2024) first-line')).toBe(true);
  });

  test('detects Thai citation', () => {
    expect(hasCitation('แนวทาง (สมาคมโรคเบาหวาน, 2566) ระบุ')).toBe(true);
  });

  test('returns false when no citation', () => {
    expect(hasCitation('Use metformin first-line')).toBe(false);
  });
});

describe('extractSocraticQuestion', () => {
  test('extracts ❓-prefixed question', () => {
    const content = 'Metformin is first-line (ADA, 2024).\n❓ How would renal impairment change your choice?';
    expect(extractSocraticQuestion(content)).toBe('How would renal impairment change your choice?');
  });

  test('returns null when no question found', () => {
    expect(extractSocraticQuestion('Just a statement.')).toBeNull();
  });
});

describe('extractReferences', () => {
  test('extracts multiple citations', () => {
    const refs = extractReferences('See (ADA, 2024) and (WHO, 2023) for guidelines');
    expect(refs).toHaveLength(2);
    expect(refs[0].source).toBe('ADA, 2024');
    expect(refs[1].source).toBe('WHO, 2023');
  });

  test('returns empty array when no citations', () => {
    expect(extractReferences('No citations here')).toEqual([]);
  });
});

describe('hasNoSourceStatement / meetsCitationRule (the prompt\'s honest alternative to inventing a source)', () => {
  const { hasNoSourceStatement, meetsCitationRule } = require('../src/services/post-filter');

  test('accepts the prompt\'s exact English and Thai notes and their obvious variants', () => {
    expect(hasNoSourceStatement('Metformin is usually first-line (no specific source cited).')).toBe(true);
    expect(hasNoSourceStatement('No specific source is cited for this point.')).toBe(true);
    expect(hasNoSourceStatement('no  specific\nreference cited')).toBe(true);
    expect(hasNoSourceStatement('ยาตัวแรกคือเมทฟอร์มิน (ไม่มีแหล่งอ้างอิงเฉพาะ)')).toBe(true);
    expect(hasNoSourceStatement('ไม่มีแหล่งอ้างอิงที่เฉพาะเจาะจงสำหรับประเด็นนี้')).toBe(true);
  });

  test('does NOT accept clinical prose that merely contains the words', () => {
    expect(hasNoSourceStatement('No specific source of infection was identified.')).toBe(false);
    expect(hasNoSourceStatement('There is no specific source for the bleeding.')).toBe(false);
    expect(hasNoSourceStatement('ไม่พบแหล่งติดเชื้อที่ชัดเจน')).toBe(false);
    expect(hasNoSourceStatement('')).toBe(false);
    expect(hasNoSourceStatement(null)).toBe(false);
  });

  test('the note is not a citation: hasCitation and extractReferences are unchanged by it', () => {
    const text = 'Metformin is usually first-line (no specific source cited).';
    expect(hasCitation(text)).toBe(false);
    expect(extractReferences(text)).toEqual([]);
  });

  test('meetsCitationRule = a (Source, Year) citation OR the note; neither fails', () => {
    expect(meetsCitationRule('Metformin first (ADA Standards of Care in Diabetes, 2024).')).toBe(true);
    expect(meetsCitationRule('Metformin first (no specific source cited).')).toBe(true);
    expect(meetsCitationRule('Metformin first.')).toBe(false);
  });

  test('linear on hostile whitespace runs', () => {
    const hostile = 'no specific source' + ' '.repeat(200000) + 'x' + 'ไม่มีแหล่งอ้างอิง' + ' '.repeat(200000) + 'x';
    const t0 = process.hrtime.bigint();
    expect(hasNoSourceStatement(hostile.repeat(3))).toBe(false);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(500);
  });
});
