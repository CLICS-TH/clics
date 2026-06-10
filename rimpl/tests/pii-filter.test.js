const { stripPii, stripHistoryPii } = require('../src/services/pii-filter');

// ---------------------------------------------------------------------------
// PII de-identification tests.
//
// The on-premise data boundary is ABSOLUTE: PII must never reach the cloud AI.
// stripPii() runs on every outbound cloud call. These tests cover every PII
// category we mask, for Thai AND English, with POSITIVE cases (must be masked)
// and NEGATIVE cases (clinical content that must SURVIVE: vitals, ratios, lab
// values, drug names, common medical abbreviations).
//
// Masks are deterministic and stable WITHIN one call: the same value resolves
// to the same token ([NAME-1]); a different value gets the next index
// ([NAME-2]). stripHistoryPii() threads one registry through all messages so
// coreference survives a whole multi-turn transcript.
// ---------------------------------------------------------------------------

describe('stripPii — identifiers (HN / MRN / AN / national ID)', () => {
  test('masks Thai HN numbers', () => {
    expect(stripPii('ผู้ป่วย HN 12345678 มาด้วย')).toBe('ผู้ป่วย [HN-1] มาด้วย');
  });

  test('masks HN: prefix format', () => {
    expect(stripPii('HN: 99001234 chest pain')).toBe('[HN-1] chest pain');
  });

  test('masks MRN code', () => {
    expect(stripPii('MRN: 4455667')).toBe('[MRN-1]');
  });

  test('masks AN (admission number)', () => {
    expect(stripPii('AN 1234567')).toBe('[MRN-1]');
  });

  test('masks 13-digit Thai national ID (plain)', () => {
    expect(stripPii('บัตรประชาชน 1234567890123')).toBe('บัตรประชาชน [ID-1]');
  });

  test('masks 13-digit national ID with dashes', () => {
    expect(stripPii('ID 1-2345-67890-12-3')).toBe('ID [ID-1]');
  });

  test('does NOT treat a short 8-digit HN-less number run as a national ID', () => {
    // 8 digits is not 13 → ID rule must not fire; nothing else matches either.
    expect(stripPii('lot number 12345678 of vaccine')).toBe('lot number 12345678 of vaccine');
  });
});

describe('stripPii — dates', () => {
  test('masks DD/MM/YYYY dates', () => {
    expect(stripPii('วันที่ 15/06/2025 นัดตรวจ')).toBe('วันที่ [DATE-1] นัดตรวจ');
  });

  test('masks ISO dates', () => {
    expect(stripPii('admitted 2025-06-15')).toBe('admitted [DATE-1]');
  });
});

describe('stripPii — ward', () => {
  test('masks English ward references', () => {
    expect(stripPii('transferred to ward 4B')).toBe('transferred to [WARD-1]');
  });

  test('masks Thai ห้อง references', () => {
    expect(stripPii('ย้ายไป ห้อง 5')).toBe('ย้ายไป [WARD-1]');
  });

  test('masks Thai หอผู้ป่วย references', () => {
    expect(stripPii('หอผู้ป่วย ICU')).toBe('[WARD-1]');
  });
});

describe('stripPii — personal NAMES (Thai honorific-led)', () => {
  test('masks นพ. + name, preserving the honorific', () => {
    expect(stripPii('นพ.สมหญิง ตรวจคนไข้')).toBe('นพ.[NAME-1] ตรวจคนไข้');
  });

  test('masks พญ. + name with a space after the title', () => {
    expect(stripPii('พญ. วราภรณ์ สั่งยา')).toBe('พญ.[NAME-1] สั่งยา');
  });

  test('masks นาย + name', () => {
    expect(stripPii('นายสมชาย มาด้วยอาการเจ็บหน้าอก')).toBe('นาย[NAME-1] มาด้วยอาการเจ็บหน้าอก');
  });

  test('masks นางสาว + name', () => {
    expect(stripPii('นางสาวสุดา ป่วย')).toBe('นางสาว[NAME-1] ป่วย');
  });

  test('masks ด.ช. (boy) + name', () => {
    expect(stripPii('ด.ช.ก้องภพ มาตรวจ')).toBe('ด.ช.[NAME-1] มาตรวจ');
  });

  test('masks ด.ญ. (girl) + name while the symptom survives', () => {
    // The clinical phrase ปวดท้อง (abdominal pain) must NOT be swallowed.
    expect(stripPii('ด.ญ.สมศรี ปวดท้อง')).toBe('ด.ญ.[NAME-1] ปวดท้อง');
  });

  test('masks คุณ + name', () => {
    expect(stripPii('คุณมานี มาตามนัด')).toBe('คุณ[NAME-1] มาตามนัด');
  });
});

describe('stripPii — personal NAMES (Thai labelled ชื่อ / นามสกุล)', () => {
  test('masks ชื่อ + given + นามสกุล + surname into one token', () => {
    expect(stripPii('ชื่อ สมชาย นามสกุล ใจดี')).toBe('ชื่อ [NAME-1]');
  });

  test('masks ชื่อ + given name alone', () => {
    expect(stripPii('ชื่อ มานะ')).toBe('ชื่อ [NAME-1]');
  });
});

describe('stripPii — personal NAMES (English honorific-led)', () => {
  test('masks Dr. + first + last', () => {
    expect(stripPii('Dr. John Smith reviewed the case')).toBe('Dr [NAME-1] reviewed the case');
  });

  test('masks Mr + first + last (no period)', () => {
    expect(stripPii('Mr Robert Brown was admitted')).toBe('Mr [NAME-1] was admitted');
  });

  test('masks Ms + hyphenated surname', () => {
    expect(stripPii('Ms Jane Doe-Smith')).toBe('Ms [NAME-1]');
  });

  test('does NOT mask a medical abbreviation that follows a title', () => {
    // "Dr BP" / "Mr. CT" — BP and CT are shielded medical abbreviations.
    expect(stripPii('Dr BP was elevated')).toBe('Dr BP was elevated');
    expect(stripPii('Mr. CT findings were normal')).toBe('Mr. CT findings were normal');
  });
});

describe('stripPii — AGE expressions', () => {
  test('masks "NN years old"', () => {
    expect(stripPii('patient is 45 years old')).toBe('patient is [AGE-1]');
  });

  test('masks "NN-yr-old"', () => {
    expect(stripPii('a 72-yr-old male')).toBe('a [AGE-1] male');
  });

  test('masks "NN y/o"', () => {
    expect(stripPii('62 y/o female')).toBe('[AGE-1] female');
  });

  test('masks "age: NN"', () => {
    expect(stripPii('age: 55')).toBe('[AGE-1]');
  });

  test('masks "aged NN"', () => {
    expect(stripPii('aged 30')).toBe('[AGE-1]');
  });

  test('masks Thai "อายุ NN ปี"', () => {
    expect(stripPii('อายุ 30 ปี')).toBe('[AGE-1]');
  });

  test('masks Thai "NN ปี"', () => {
    expect(stripPii('30 ปี')).toBe('[AGE-1]');
  });

  test('masks Thai "อายุ NN" without ปี', () => {
    expect(stripPii('อายุ 30')).toBe('[AGE-1]');
  });

  test('does NOT mask a duration "for 5 years"', () => {
    expect(stripPii('symptoms for 5 years')).toBe('symptoms for 5 years');
  });

  test('does NOT mask "3 years ago"', () => {
    expect(stripPii('came 3 years ago')).toBe('came 3 years ago');
  });
});

describe('stripPii — PHONE numbers', () => {
  test('masks Thai mobile with dashes', () => {
    expect(stripPii('โทร 081-234-5678')).toBe('โทร [PHONE-1]');
  });

  test('masks Thai mobile with no separators', () => {
    expect(stripPii('phone 0812345678')).toBe('phone [PHONE-1]');
  });

  test('masks Thai landline 0X-XXX-XXXX', () => {
    expect(stripPii('call 02-123-4567')).toBe('call [PHONE-1]');
  });

  test('masks +66 international form with spaces', () => {
    expect(stripPii('ติดต่อ +66 81 234 5678')).toBe('ติดต่อ [PHONE-1]');
  });

  test('masks +66 international form with dashes', () => {
    expect(stripPii('+66-2-123-4567')).toBe('[PHONE-1]');
  });
});

describe('stripPii — EMAIL and LINE', () => {
  test('masks an email address', () => {
    expect(stripPii('email: somchai.j@hospital.go.th')).toBe('email: [EMAIL-1]');
  });

  test('masks "line: <id>"', () => {
    expect(stripPii('line: somchai_99')).toBe('[LINE-1]');
  });

  test('masks "LINE ID: <id>"', () => {
    expect(stripPii('LINE ID: doctor.somchai')).toBe('[LINE-1]');
  });
});

describe('stripPii — clinical content MUST survive (negatives)', () => {
  const survive = [
    'BP 120/80 mmHg',
    'O2 sat 98%',
    'SpO2 95% on room air',
    'HR 88, RR 20',
    'Hb 12.5, WBC 8000',
    'Cr 1.2 mg/dL, BUN 18',
    'give paracetamol 500 mg PO q6h',
    'started on amlodipine 5 mg OD',
    'GCS 15, BMI 24',
    'Patient presents with chest pain and dyspnea',
    'ratio 1:2 dilution',
    'pH 7.35, pCO2 40, HCO3 24',
    'EF 55% on echo',
    'T 37.2 C',
    'ECG showed ST elevation',
  ];

  test.each(survive)('leaves clinical text unchanged: %s', (text) => {
    expect(stripPii(text)).toBe(text);
  });
});

describe('stripPii — stable, deterministic tokens within one call', () => {
  test('same name → same token; different name → next index', () => {
    expect(stripPii('นพ.สมชาย พบ นพ.สมหญิง และต่อมา สมชาย กลับมา'))
      .toBe('นพ.[NAME-1] พบ นพ.[NAME-2] และต่อมา [NAME-1] กลับมา');
  });

  test('repeated identical phone → same token; distinct phone → next index', () => {
    const out = stripPii('โทร 081-111-1111 หรือ 081-111-1111 หรือ 082-222-2222');
    expect(out).toBe('โทร [PHONE-1] หรือ [PHONE-1] หรือ [PHONE-2]');
  });

  test('English surname coreference: titled then bare', () => {
    expect(stripPii('Dr John Smith examined the patient; Smith ordered a CT'))
      .toBe('Dr [NAME-1] examined the patient; [NAME-1] ordered a CT');
  });
});

describe('stripPii — edge cases', () => {
  test('empty string is returned unchanged', () => {
    expect(stripPii('')).toBe('');
  });

  test('non-string input is returned as-is', () => {
    expect(stripPii(undefined)).toBe(undefined);
    expect(stripPii(null)).toBe(null);
  });
});

describe('stripHistoryPii', () => {
  test('strips every message and preserves non-content fields', () => {
    const history = [
      { role: 'physician', content: 'HN: 12345 chest pain' },
      { role: 'assistant', content: 'Consider ACS (ACC/AHA, 2023)' },
    ];
    const result = stripHistoryPii(history);
    expect(result[0].content).toBe('[HN-1] chest pain');
    expect(result[1].content).toBe('Consider ACS (ACC/AHA, 2023)');
    expect(result[0].role).toBe('physician');
  });

  test('coreference survives ACROSS turns under one shared registry', () => {
    const history = [
      { role: 'physician', content: 'นพ.สมชาย ดูแลผู้ป่วย HN 12345678 โทร 081-234-5678' },
      { role: 'assistant', content: 'ขอข้อมูลเพิ่มเติม' },
      { role: 'physician', content: 'สมชาย แจ้งว่า HN 12345678 ดีขึ้น' },
    ];
    const out = stripHistoryPii(history);
    // Same doctor → [NAME-1] in turn 1 and turn 3; same HN → [HN-1] both turns.
    expect(out[0].content).toBe('นพ.[NAME-1] ดูแลผู้ป่วย [HN-1] โทร [PHONE-1]');
    expect(out[2].content).toBe('[NAME-1] แจ้งว่า [HN-1] ดีขึ้น');
  });

  test('two distinct people get distinct tokens within one transcript', () => {
    const history = [
      { role: 'physician', content: 'นพ.สมชาย ปรึกษา พญ.สมหญิง' },
    ];
    const out = stripHistoryPii(history);
    expect(out[0].content).toBe('นพ.[NAME-1] ปรึกษา พญ.[NAME-2]');
  });
});
