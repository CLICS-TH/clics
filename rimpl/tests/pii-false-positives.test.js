const { stripPii } = require('../src/services/pii-filter');

// ---------------------------------------------------------------------------
// Clinical FALSE POSITIVES of the de-identifier — and their near misses.
//
// Two independent synthetic-content passes (Phase 2 anchors, Phase 3 question
// bank) found ordinary clinical / polite Thai and English being masked as PII,
// which corrupts the very text PIS-7 scores. Each block below pins:
//   (1) the false positive — must now SURVIVE byte-for-byte, in a real clause; and
//   (2) the near miss — the real-identifier variant of the same shape, which must
//       STILL be masked (exact output where it is stable, absence of the raw
//       fragment otherwise).
// Under-masking is far worse than over-masking: every shield is a closed word
// list or a lookbehind, and anything it does not account for is still masked.
// The leak-side twins of these cases also live in pii-leak-adversarial.test.js.
// ---------------------------------------------------------------------------

const survives = (text) => expect(stripPii(text)).toBe(text);
const scrubbed = (text, leaked) => {
  const out = stripPii(text);
  for (const frag of leaked) expect(out).not.toContain(frag);
  return out;
};

describe('คุณ — polite / pronoun / compound uses are not a title + name', () => {
  test.each([
    'ขอบคุณครับ',
    'ขอบคุณค่ะ คุณหมอ',
    'ขอบคุณมากครับ ผู้ป่วยมาด้วยไข้',
    'ขอบพระคุณครับ',
    'คุณหมอครับ ผู้ป่วยมาด้วยไข้ 3 วัน',
    'คุณแม่ของผู้ป่วย',
    'คุณพยาบาลแจ้งว่า BP 90/60',
    'คุณภาพ',
    'คุณภาพชีวิตของผู้ป่วยดีขึ้น',
    'คุณภาพการนอน',
    'คุณค่า',
    'คุณลักษณะ',
    'คุณคิดว่า การวินิจฉัยคืออะไร',
    'คุณควรสั่ง troponin ซ้ำที่ 3 ชั่วโมง',
  ])('survives: %s', survives);

  // FAIL-CLOSED by design: a glued run is let through only if EVERY segment is a list word. Ordinary
  // prose glued after คุณ that the lists do not cover is still masked (as on master) — from the last
  // anchor (role word / compound) if there is one, else the whole run. Over-masking, never a leak.
  test.each([
    ['คุณคิดว่าการวินิจฉัยคืออะไร', 'คุณ[NAME-1]'],
    ['คุณจะให้ยาอะไรเป็นตัวแรก', 'คุณ[NAME-1]'],
    ['คุณแม่ของผู้ป่วยพามาโรงพยาบาล', 'คุณแม่[NAME-1]'],
    ['คุณภาพการนอนไม่ดี', 'คุณภาพการนอน[NAME-1]'],
    ['คุณค่าทางโภชนาการ', 'คุณค่า[NAME-1]'],
  ])('unlisted prose after คุณ is still masked (fail-closed): %s', (input, expected) => {
    expect(stripPii(input)).toBe(expected);
  });

  // Near misses — a real name after คุณ (or after a role word) is still masked.
  test('คุณ + given name', () => {
    expect(stripPii('คุณสมศรี มาตามนัด')).toBe('คุณ[NAME-1] มาตามนัด');
    expect(stripPii('คุณมานี มาตามนัด')).toBe('คุณ[NAME-1] มาตามนัด'); // มา is NOT a shield (มานี, มาลี)
    expect(stripPii('คุณมีนา มาตามนัด')).toBe('คุณ[NAME-1] มาตามนัด'); // nor is มี (มีนา)
    expect(stripPii('คุณ สมศรี')).toBe('คุณ[NAME-1]');
  });
  test('a name that begins like a particle (คะ → คะนอง) is still masked whole', () => {
    expect(stripPii('คุณคะนอง มาตามนัด')).toBe('คุณ[NAME-1] มาตามนัด');
    expect(stripPii('คุณหมอคะนอง')).toBe('คุณหมอ[NAME-1]');
  });
  test('role / kin word + name: the role survives, the name is masked', () => {
    expect(stripPii('คุณหมอสมชาย ตรวจคนไข้')).toBe('คุณหมอ[NAME-1] ตรวจคนไข้');
    expect(stripPii('คุณแม่สมศรี')).toBe('คุณแม่[NAME-1]');
    expect(stripPii('คุณลุงสมชาย')).toBe('คุณลุง[NAME-1]');
  });
  test('role / kin word + function word + name: masked from the role on (C2 of the PR #114 review)', () => {
    expect(stripPii('คุณแม่ของสมศรีโทรมาสอบถามอาการ')).toBe('คุณแม่[NAME-1]');
    expect(stripPii('คุณยายของมาลีมาเยี่ยม')).toBe('คุณยาย[NAME-1]');
    expect(stripPii('คุณพ่อของวิไลพามาโรงพยาบาล')).toBe('คุณพ่อ[NAME-1]');
    expect(stripPii('คุณหมอให้ยาสมศรีแล้ว')).toBe('คุณหมอ[NAME-1]');
  });
  test('a name that BEGINS with a list word is masked whole (C1 of the PR #114 review)', () => {
    for (const n of ['ของขวัญ', 'คิดถึง', 'กำลังใจ', 'ภาพร', 'ภาพิมล', 'ภาพพิมพ์']) {
      expect(stripPii(`คุณ${n} มาตามนัด`)).toBe('คุณ[NAME-1] มาตามนัด');
    }
    expect(stripPii('คุณของขวัญ อายุ 45 ปี มาด้วยไข้')).toBe('คุณ[NAME-1] [AGE-1] มาด้วยไข้');
    expect(stripPii('ภรรยาของคุณของขวัญโทรมา')).toBe('ภรรยาของคุณ[NAME-1]');
  });
  test('a gazetteer name glued after ของ / กับ / ให้ is masked even with no title (pre-existing leak)', () => {
    expect(stripPii('แม่ของสมศรีโทรมา')).toBe('แม่ของ[NAME-1]โทรมา');
    expect(stripPii('ไปกับวีระ')).toBe('ไปกับ[NAME-1]');
  });
  test('a real คุณ + name glued after a polite phrase is still masked', () => {
    expect(stripPii('ขอบคุณครับคุณสมศรี')).toBe('ขอบคุณครับคุณ[NAME-1]');
    expect(stripPii('ขอบคุณค่ะคุณหมอสมชาย')).toBe('ขอบคุณค่ะคุณหมอ[NAME-1]');
    scrubbed('คุณภาพชีวิตของคุณสมศรีดีขึ้น', ['สมศรี']);
    scrubbed('คุณคิดว่านายวีระเป็นอะไร', ['วีระ']);
  });
  test('an unknown run after a particle fails CLOSED (masked, as before)', () => {
    expect(stripPii('ขอบคุณครับสมชาย')).toBe('ขอบคุณ[NAME-1]');
    expect(stripPii('ขอบคุณ สมศรี')).toBe('ขอบคุณ[NAME-1]');
  });
  test('คุณสมบัติ stays masked — สมบัติ is also a given name, so the ambiguity resolves to masking', () => {
    expect(stripPii('คุณสมบัติ มาตามนัด')).toBe('คุณ[NAME-1] มาตามนัด');
  });
});

describe('ชื่อ — เชื่อ ("believe") and thing-labels are not a person\'s name', () => {
  test.each([
    'ผมเชื่อว่าเป็น ACS',
    'ผู้ป่วยเชื่อว่าตัวเองเป็นมะเร็ง',
    'ช่วงความเชื่อมั่น 95% ของค่าเฉลี่ย',
    'ความน่าเชื่อถือของการตรวจ',
    'ชื่อยาที่ใช้คือ amlodipine',
    'ชื่อยา amlodipine 5 mg',
    'ชื่อโรคนี้คือ เบาหวาน',
    'ชื่อโรค เบาหวาน',
    'ชื่อสามัญ paracetamol',
    'ชื่อการค้า Tylenol',
    'ชื่อยาสามัญ คือ metformin',
    'ชื่อเชื้อ E. coli',
  ])('survives: %s', survives);

  test('a labelled person\'s name is still masked', () => {
    expect(stripPii('ผู้ป่วยชื่อ สมชาย ใจดี มาด้วยไข้')).toBe('ผู้ป่วยชื่อ [NAME-1] มาด้วยไข้');
    expect(stripPii('ชื่อ มานะ')).toBe('ชื่อ [NAME-1]');
    expect(stripPii('ผู้ป่วยชื่อสมชาย มาด้วยไข้')).toBe('ผู้ป่วยชื่อ [NAME-1] มาด้วยไข้');
    expect(stripPii('ชื่อ สมชาย นามสกุล ใจดี')).toBe('ชื่อ [NAME-1]');
  });
  test('a name that merely begins with a label word (ยา → ยาใจ) is still masked', () => {
    expect(stripPii('ผู้ป่วยชื่อยาใจ มาตามนัด')).toBe('ผู้ป่วยชื่อ [NAME-1] มาตามนัด');
  });
  test('a real label right after a thing-label is still masked', () => {
    expect(stripPii('ชื่อยาที่ใช้คือ ชื่อ มานะ')).toBe('ชื่อยาที่ใช้คือ ชื่อ [NAME-1]');
    expect(stripPii('ชื่อยา ชื่อสมชาย')).toBe('ชื่อยา ชื่อ [NAME-1]');
    scrubbed('ชื่อยาที่ผู้ป่วยชื่อสมชายได้รับ', ['สมชาย']);
  });
});

describe('LINE — the English word "line" is clinical vocabulary', () => {
  test.each([
    'first-line therapy is metformin',
    'First-line treatment: lifestyle',
    'second-line agents include SGLT2i',
    'joint line tenderness on the medial side',
    'tenderness along the joint line',
    'IV line inserted',
    'line of treatment',
    'the line was flushed with 10ml NSS',
    'A-line placed, baseline labs sent',
    'line identified as the source',
    'linear trend in troponin',
  ])('survives: %s', survives);

  test('LINE ids are still masked: labelled, @handle, all-caps app name, or id-shaped', () => {
    expect(stripPii('line: abc123')).toBe('[LINE-1]');
    expect(stripPii('LINE ID: doctor.somchai')).toBe('[LINE-1]');
    expect(stripPii('Line ID somchai')).toBe('[LINE-1]');
    expect(stripPii('LINE @somchai')).toBe('[LINE-1]');
    expect(stripPii('LINE somchai')).toBe('[LINE-1]');
    expect(stripPii('ไลน์ไอดี somchai99')).toBe('[LINE-1]');
    expect(stripPii('ไลน์ somchai.j')).toBe('[LINE-1]');
    expect(stripPii('add line somchai99')).toBe('add [LINE-1]');
    expect(stripPii('line doctor.somchai')).toBe('[LINE-1]');
    expect(stripPii('line abc_def')).toBe('[LINE-1]');
  });
});

describe('WARD — "toward" and "ward round" are not a ward identifier', () => {
  test.each([
    'deviated toward the left',
    'trachea shifted towards the right',
    'during the ward round',
    'ward rounds at 8am',
    'Ward Round notes',
    'WARD ROUND',
    'the ward is full',
    'ward-based care',
  ])('survives: %s', survives);

  test('ward / room identifiers are still masked', () => {
    expect(stripPii('ward 5A bed 12')).toBe('[WARD-1] bed 12');
    expect(stripPii('transferred to ward 4B')).toBe('transferred to [WARD-1]');
    expect(stripPii('Ward 7')).toBe('[WARD-1]');
    expect(stripPii('ward ICU')).toBe('[WARD-1]');
    expect(stripPii('ward A')).toBe('[WARD-1]');
    expect(stripPii('ward b')).toBe('[WARD-1]');          // a single letter is an id, not prose
    expect(stripPii('ward Sirindhorn')).toBe('[WARD-1]'); // a capitalised ward name
    expect(stripPii('หอผู้ป่วย 4')).toBe('[WARD-1]');
    expect(stripPii('ห้อง 5')).toBe('[WARD-1]');
  });
});

describe('ADDR — ต่างจังหวัด, รพ.สต., รพ.จังหวัด are not an address', () => {
  test.each([
    'มาจากต่างจังหวัด มีไข้ 3 วัน',
    'มาจากต่างจังหวัด',
    'ไปทำงานต่างจังหวัด เพื่อหาเงิน',
    'บ้านอยู่ต่างอำเภอ',
    'ส่งต่อ รพ.สต. เพื่อติดตามอาการ',
    'ส่งต่อ รพ.สต.',
    'ส่งต่อ รพ.จังหวัด เพื่อทำ CT',
    'รพ.จังหวัด',
    'โรงพยาบาลจังหวัด',
    'ส่งต่อจังหวัดใกล้เคียง',
    'ทุกจังหวัด',
  ])('survives: %s', survives);

  test('a named place is still masked', () => {
    expect(stripPii('บ้านเลขที่ 99/1 หมู่ 5 ตำบลบางรัก อำเภอเมือง จังหวัดเชียงใหม่'))
      .toBe('[ADDR-1] [ADDR-2] [ADDR-3] [ADDR-4] [ADDR-5]');
    expect(stripPii('ส่งตัวไป รพ.จังหวัดเชียงใหม่')).toBe('ส่งตัวไป รพ.[ADDR-1]');
    expect(stripPii('อยู่ในจังหวัดเชียงใหม่')).toBe('อยู่ใน[ADDR-1]');
    expect(stripPii('อยู่ ต.สุเทพ')).toBe('อยู่ [ADDR-1]');
    expect(stripPii('จังหวัด เชียงใหม่')).toBe('[ADDR-1]');
  });
  test('รพ.สต. keeps its label and masks the village / tambon it is named after', () => {
    expect(stripPii('รพ.สต.บ้านหนองบัว')).toBe('รพ.สต.[ADDR-1]');
    expect(stripPii('ส่งต่อ รพ.สต. บ้านหนองบัว')).toBe('ส่งต่อ รพ.สต. [ADDR-1]');
  });
  test('ตำบล / อำเภอ keep NO lead shield — place names like ในเมือง / จะนะ begin with a lead word', () => {
    scrubbed('ตำบลในเมือง', ['ในเมือง']);
    scrubbed('อำเภอจะนะ', ['จะนะ']);
  });

  // The จังหวัด lead shield must never swallow a real province: check all 77.
  const PROVINCES = [
    'กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา',
    'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก',
    'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี', 'นราธิวาส', 'น่าน',
    'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี', 'พระนครศรีอยุธยา',
    'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต',
    'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง', 'ราชบุรี',
    'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ',
    'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี',
    'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี',
    'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี',
  ];
  test('the list really is all 77 provinces', () => expect(new Set(PROVINCES).size).toBe(77));
  test.each(PROVINCES)('province %s is masked after จังหวัด / จ. / รพ.จังหวัด, glued or spaced', (p) => {
    for (const form of [`จังหวัด${p}`, `จังหวัด ${p}`, `จ.${p}`, `จ. ${p}`, `ส่งต่อ รพ.จังหวัด${p}`,
      // a quantifier does not hide a place that follows (review of PR #114)
      `ต่างจังหวัด${p}`, `ทุกจังหวัด ${p}`, `หลายจังหวัด${p}`, `แต่ละจังหวัด ${p}`]) {
      expect(stripPii(form)).not.toContain(p);
    }
  });
});

// ---------------------------------------------------------------------------
// AGE — deliberately UNCHANGED. Whether CREC082 requires masking age is an open
// IRB question for the PI, so this change must not move it either way. These
// outputs are byte-identical to master before the false-positive work; if one
// changes, that is a protocol decision, not a refactor.
// ---------------------------------------------------------------------------
describe('AGE masking is pinned (open IRB question — do not change here)', () => {
  test.each([
    ['อายุ 45 ปี', '[AGE-1]'],
    ['อายุ45ปี', '[AGE-1]'],
    ['อายุ 30', '[AGE-1]'],
    ['30 ปี', '[AGE-1]'],
    ['ผู้ป่วยหญิง 72 ปี', 'ผู้ป่วยหญิง [AGE-1]'],
    ['ผู้ป่วยชายอายุ 67 ปี มาด้วยเจ็บหน้าอก', 'ผู้ป่วยชาย[AGE-1] มาด้วยเจ็บหน้าอก'],
    ['เด็กอายุ 8 ปี 3 เดือน', 'เด็ก[AGE-1] 3 เดือน'],
    ['a 45-year-old man', 'a [AGE-1] man'],
    ['45 years old', '[AGE-1]'],
    ['A 72-yr-old female, age: 72, 30yo son', 'A [AGE-1] female, [AGE-3], [AGE-2] son'],
    ['62 y/o', '[AGE-1]'],
    ['age 55', '[AGE-1]'],
    ['aged 30', '[AGE-1]'],
    ['symptoms for 5 years', 'symptoms for 5 years'],
    ['came 3 years ago', 'came 3 years ago'],
  ])('%s → %s', (input, expected) => {
    expect(stripPii(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// KNOWN GAP (docs/MIDDLEWARE-KNOWN-GAPS.md): a bare English personal name with
// no title, no label and no intake hint is NOT masked — there is no English
// given-name gazetteer. The intake-hint pass is the mitigation, proven below.
// ---------------------------------------------------------------------------
describe('bare English personal name (documented gap)', () => {
  test.todo('a bare English name with no title / label / intake hint is masked (KNOWN GAP — not built)');
  test('the intake-hint pass closes it when the name was recorded in patient_ref', () => {
    const out = stripPii('John Smith presented with chest pain', undefined, ['John', 'Smith']);
    expect(out).not.toMatch(/John|Smith/);
    expect(out).toContain('presented with chest pain');
  });
});
