const { stripPii, stripHistoryPii, deriveHintTokens } = require('../src/services/pii-filter');

// ---------------------------------------------------------------------------
// ADVERSARIAL red-team corpus for the RIMPL PII de-identifier.
//
// Goal: prove that NO patient identifier leaks through stripPii() to the cloud,
// across a realistic Thai + English clinical fuzz corpus. Each POSITIVE case
// asserts the identifier is gone (we assert the identifier SUBSTRING is absent
// rather than a brittle exact token string, so the test is robust to which
// index a value gets). NEGATIVE cases assert clinical content survives byte-for-
// byte so we never regress into over-masking vitals / doses / ratios.
//
// Helper: assertScrubbed(input, leakedSubstrings[]) — every listed raw PII
// fragment must be absent from the output. assertSurvives(text) — output must
// equal input exactly.
// ---------------------------------------------------------------------------

// Note: these helpers intentionally return NOTHING. jest test bodies must not
// return a non-Promise value, so callers use a block body or pass the helper
// directly as the test fn only when its return is undefined.
function assertScrubbed(input, leaked) {
  const out = stripPii(input);
  for (const frag of leaked) {
    expect(out).not.toContain(frag);
  }
  scrubbedOut = out; // expose last output for follow-up assertions
}

let scrubbedOut;

function assertSurvives(text) {
  expect(stripPii(text)).toBe(text);
}

// ===========================================================================
// PATIENT NAMES — honorifics, word orders, embedded mid-sentence
// ===========================================================================
describe('adversarial — patient names (Thai honorific-led, mid-sentence)', () => {
  test('นาย + given embedded mid-sentence', () => {
    assertScrubbed('วันนี้ นายสมชาย มาด้วยอาการเจ็บหน้าอก', ['สมชาย']);
  });

  test('พญ. with space then given', () => {
    assertScrubbed('ปรึกษา พญ. วราภรณ์ เรื่องยา', ['วราภรณ์']);
  });

  test('คุณ + given', () => {
    assertScrubbed('คุณมานี มาตามนัด', ['มานี']);
  });

  test('ด.ช. boy name, abdominal-pain symptom must survive', () => {
    assertScrubbed('ด.ช.ก้องภพ ปวดท้องมา 2 วัน', ['ก้องภพ']);
    expect(scrubbedOut).toContain('ปวดท้อง'); // symptom survives
  });
});

describe('adversarial — patient names (English honorifics, word orders)', () => {
  test('Dr first last', () => {
    assertScrubbed('Dr. John Smith reviewed the case', ['John', 'Smith']);
  });

  test('Mrs first last', () => {
    assertScrubbed('Mrs Mary Johnson was admitted', ['Mary', 'Johnson']);
  });

  test('hyphenated surname', () => {
    assertScrubbed('Ms Jane Doe-Smith presented', ['Jane', 'Doe-Smith']);
  });

  test('Prof. with title', () => {
    assertScrubbed('Prof. Alan Turing consulted', ['Alan', 'Turing']);
  });
});

describe('adversarial — labelled Thai names (ชื่อ / นามสกุล) incl. bare surname', () => {
  test('ชื่อ given นามสกุล surname', () => {
    assertScrubbed('ชื่อ สมชาย นามสกุล ใจดี', ['สมชาย', 'ใจดี']);
  });

  test('ชื่อ given alone', () => {
    assertScrubbed('ชื่อ มานะ', ['มานะ']);
  });

  // LEAK CLASS: surname follows the given name WITHOUT the นามสกุล keyword.
  test('ผู้ป่วยชื่อ given surname (no นามสกุล keyword) — both masked', () => {
    assertScrubbed('ผู้ป่วยชื่อ สมชาย ใจดี มาด้วยอาการไข้', ['สมชาย', 'ใจดี']);
  });

  test('ผู้ป่วยชื่อ glued to given name', () => {
    assertScrubbed('ผู้ป่วยชื่อสมชาย มาด้วยไข้', ['สมชาย']);
  });

  test('คนไข้ชื่อ given surname', () => {
    assertScrubbed('คนไข้ชื่อ มานี รักดี มาตามนัด', ['มานี', 'รักดี']);
  });
});

describe('adversarial — Thai nickname (ชื่อเล่น)', () => {
  // LEAK CLASS: nickname label was mangled to ชื่อ and the nickname leaked.
  test('ชื่อเล่น + nickname with space', () => {
    assertScrubbed('ชื่อเล่น ต้อย อายุ 8 ขวบ', ['ต้อย']);
    // the label word เล่น must not be corrupted into a half-token
    expect(scrubbedOut).not.toContain('ชื่อ [NAME'); // i.e. not mangled ชื่อเล่น->ชื่อ
  });

  test('ชื่อเล่น glued to nickname', () => {
    assertScrubbed('ชื่อเล่นแบงค์', ['แบงค์']);
  });

  test('English nickname label', () => {
    assertScrubbed('nickname Toey came in', ['Toey']);
  });
});

// ===========================================================================
// AGES — mixed Thai / English / glued formats
// ===========================================================================
describe('adversarial — ages (mixed formats)', () => {
  test('Thai อายุ NN ปี', () => assertScrubbed('อายุ 45 ปี', ['45']));
  test('Thai glued อายุ45ปี', () => assertScrubbed('อายุ45ปี', ['45']));
  test('Thai NN ปี', () => assertScrubbed('ผู้ป่วยหญิง 72 ปี', ['72']));
  test('English NN years old', () => assertScrubbed('a 62 years old man', ['62']));
  test('English NN-yr-old', () => assertScrubbed('72-yr-old female', ['72']));
  test('English NN y/o', () => assertScrubbed('45 y/o', ['45']));
  test('age: NN', () => assertScrubbed('age: 55', ['55']));

  // NEGATIVES — durations must survive
  test('duration "for 5 years" survives', () => assertSurvives('symptoms for 5 years'));
  test('"3 years ago" survives', () => assertSurvives('came 3 years ago'));
  test('"q8h for 7 days" survives', () => assertSurvives('q8h for 7 days'));
});

// ===========================================================================
// PHONE NUMBERS — every realistic Thai + intl grouping
// ===========================================================================
describe('adversarial — phone numbers', () => {
  test('081-234-5678', () => assertScrubbed('โทร 081-234-5678', ['081', '5678']));
  test('0812345678 plain', () => assertScrubbed('phone 0812345678', ['0812345678']));
  test('081 234 5678 spaces', () => assertScrubbed('โทร 081 234 5678', ['081', '5678']));
  test('10-digit mobile 0991234567', () => assertScrubbed('0991234567 มือถือ', ['0991234567']));
  test('landline 02-123-4567', () => assertScrubbed('call 02-123-4567', ['4567']));
  test('+66 81 234 5678', () => assertScrubbed('ติดต่อ +66 81 234 5678', ['81', '5678']));
  test('+66-2-123-4567', () => assertScrubbed('+66-2-123-4567', ['4567']));

  // LEAK CLASS: parenthesised area code
  test('(081) 234-5678 parens', () => assertScrubbed('โทร (081) 234-5678', ['081', '5678']));
  // LEAK CLASS: country code 66 without +
  test('66812345678 no plus', () => assertScrubbed('โทร 66812345678', ['66812345678']));
  // LEAK CLASS: +66 (0) trunk form
  test('+66 (0) 81 234 5678', () => assertScrubbed('tel +66 (0) 81 234 5678', ['81', '5678']));

  // NEGATIVES — lab counts / vitals must survive
  test('platelet 250000 survives', () => assertSurvives('platelet 250000'));
  test('WBC 12000 cells survives', () => assertSurvives('WBC 12000 cells'));
  test('BP 120/80 survives', () => assertSurvives('BP 120/80'));
});

// ===========================================================================
// EMAIL + LINE
// ===========================================================================
describe('adversarial — email and LINE ids', () => {
  test('lowercase email', () => assertScrubbed('email: somchai.j@hospital.go.th', ['somchai.j@hospital.go.th']));
  test('uppercase email', () => assertScrubbed('mail Somchai.J@HOSPITAL.GO.TH', ['Somchai.J@HOSPITAL.GO.TH']));

  test('line: id', () => assertScrubbed('line: somchai_99', ['somchai_99']));
  test('LINE ID: id', () => assertScrubbed('LINE ID: doctor.somchai', ['doctor.somchai']));

  // LEAK CLASS: Thai LINE label
  test('ไลน์ไอดี id', () => assertScrubbed('ไลน์ไอดี somchai99', ['somchai99']));
  test('ไลน์ id (no colon)', () => assertScrubbed('ไลน์ somchai.j', ['somchai.j']));
  // LEAK CLASS: @handle form
  test('LINE @handle', () => assertScrubbed('LINE @somchai', ['somchai']));
});

// ===========================================================================
// CITIZEN ID (13 digits) — spaced / dashed / plain / labelled
// ===========================================================================
describe('adversarial — 13-digit Thai national ID', () => {
  test('plain 13 digits', () => assertScrubbed('บัตรประชาชน 1234567890123', ['1234567890123']));
  test('dashed canonical', () => assertScrubbed('ID 1-2345-67890-12-3', ['1-2345-67890-12-3']));
  test('space-grouped', () => assertScrubbed('เลขบัตร 1 2345 67890 12 3', ['1 2345 67890 12 3']));
  test('leading 3', () => assertScrubbed('3-1009-01234-56-7', ['3-1009-01234-56-7']));
  test('bare 13 digits no label', () => assertScrubbed('1234567890123', ['1234567890123']));

  // NEGATIVE — an 8-digit lot number is not an ID
  test('8-digit lot number survives', () => assertSurvives('lot number 12345678 of vaccine'));
});

// ===========================================================================
// HN / AN / MRN variants
// ===========================================================================
describe('adversarial — HN / AN / MRN', () => {
  test('HN 12345678', () => assertScrubbed('ผู้ป่วย HN 12345678 มาด้วย', ['12345678']));
  test('HN: prefix', () => assertScrubbed('HN: 99001234', ['99001234']));
  test('hn glued lowercase', () => assertScrubbed('hn12345678', ['12345678']));
  test('MRN: code', () => assertScrubbed('MRN: 4455667', ['4455667']));
  test('MRN #hash', () => assertScrubbed('MRN #00123456', ['00123456']));
  test('AN code', () => assertScrubbed('AN 1234567', ['1234567']));
  // LEAK CLASS: AN with an internal dash
  test('AN with internal dash', () => assertScrubbed('AN: 12-34567', ['12-34567']));

  // NEGATIVE — "an" English word must not trigger
  test('the word "an" survives', () => assertSurvives('an elderly patient'));
});

// ===========================================================================
// ADDRESSES — บ้านเลขที่ / หมู่ / ตำบล / อำเภอ / จังหวัด
// ===========================================================================
describe('adversarial — Thai home address components', () => {
  // LEAK CLASS: no address pass existed at all.
  test('full address line — house no / moo / tambon / amphoe / province', () => {
    const input = 'บ้านเลขที่ 99/1 หมู่ 5 ตำบลบางรัก อำเภอเมือง จังหวัดเชียงใหม่';
    const out = stripPii(input);
    for (const frag of ['99/1', 'บางรัก', 'อำเภอเมือง', 'เชียงใหม่']) {
      expect(out).not.toContain(frag);
    }
  });

  test('house number บ้านเลขที่ alone', () => {
    assertScrubbed('บ้านเลขที่ 123/45', ['123/45']);
  });

  test('moo number', () => {
    assertScrubbed('หมู่ 7 ตำบลสุเทพ', ['สุเทพ']);
  });

  // NEGATIVES — generic words that merely begin with an address keyword
  test('หมู่บ้าน (village) survives', () => assertSurvives('อยู่ในหมู่บ้านจัดสรร'));
});

// ===========================================================================
// CLINICAL CONTENT — must SURVIVE (anti-over-masking regression wall)
// ===========================================================================
describe('adversarial — clinical content survives (negatives)', () => {
  const survive = [
    'BP 120/80 mmHg',
    'HR 88, RR 20',
    'O2 sat 98%',
    'SpO2 95% on room air',
    'Hb 12.5, WBC 8000, Plt 250000',
    'Cr 1.2 mg/dL, BUN 18',
    'give paracetamol 500 mg PO q6h',
    'amlodipine 5 mg OD, metformin 850 mg BID',
    'GCS 15, BMI 24.5',
    'ratio 1:2 dilution',
    'titer 1:160',
    'urine RBC 2-3/HPF',
    'pH 7.35, pCO2 40, HCO3 24',
    'EF 55% on echo',
    'T 37.2 C',
    'ECG showed ST elevation in V1-V3',
    'troponin 0.04 ng/mL',
    'INR 2.5 on warfarin',
    'glucose 126 mg/dL fasting',
    'wt 72 kg, ht 170 cm',
  ];
  test.each(survive)('survives: %s', assertSurvives);
});

// ===========================================================================
// COREFERENCE + MULTI-TURN
// ===========================================================================
describe('adversarial — coreference and multi-turn stability', () => {
  test('same person across turns reuses one token; HN stable', () => {
    const history = [
      { role: 'physician', content: 'นพ.สมชาย ดูแลผู้ป่วย HN 12345678 โทร 081-234-5678' },
      { role: 'assistant', content: 'ขอข้อมูลเพิ่มเติม' },
      { role: 'physician', content: 'สมชาย แจ้งว่า HN 12345678 ดีขึ้น' },
    ];
    const out = stripHistoryPii(history);
    const all = out.map(m => m.content).join(' || ');
    for (const frag of ['สมชาย', '12345678', '081-234-5678', '5678']) {
      expect(all).not.toContain(frag);
    }
  });

  test('two distinct people get distinct tokens', () => {
    const out = stripPii('นพ.สมชาย ปรึกษา พญ.สมหญิง');
    expect(out).toBe('นพ.[NAME-1] ปรึกษา พญ.[NAME-2]');
  });
});

// ===========================================================================
// BARE-NAME LEAK — the documented residual, now closed by intake hints +
// the conservative Thai given-name gazetteer.
// ===========================================================================
describe('adversarial — bare unlabelled names', () => {
  test('intake hint scrubs an unanchored name a regex would miss', () => {
    const raw = 'ผู้ป่วยรายนี้คือสมชายอุดมมาด้วยไข้สูง'; // no title, no label, glued mid-sentence
    const out = stripPii(raw, undefined, deriveHintTokens('นายสมชายอุดม'));
    expect(out).not.toContain('สมชายอุดม');
  });
  test('gazetteer catches a known bare given name before a clinical lead (no intake)', () => {
    expect(stripPii('สมชายมาด้วยไข้')).not.toContain('สมชาย');
  });
  test('clan-surname pass catches a bare แซ่ surname after a title-led name (no intake)', () => {
    // The title rule masks the given name; the verbatim แซ่ pass closes the bare-surname residual.
    expect(stripPii('ผู้ป่วยนายสมชาย แซ่ลี้ มาด้วยไข้ 3 วัน')).not.toContain('แซ่ลี้');
  });
  test('clan-surname pass catches a แซ่ surname GLUED to a following non-lead word', () => {
    // The conservative gazetteer guard would have leaked this; the verbatim แซ่ pass does not.
    expect(stripPii('นายสมชาย แซ่ตั้งเข้ารับการรักษา')).not.toContain('แซ่ตั้ง');
  });
  test('a clinical phrase that is NOT a gazetteer name survives byte-for-byte', () => {
    assertSurvives('ผู้ป่วยมาด้วยอาการปวดท้องและไข้ 3 วัน');
  });
});
