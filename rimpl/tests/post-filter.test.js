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
