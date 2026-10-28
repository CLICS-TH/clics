// The error-body block at the bottom drives the real routes; the AI seam, RAG and Supabase are
// mocked so the suite stays hermetic (no provider, no network, no key).
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const { stripPii, stripHistoryPii, deriveHintTokens } = require('../src/services/pii-filter');
const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');
const { QueueFullError } = require('../src/services/providers/runtime');

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

  // LEAK CLASS (#224): a bare native Thai surname after a masked Thai given name, with no patient_ref,
  // no chief complaint and no นามสกุล keyword. The given name was masked (gazetteer / title rule) but
  // the surname went to the model in clear. It must take the SAME token as the given name.
  test('bare surname after a gazetteer given name folds into its token, across turns (#224)', () => {
    const out = stripHistoryPii([
      { role: 'physician', content: 'สมชาย ใจดี HN 12345678' },
      { role: 'physician', content: 'ผู้ป่วย สมชาย ใจดี' },
    ]).map(m => m.content);
    for (const frag of ['ใจดี', 'สมชาย', '12345678']) expect(out.join(' || ')).not.toContain(frag);
    expect(out).toEqual(['[NAME-1] [NAME-1] [HN-1]', 'ผู้ป่วย [NAME-1] [NAME-1]']);
  });
  test('bare surname after a title-led given name folds into its token (#224)', () => {
    expect(stripPii('นายสมชาย ใจดี HN 12345678')).toBe('นาย[NAME-1] [NAME-1] [HN-1]');
  });
  test('the captured surname is an alias: a later bare repeat in another message folds too (#224)', () => {
    const out = stripHistoryPii([
      { role: 'physician', content: 'นายสมชาย ใจดี มาด้วยไข้' },
      { role: 'physician', content: 'ใจดี บอกว่ายังมีไข้' },
    ]).map(m => m.content);
    expect(out).toEqual(['นาย[NAME-1] [NAME-1] มาด้วยไข้', '[NAME-1] บอกว่ายังมีไข้']);
  });
  test('the captured surname folds in later only as a WHOLE word, never inside another word (#224)', () => {
    const out = stripHistoryPii([
      { role: 'physician', content: 'นายสมชาย ใจดี มาด้วยไข้' },
      { role: 'physician', content: 'จิตใจดีขึ้น ให้ยากันชักเกร็ง' },
      { role: 'physician', content: 'ติดตาม ใจดี. นัด [NAME-9]ใจดี 2 สัปดาห์' },
    ]).map(m => m.content);
    expect(out).toEqual([
      'นาย[NAME-1] [NAME-1] มาด้วยไข้',
      'จิตใจดีขึ้น ให้ยากันชักเกร็ง',
      'ติดตาม [NAME-1]. นัด [NAME-9][NAME-1] 2 สัปดาห์',
    ]);
  });
  test('a word that is only captured as a surname does not mask later prose that contains it (#224)', () => {
    const out = stripHistoryPii([
      { role: 'physician', content: 'นายสมชาย ชักเกร็ง 2 ครั้ง' },
      { role: 'physician', content: 'มีประวัติชักเกร็งตอนเด็ก ให้ยากันชักเกร็ง' },
    ]).map(m => m.content);
    expect(out).toEqual(['นาย[NAME-1] ชักเกร็ง 2 ครั้ง', 'มีประวัติชักเกร็งตอนเด็ก ให้ยากันชักเกร็ง']);
  });
  // A trailing "." or a glued token used to make the pass skip the surname (review of #224).
  test.each([
    ['สมชาย ใจดี.', '[NAME-1] [NAME-1].'],
    ['Pt is นายสมชาย ใจดี.', 'Pt is นาย[NAME-1] [NAME-1].'],
    ['นายสมชาย ใจดี0812345678', 'นาย[NAME-1] [NAME-1][PHONE-1]'],
  ])('bare surname before "." or a glued token is still taken: %s (#224)', (input, expected) => {
    expect(stripPii(input)).toBe(expected);
  });
  // Common native surnames, several built on words that also open clinical text (ทอง, ใจ, แก้ว, สุข).
  // The measured clinical-lead list must not block any of them.
  test.each(['ใจดี', 'ศรีสุข', 'วงศ์ใหญ่', 'ทองดี', 'สุขสวัสดิ์', 'รัตนพันธ์', 'บุญมา', 'แก้วมณี'])(
    'common surname %s after a masked given name is masked (#224)', (surname) => {
      for (const input of [`นายสมชาย ${surname} มาด้วยไข้`, `สมชาย ${surname}`, `นพ.สมศักดิ์ ${surname}.`]) {
        const out = stripPii(input);
        expect(out).not.toContain(surname);
        expect(out).toMatch(/(\[NAME-\d+\]) \1/);
      }
    });
  test('no generated clinical lead is a prefix of a common surname component (#224)', () => {
    const { TH_CORPUS_CLINICAL_LEADS } = require('../src/services/pii-clinical-leads.th');
    const { TH_SURNAME_LEAD_MORPHEMES } = require('../src/services/pii-names.th');
    const blocking = TH_CORPUS_CLINICAL_LEADS.filter((lead) => TH_SURNAME_LEAD_MORPHEMES.some((m) => m.startsWith(lead)));
    expect(blocking).toEqual([]); // rerun rimpl/scripts/build-th-clinical-leads.js after editing the morphemes
  });
});

// ===========================================================================
// CLINICAL FALSE-POSITIVE SHIELDS — the คุณ / ชื่อ / LINE / WARD / ADDR rules
// were narrowed so clinical prose survives (ขอบคุณครับ, ชื่อยา, first-line,
// toward, ต่างจังหวัด, รพ.สต.). Each shield is a closed list; these red-team
// cases prove none of them opened a door: the real identifier wearing the same
// shape must still be gone. (Survive-side cases: pii-false-positives.test.js.)
// ===========================================================================
describe('adversarial — clinical false-positive shields do not open a leak', () => {
  test.each([
    // คุณ: a name glued after a polite phrase / inside a let-through run / after a role word
    ['ขอบคุณครับคุณสมศรี', ['สมศรี']],
    ['ขอบคุณค่ะคุณหมอสมชาย', ['สมชาย']],
    ['ขอบคุณครับสมชาย', ['สมชาย']],
    ['คุณภาพชีวิตของคุณสมศรีดีขึ้น', ['สมศรี']],
    ['คุณคิดว่านายวีระเป็นอะไร', ['วีระ']],
    ['คุณหมอวราภรณ์ สั่งยา', ['วราภรณ์']],
    // a name that starts like a particle / a non-shield lead
    ['คุณคะนอง มาตามนัด', ['คะนอง', 'นอง']],
    ['คุณมาลี มาตามนัด', ['มาลี']],
    ['คุณมีนา มาตามนัด', ['มีนา']],
    ['คุณต้อง มาตามนัด', ['ต้อง']], // a nickname that is also the verb "must"
    // ชื่อ: a name beginning with a label word; a real label after a thing-label
    ['ผู้ป่วยชื่อยาใจ มาตามนัด', ['ยาใจ']],
    ['ชื่อยาที่ใช้คือ ชื่อ มานะ', ['มานะ']],
    ['ชื่อยาที่ผู้ป่วยชื่อสมชายได้รับ', ['สมชาย']],
    // LEAK CLASS (pre-existing, closed here): the bare-surname slot swallowed a second ชื่อ label and
    // left the real name outside the match — master emitted "… [NAME-1] มานะ".
    ['ชื่อ สมชาย ผู้ป่วยชื่อ มานะ', ['สมชาย', 'มานะ']],
    ['ชื่อยา ผู้ป่วยชื่อ มานะ', ['มานะ']],
    // LINE: the ids keep masking without a colon when the form is unambiguous
    ['add line somchai99', ['somchai99']],
    ['LINE somchai', ['somchai']],
    ['line doctor.somchai', ['doctor.somchai']],
    ['ไลน์ไอดี somchai99', ['somchai99']],
    // WARD: identifiers after a real "ward"
    ['ward 5A bed 12', ['5A']],
    ['admitted to ward ICU', ['ward ICU']],
    ['หอผู้ป่วย 4', ['หอผู้ป่วย 4']],
    // ADDR: a real place after the narrowed keywords
    ['รพ.สต.บ้านหนองบัว', ['หนองบัว']],
    ['ส่งตัวไป รพ.จังหวัดเชียงใหม่', ['เชียงใหม่']],
    ['อยู่ในจังหวัดเชียงใหม่', ['เชียงใหม่']],
    ['ตำบลในเมือง อำเภอจะนะ', ['ในเมือง', 'จะนะ']],
  ])('%s', (input, leaked) => {
    assertScrubbed(input, leaked);
  });
});

// ===========================================================================
// PR #114 REVIEW — C1 / C2: names that BEGIN with a shield word, and names after
// a role word + function word. Commit 922002d leaked 117 of these 204 cases (the
// shield let the rest of the glued run through); master leaked 0. Every name x
// every template must stay masked. (Names are synthetic; non-gazetteer names
// are included on purpose — only the anchor rules can catch them.)
// ===========================================================================
describe('adversarial — a name that starts like a shield word, or follows role + function word', () => {
  // สามารถ / ช่วย / ประโยชน์: given names that are ALSO everyday words — once list words, removed after the
  // second review of PR #114 ("คุณสามารถ อายุ 50 ปี" leaked).
  const NAMES = ['ของขวัญ', 'ภาพพิมพ์', 'ภาพร', 'ภาพิมล', 'คิดถึง', 'กำลังใจ', 'มาลี', 'มีนา', 'ต้อง', 'คะนอง', 'วิไล', 'สมศรี',
    'สามารถ', 'ช่วย', 'ประโยชน์'];
  const TEMPLATES = [
    'คุณ{N} อายุ 45 ปี มาด้วยไข้', 'คุณ{N} มาตามนัด', 'คุณ{N}มาด้วยไข้', 'ภรรยาของคุณ{N}โทรมา', 'ขอบคุณครับคุณ{N}',
    'คุณหมอ{N} ตรวจคนไข้', 'คุณแม่ของ{N}โทรมาสอบถามอาการ', 'คุณยายของ{N}มาเยี่ยม', 'คุณหมอให้ยา{N}แล้ว',
    'คุณพ่อของ{N}พามาโรงพยาบาล', 'ผู้ป่วยชื่อ {N} มาตามนัด', 'ชื่อยาที่ให้คุณ{N}คือ amlodipine', 'คุณ{N}',
    'คุณ {N} มาตามนัด', 'คุณภาพชีวิตของคุณ{N}ดีขึ้น', 'คุณครับ คุณ{N}ครับ', 'คุณพยาบาลแจ้งว่าคุณ{N}มาแล้ว',
  ];
  const CASES = NAMES.flatMap((n) => TEMPLATES.map((t) => [n, t.replace('{N}', n)]));
  test.each(CASES)('%s in: %s', (name, input) => {
    assertScrubbed(input, [name]);
  });

  test('a quantifier before จังหวัด no longer hides the province that follows', () => {
    for (const input of ['ต่างจังหวัดเชียงใหม่', 'ทุกจังหวัด เชียงใหม่', 'แต่ละจังหวัด ลำพูน', 'หลายจังหวัดสงขลา']) {
      assertScrubbed(input, ['เชียงใหม่', 'ลำพูน', 'สงขลา']);
    }
  });
});

// ===========================================================================
// PR #114 REVIEW — I1: the first shield re-scanned fragments RECURSIVELY, so a
// 5000-char "คุณจะคุณจะ…" (the backend's max message) blew the stack, and the
// unhandled rejection exited RIMPL. Each input runs in a FRESH child process
// (cold JIT, default stack — a warm jest worker can hide it) and must neither
// throw nor take 200 ms.
// ===========================================================================
describe('adversarial — pathological repetitions cannot crash or stall the filter', () => {
  const { execFileSync } = require('child_process');
  const FILTER = require.resolve('../src/services/pii-filter');
  test.each([
    ['คุณจะ', 1000], ['คุณก็', 1000], ['คุณนะ', 1000], ['คุณภาพ', 1200], ['ชื่อยาที่', 1200], ['คุณหมอ', 1000],
  ])('%s x %d in a cold process', (unit, n) => {
    const code = `const { stripPii } = require(${JSON.stringify(FILTER)});
      const s = ${JSON.stringify(unit)}.repeat(${n});
      const t = process.hrtime.bigint();
      stripPii(s);
      process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6));`;
    const ms = Number(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' })); // throws on a crash
    expect(ms).toBeLessThan(200);
  });

  // Second review of PR #114: each resume re-matched the rest of the glued run, so n nested anchors cost
  // O(n^2) — 'คุณ' x 100000 took 1.28 s (7.5 s cold here) vs 3.7 ms on master, reachable through an
  // anonymous guest's history. Runs longer than SHIELD_MAX_RUN now take master's linear path, and runs
  // under it are bounded per run.
  // Budget: 500 ms. It is sized against the REGRESSION, not against master's speed: the quadratic
  // version took 1260–7500 ms cold on these exact inputs, while the fixed filter takes ~5–50 ms locally
  // and ~2x that on CI, where jest runs with --coverage instrumentation. A 100 ms budget flaked on CI
  // (102 ms, 2026-10-02) without catching anything a 500 ms budget would miss.
  test.each([
    ["'คุณ'.repeat(100000)"], ["'คุณจะ'.repeat(40000)"], ["'ชื่อยาที่'.repeat(20000)"],
    ["('คุณ'.repeat(85) + ' ').repeat(400)"], // every run just under the bound: still linear
  ])('%s in a cold process stays linear', (expr) => {
    const code = `const { stripPii } = require(${JSON.stringify(FILTER)});
      const s = ${expr};
      const t = process.hrtime.bigint();
      stripPii(s);
      process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6));`;
    const ms = Number(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }));
    expect(ms).toBeLessThan(500);
  });
});

// ===========================================================================
// ERROR BODIES — a failing call must not echo the transcript back out. The
// 413 / 503 / 500 paths (lib/ai-errors.js) are driven through the REAL routes
// with a PII-laden transcript AND a provider error whose message quotes the
// prompt — the adversarial worst case. Status and headers are the contract
// the backend builds on; the body must carry no transcript, name or id.
// ===========================================================================
describe('adversarial — error bodies through /chat and /evaluate carry no transcript, names or ids', () => {
  const RAW = {
    name: 'สมชาย ใจดี', hn: 'HN 12345678', phone: '081-234-5678', cid: '1234567890123',
    email: 'somchai.j@hospital.go.th', clinical: 'มาด้วยอาการเจ็บหน้าอก 2 ชั่วโมง troponin 0.04',
  };
  const line = `ผู้ป่วยชื่อ ${RAW.name} ${RAW.hn} โทร ${RAW.phone} บัตร ${RAW.cid} email ${RAW.email} ${RAW.clinical}`;
  const history = [{ role: 'physician', content: line }, { role: 'assistant', content: 'ขอข้อมูลเพิ่มเติม' }];
  // Identifiers AND clinical content: an error body has no business carrying either.
  const LEAKS = ['สมชาย', 'ใจดี', '12345678', '081-234-5678', '5678', RAW.cid, RAW.email, 'somchai', 'เจ็บหน้าอก', 'troponin'];

  // A provider error that quotes the prompt in its message.
  const echoing = (props) => Object.assign(new Error(`provider failed on: ${line}`), props);

  const FAILURES = [
    ['413 transcript_too_large', () => echoing({ status: 413, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 99999, limit: 32000 }), 413],
    ['503 queue_full', () => new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }), 503],
    ['500 generic provider failure', () => echoing({ status: 500 }), 500],
  ];

  let errSpy, warnSpy;
  beforeEach(() => {
    callAI.mockReset();
    resolveProviderName.mockReset().mockResolvedValue('anthropic');   // /evaluate pins the resolved provider before its first call
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

  function assertNoLeak(res) {
    const wire = JSON.stringify(res.body) + JSON.stringify(res.headers) + res.text;
    for (const frag of LEAKS) expect(wire).not.toContain(frag);
  }

  describe.each(FAILURES)('%s', (_label, makeErr, status) => {
    test('POST /chat', async () => {
      callAI.mockRejectedValueOnce(makeErr());
      const res = await request(app).post('/chat').send({
        ple_id: 'x', history, message: line, language: 'th', patient_ref: RAW.name,
      });
      expect(res.status).toBe(status);
      assertNoLeak(res);
      // The model saw only the de-identified text even on the failing call.
      const sent = JSON.stringify(callAI.mock.calls[0][0].messages);
      for (const frag of ['สมชาย', 'ใจดี', '12345678', '081-234-5678', RAW.cid, RAW.email]) expect(sent).not.toContain(frag);
    });

    test('POST /evaluate', async () => {
      callAI.mockRejectedValueOnce(makeErr());
      const res = await request(app).post('/evaluate').send({
        ple_id: 'x', transcript: history, patient_ref: RAW.name, shadow: false,
      });
      expect(res.status).toBe(status);
      assertNoLeak(res);
    });

    test('POST /evaluate-criteria and /audit-discuss', async () => {
      callAI.mockRejectedValueOnce(makeErr());
      const criteria = await request(app).post('/evaluate-criteria').send({ transcript: history, patient_ref: RAW.name });
      expect(criteria.status).toBe(status);
      assertNoLeak(criteria);
      callAI.mockRejectedValueOnce(makeErr());
      const discuss = await request(app).post('/audit-discuss').send({ message: line, transcript: history, patient_ref: RAW.name });
      expect(discuss.status).toBe(status);
      assertNoLeak(discuss);
    });
  });

  test('413 body: numbers only (est_tokens, limit) and a generic message — the server hint stays in the logs', async () => {
    callAI.mockRejectedValueOnce(FAILURES[0][1]());
    const res = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: history, patient_ref: RAW.name, shadow: false });
    expect(res.body).toEqual({ error: expect.any(String), code: 'transcript_too_large', est_tokens: 99999, limit: 32000 });
    expect(res.body.error).not.toMatch(/num_ctx|Modelfile|OLLAMA|max-model-len|serving/);
  });

  test('413 body: `calibration` passes through as two NUMBERS only — anything else the provider hung on it is dropped', async () => {
    // The self-calibrating backstop (providers/local.js) attaches { ratio, n }. An adversarial provider
    // object that also carries text — the transcript, a model name — must not get those into the body.
    callAI.mockRejectedValueOnce(echoing({ status: 413, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 61000, limit: 60000,
      calibration: { ratio: 3.371, n: 5, note: line, model: 'qwen3-32b-medical' } }));
    const res = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: history, patient_ref: RAW.name, shadow: false });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: expect.any(String), code: 'transcript_too_large', est_tokens: 61000, limit: 60000, calibration: { ratio: 3.371, n: 5 } });
    assertNoLeak(res);

    // A non-numeric ratio (a string that happens to look like a number) is null, never text.
    callAI.mockRejectedValueOnce(echoing({ status: 413, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 61000, limit: 60000,
      calibration: { ratio: `3.371 ${line}`, n: 5 } }));
    const res2 = await request(app).post('/chat').send({ ple_id: 'x', history, message: line, language: 'th', patient_ref: RAW.name });
    expect(res2.status).toBe(413);
    expect(res2.body.calibration).toEqual({ ratio: null, n: 5 });
    assertNoLeak(res2);
  });

  test('503 body: code + retry_after_s, and the Retry-After header', async () => {
    callAI.mockRejectedValueOnce(FAILURES[1][1]());
    const res = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: history, patient_ref: RAW.name, shadow: false });
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({ error: expect.any(String), code: 'queue_full', retry_after_s: 30 });
  });

  test('500 body: the route\'s fixed message only — never the provider\'s message', async () => {
    callAI.mockRejectedValueOnce(FAILURES[2][1]());
    const res = await request(app).post('/chat').send({ ple_id: 'x', history, message: line, language: 'th', patient_ref: RAW.name });
    expect(res.body).toEqual({ error: 'AI service temporarily unavailable. Please try again.' });
  });
});

// ===========================================================================
// SELF-CONSISTENCY — the local arm scores 2–3 times and reconciles (services/
// consistency.js). The `consistency` block rides in the 200 body AND in
// provenance, both of which the backend persists. It must carry integers,
// nulls and strings from a fixed vocabulary — never a rationale, never the
// transcript — even when the model's rationale quotes the raw identifiers.
// ===========================================================================
describe('adversarial — the consistency block on a 200 /evaluate carries numbers and fixed vocabulary only', () => {
  const RAW = { name: 'สมชาย ใจดี', hn: 'HN 12345678', phone: '081-234-5678', cid: '1234567890123', email: 'somchai.j@hospital.go.th' };
  const line = `ผู้ป่วยชื่อ ${RAW.name} ${RAW.hn} โทร ${RAW.phone} บัตร ${RAW.cid} email ${RAW.email} มาด้วยอาการเจ็บหน้าอก`;
  const LEAKS = ['สมชาย', 'ใจดี', '12345678', '081-234-5678', '5678', RAW.cid, RAW.email, 'somchai', 'เจ็บหน้าอก', 'RATIONALE-SENTINEL'];
  const VOCAB = new Set(['self-consistency', 'adaptive', 'median3', 'off', 'single', 'first-of-agreeing-pair', 'median-of-3']);
  // A model that echoes the raw identifiers in its rationale — the worst case for anything derived from replies.
  const scored = (d7, tag) => ({
    text: JSON.stringify({ d1: 3, d2: 4, d3: 3, d4: 2, d5: 5, d6: 1, d7, rationale: { d1: `RATIONALE-SENTINEL #${tag}: ${line}` } }),
    inputTokens: 1000 + tag, outputTokens: 100 + tag, provider: 'local', model: 'qwen-test', stopReason: 'end_turn',
  });
  const leaves = (v, out = []) => {
    if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
    else out.push(v);
    return out;
  };

  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.EVAL_CONSISTENCY;
    process.env.EVAL_CONSISTENCY = 'adaptive';
    callAI.mockReset();
    resolveProviderName.mockReset().mockResolvedValue('local');
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.EVAL_CONSISTENCY; else process.env.EVAL_CONSISTENCY = savedEnv;
  });

  test('median-of-3 (the largest block): fixed keys, integer / null / vocabulary leaves, no identifier, no rationale text', async () => {
    callAI.mockResolvedValueOnce(scored(4, 1)).mockResolvedValueOnce(scored(2, 2)).mockResolvedValueOnce(scored(3, 3));
    const res = await request(app).post('/evaluate').send({
      ple_id: 'x', transcript: [{ role: 'physician', content: line }], patient_ref: RAW.name, shadow: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.consistency.rule).toBe('median-of-3');
    expect(res.body.domain_rationale.d1).toContain('RATIONALE-SENTINEL');     // the rationale itself travels as before…

    for (const block of [res.body.consistency, res.body.provenance.consistency]) {
      expect(block).toEqual(res.body.consistency);
      const wire = JSON.stringify(block);
      for (const frag of LEAKS) expect(wire).not.toContain(frag);                // …but none of it is in the block
      expect(Object.keys(block).sort()).toEqual([
        'agree', 'calls', 'extra_input_tokens', 'extra_output_tokens', 'json_retries', 'latency_ms',
        'max_delta', 'method', 'mode', 'per_call_scores', 'rule', 'sum_delta',
      ]);
      expect(Object.keys(block.agree).sort()).toEqual(['max_domain_delta', 'max_sum_delta']);
      for (const leaf of leaves(block)) {
        if (typeof leaf === 'string') expect(VOCAB.has(leaf)).toBe(true);
        else expect(leaf === null || Number.isInteger(leaf)).toBe(true);
      }
    }
    // Every call saw only the de-identified transcript.
    for (const [call] of callAI.mock.calls) {
      const sent = JSON.stringify(call.messages);
      for (const frag of ['สมชาย', 'ใจดี', '12345678', '081-234-5678', RAW.cid, RAW.email]) expect(sent).not.toContain(frag);
    }
    // D21: the physician is billed call 1; the block accounts for the rest.
    expect(res.body.input_tokens).toBe(1001);
    expect(res.body.consistency.extra_input_tokens).toBe(1002 + 1003);
  });

  test('first-of-agreeing-pair: same guarantees on the two-call block', async () => {
    callAI.mockResolvedValueOnce(scored(4, 1)).mockResolvedValueOnce(scored(4, 2));
    const res = await request(app).post('/evaluate').send({
      ple_id: 'x', transcript: [{ role: 'physician', content: line }], patient_ref: RAW.name, shadow: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.consistency.rule).toBe('first-of-agreeing-pair');
    const wire = JSON.stringify(res.body.consistency) + JSON.stringify(res.body.provenance.consistency);
    for (const frag of LEAKS) expect(wire).not.toContain(frag);
  });
});

// ===========================================================================
// ONE REGISTRY PER OUTBOUND CALL. /chat used to de-identify the chief
// complaint, the history and the current message under THREE registries, each
// numbering from 1 — so inside one prompt "[NAME-1]" in the history and
// "[NAME-1]" in the message could be two different people, and a name the
// history introduced with a title went out BARE when the message repeated it
// without one (the message's fresh registry had never seen it). /audit-discuss
// had the same split across transcript / history / message. Names here are
// NOT in the given-name gazetteer on purpose: only the shared registry's
// bare-name pass can catch their untitled repeat.
// ===========================================================================
describe('adversarial — one registry per outbound call (coreference across the whole prompt)', () => {
  const A = 'กฤตภาส';   // person A — titled นาย, then repeated bare
  const B = 'วรินทร';   // person B — a different person, titled นาง
  const tokenAfter = (text, title) => (new RegExp(`${title}(\\[NAME-\\d+\\])`).exec(text) || [])[1];
  const citedReply = { text: 'พิจารณาตามแนวทาง (ESC, 2023).\n❓ คิดถึงอะไรต่อ', tokenCount: 10, inputTokens: 5, outputTokens: 5, provider: 'anthropic' };

  let warnSpy, errSpy;
  beforeEach(() => {
    callAI.mockReset().mockResolvedValue(citedReply);
    require('../src/services/rag').ragLookup.mockClear();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { warnSpy.mockRestore(); errSpy.mockRestore(); });

  const chat = (body) => request(app).post('/chat').send({ ple_id: 'x', language: 'th', ...body });
  const sentMessages = (i = 0) => callAI.mock.calls[i][0].messages;

  test('/chat: the same person in the history and the current message gets the SAME token', async () => {
    // B is named FIRST in the message, so a registry private to the message would number A "[NAME-2]".
    await chat({ history: [{ role: 'physician', content: `นาย${A} มาด้วยไข้` }, { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' }],
      message: `นาง${B} บอกว่า นาย${A} ยังมีไข้อยู่` });
    const [hist, , last] = sentMessages();
    const inHistory = tokenAfter(hist.content, 'นาย');
    expect(inHistory).toMatch(/^\[NAME-\d+\]$/);
    expect(tokenAfter(last.content, 'นาย')).toBe(inHistory);
    expect(JSON.stringify(sentMessages())).not.toContain(A);
  });

  test('/chat: two different people never share a token (history vs current message)', async () => {
    await chat({ history: [{ role: 'physician', content: `นาย${A} มาด้วยไข้` }, { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' }],
      message: `นาง${B} เป็นภรรยา` });
    const [hist, , last] = sentMessages();
    const a = tokenAfter(hist.content, 'นาย');
    const b = tokenAfter(last.content, 'นาง');
    expect(a).toMatch(/^\[NAME-\d+\]$/);
    expect(b).toMatch(/^\[NAME-\d+\]$/);
    expect(b).not.toBe(a); // separate registries gave BOTH "[NAME-1]"
  });

  test('/chat: a name the history introduced with a title is masked when the message repeats it BARE (leaked before)', async () => {
    await chat({ history: [{ role: 'physician', content: `นาย${A} มาด้วยไข้` }, { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' }],
      message: `${A}ยังมีไข้อยู่` });
    const sent = JSON.stringify(sentMessages());
    expect(sent).not.toContain(A);
    const [hist, , last] = sentMessages();
    expect(last.content).toContain(tokenAfter(hist.content, 'นาย'));
    // RAG embeds the same de-identified message the model receives — never the raw name.
    const ragArg = require('../src/services/rag').ragLookup.mock.calls[0][0];
    expect(ragArg).not.toContain(A);
    expect(last.content).toContain(ragArg);
  });

  test('/chat: chief complaint and current message share the registry (coreference + the bare repeat)', async () => {
    await chat({ history: [], chief_complaint: `นาย${A} อายุ 45 ปี เจ็บหน้าอก`, message: `${A} ยังเจ็บอยู่ และ นาง${B} เป็นภรรยา` });
    const [last] = sentMessages();
    expect(last.content).not.toContain(A);
    expect(last.content).not.toContain(B);
    const a = tokenAfter(last.content, 'นาย');          // from the chief complaint block
    const tokens = last.content.match(/\[NAME-\d+\]/g);
    expect(tokens.filter(t => t === a).length).toBe(2); // CC "นาย[A]" and the message's bare "[A]"
    expect(tokenAfter(last.content, 'นาง')).not.toBe(a);
  });

  test('/chat: numbering is prefix-stable — turn N numbers the earlier turns exactly as turn N-1 did', async () => {
    const cc = `นาย${A} เจ็บหน้าอก`;
    const h1 = { role: 'physician', content: `นาง${B} พามา` };
    const h2 = { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' };
    await chat({ history: [h1, h2], chief_complaint: cc, message: `${B} บอกว่าปวดมาก` });
    await chat({ history: [h1, h2, { role: 'physician', content: `${B} บอกว่าปวดมาก` }, h2], chief_complaint: cc, message: 'ต่อ' });
    const firstTurn = sentMessages(0);
    const nextTurn = sentMessages(1);
    expect(nextTurn[0].content).toBe(firstTurn[0].content);   // h1 masked identically on both turns
    expect(nextTurn[2].content).toBe(firstTurn[2].content.split('\n\n').slice(1).join('\n\n')); // turn-1 message, now history
  });

  // #224: no patient_ref, no chief_complaint — only the in-text name rules stand between the surname and
  // the model. Both the history turn and the current message (and the RAG embed of it) must be clean.
  test.each([
    ['gazetteer given name', 'สมชาย ใจดี HN 12345678', 'ผู้ป่วย สมชาย ใจดี'],
    ['title-led given name', 'นายสมชาย ใจดี HN 12345678', 'ผู้ป่วย นายสมชาย ใจดี'],
  ])('/chat: a bare Thai surname after a %s never reaches the model (#224)', async (_label, turn, message) => {
    await chat({ history: [{ role: 'physician', content: turn }, { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' }], message });
    const sent = sentMessages();
    const ragArg = require('../src/services/rag').ragLookup.mock.calls[0][0];
    for (const frag of ['ใจดี', 'สมชาย', '12345678']) {
      expect(JSON.stringify(sent)).not.toContain(frag);
      expect(ragArg).not.toContain(frag);
    }
    // given name and surname resolve to ONE referent, in the history and in the message
    expect(sent[0].content).toMatch(/(\[NAME-\d+\]) \1 \[HN-\d+\]/);
    const tok = /\[NAME-\d+\]/.exec(sent[0].content)[0];
    expect(sent.at(-1).content).toContain(`${tok} ${tok}`);
  });

  test('/chat rescue classifier reads the SAME tokens as the chat call', async () => {
    const p = (content) => ({ role: 'physician', content });
    const a = { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' };
    callAI.mockReset()
      .mockResolvedValueOnce({ text: '{"c4":true,"c5":true,"c6":true,"c7":true,"on_topic":true}', inputTokens: 1, outputTokens: 1, provider: 'anthropic' })
      .mockResolvedValueOnce(citedReply);
    await chat({ history: [p(`นาย${A} มาด้วยไข้`), a, p('ต่อ'), a, p(`นาง${B} มาด้วย`), a, p('ต่อ'), a], message: `${A} กับ ${B} ยังมีไข้` });
    expect(callAI.mock.calls[0][0].purpose).toBe('criteria');
    const classifier = callAI.mock.calls[0][0].messages[0].content;
    const chatMsgs = callAI.mock.calls[1][0].messages;
    for (const frag of [A, B]) expect(classifier + JSON.stringify(chatMsgs)).not.toContain(frag);
    const ta = tokenAfter(chatMsgs[0].content, 'นาย');
    const tb = tokenAfter(chatMsgs[4].content, 'นาง');
    expect(tokenAfter(classifier, 'นาย')).toBe(ta);
    expect(tokenAfter(classifier, 'นาง')).toBe(tb);
    expect(classifier).toContain(`${ta} กับ ${tb} ยังมีไข้`);
    expect(chatMsgs.at(-1).content).toContain(`${ta} กับ ${tb} ยังมีไข้`);
  });

  test('/audit-discuss: transcript, discussion history and the auditor message share one registry', async () => {
    await request(app).post('/audit-discuss').send({
      transcript: [{ role: 'physician', content: `นาย${A} มาด้วยไข้` }, { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' }],
      history: [{ role: 'auditor', content: `นาง${B} คือใคร` }, { role: 'assistant', content: 'ไม่ทราบ' }],
      message: `${A} ได้ยาอะไร`,
    });
    const { systemPrompt, messages } = callAI.mock.calls[0][0];
    const wire = systemPrompt + JSON.stringify(messages);
    for (const frag of [A, B]) expect(wire).not.toContain(frag);    // the bare repeat in the message leaked before
    const ta = tokenAfter(systemPrompt, 'นาย');
    expect(messages.at(-1).content).toBe(`${ta} ได้ยาอะไร`);
    expect(tokenAfter(messages[0].content, 'นาง')).not.toBe(ta);
  });

  test('/audit-discuss: the chief complaint seeds the numbering but is never sent', async () => {
    await request(app).post('/audit-discuss').send({
      chief_complaint: `นาย${A} ผื่นแดงที่แขนซ้าย`, patient_ref: null,
      transcript: [{ role: 'physician', content: `${A} มาด้วยไข้` }], message: 'คิดอย่างไร',
    });
    const { systemPrompt, messages } = callAI.mock.calls[0][0];
    const wire = systemPrompt + JSON.stringify(messages);
    expect(wire).not.toContain(A);                // the bare transcript mention is caught via the CC alias
    expect(wire).not.toContain('ผื่นแดงที่แขนซ้าย'); // the CC text itself does not travel
    expect(systemPrompt).toContain('Physician: [NAME-1] มาด้วยไข้');
  });
});
