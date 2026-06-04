const { stripPii, stripHistoryPii } = require('../src/services/pii-filter');

describe('stripPii', () => {
  test('masks Thai HN numbers', () => {
    expect(stripPii('ผู้ป่วย HN 12345678 มาด้วย')).toBe('ผู้ป่วย [HN] มาด้วย');
  });

  test('masks HN: prefix format', () => {
    expect(stripPii('HN: 99001234 chest pain')).toBe('[HN] chest pain');
  });

  test('masks DD/MM/YYYY dates', () => {
    expect(stripPii('วันที่ 15/06/2025 นัดตรวจ')).toBe('วันที่ [DATE] นัดตรวจ');
  });

  test('masks ISO dates', () => {
    expect(stripPii('admitted 2025-06-15')).toBe('admitted [DATE]');
  });

  test('masks ward references', () => {
    expect(stripPii('transferred to ward 4B')).toBe('transferred to [WARD]');
  });

  test('leaves clinical content unchanged', () => {
    const text = 'Patient presents with chest pain and dyspnea';
    expect(stripPii(text)).toBe(text);
  });

  test('stripHistoryPii strips all messages in array', () => {
    const history = [
      { role: 'physician', content: 'HN: 12345 chest pain' },
      { role: 'assistant', content: 'Consider ACS (ACC/AHA, 2023)' },
    ];
    const result = stripHistoryPii(history);
    expect(result[0].content).toBe('[HN] chest pain');
    expect(result[1].content).toBe('Consider ACS (ACC/AHA, 2023)');
  });
});
