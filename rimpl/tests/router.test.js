// services/router.js — the fast/deep chat router (CCME mapping §2.1). A PURE function: no mocks needed,
// nothing to stub, nothing leaves the process.
//
// Pinned here:
//   * PRE-REGISTRATION: the RULES sha256 — services/router.js plus lib/router-keywords.json — is pinned
//     next to ROUTER_VERSION. Editing either file (a comment included) without bumping the version and
//     adding the new pin fails this suite; and the emitted label carries that sha;
//   * the priority order: rescue > sticky > keyword > default;
//   * every category fires in English AND Thai;
//   * the false-positive guards (word boundaries, the ignore list, the terms deliberately left out);
//   * determinism, and that nothing derived from the message ever comes back out.
const fs = require('fs');
const crypto = require('crypto');
const {
  routeTurn, matchCategory, normalise, ROUTER_VERSION, ROUTER_LABEL, ROUTER_RULES_SHA256, ROUTER_KEYWORDS_SHA256,
  RULES_FILE, KEYWORDS_FILE, TIERS, REASONS, CATEGORY_NAMES,
} = require('../src/services/router');

// ONE entry per released router version. Any edit to services/router.js or lib/router-keywords.json is a
// NEW instrument: bump ROUTER_VERSION in services/router.js, add its shas here, and never edit or reuse
// an old line — a routed arm measured under router-v1 (docs/QUALITY-GATES.md) says nothing about the
// rules of any other version.
//   rules     sha256( LF(router.js) , NUL , LF(router-keywords.json) ) — what the label carries
//   keywords  sha256( LF(router-keywords.json) )
const PINNED = {
  'router-v1': {
    rules: 'e721153fb701ab2ccf4f2e51979cf6cd5cd558c75c661c3ec1ba08e9b1250c61',
    keywords: 'de75bae215df740985fa0d48656c054d6f1ee6a7471c328ec58819f976716e1c',
  },
};
const lf = (t) => t.replace(/\r\n/g, '\n');
const shaOf = (...texts) => {
  const h = crypto.createHash('sha256');
  texts.forEach((t, i) => { if (i) h.update('\0'); h.update(t, 'utf8'); });
  return h.digest('hex');
};

const route = (message, over = {}) => routeTurn({ message, historyLength: 0, socratic: false, rescuing: false, sticky: false, ...over });
const reasonOf = (message) => route(message).reason;

describe('pre-registration: the rules (router.js + keywords) are pinned to the version', () => {
  const rulesText = () => fs.readFileSync(RULES_FILE, 'utf8');
  const keywordsText = () => fs.readFileSync(KEYWORDS_FILE, 'utf8');

  test('the RULES sha256 — router.js and the keyword file — is the one pinned for ROUTER_VERSION', () => {
    const rules = shaOf(lf(rulesText()), lf(keywordsText()));
    const keywords = shaOf(lf(keywordsText()));
    expect({ version: ROUTER_VERSION, rules, keywords }).toEqual({ version: ROUTER_VERSION, ...PINNED[ROUTER_VERSION] });
    // The module hashes exactly the bytes it compiled its rules from.
    expect([ROUTER_RULES_SHA256, ROUTER_KEYWORDS_SHA256]).toEqual([rules, keywords]);
    expect(RULES_FILE).toBe(require.resolve('../src/services/router'));
  });

  test('the label every routed turn carries: router-vN+<first 12 hex of the rules sha>', () => {
    expect(ROUTER_LABEL).toBe(`${ROUTER_VERSION}+${PINNED[ROUTER_VERSION].rules.slice(0, 12)}`);
    expect(ROUTER_LABEL).toMatch(/^router-v\d+\+[0-9a-f]{12}$/);   // the format the backend validates
    expect(routeTurn({ message: 'hello' }).version).toBe(ROUTER_LABEL);
  });

  test('a CRLF checkout does not read as an edit', () => {
    expect(shaOf(lf(rulesText().replace(/\n/g, '\r\n')), lf(keywordsText()))).toBe(ROUTER_RULES_SHA256);
  });

  test('no two versions share rules (a version is never re-used for different rules)', () => {
    const shas = Object.values(PINNED).map((p) => p.rules);
    expect(new Set(shas).size).toBe(shas.length);
    expect(ROUTER_VERSION).toMatch(/^router-v\d+$/);
  });

  test('the file holds the six categories, in priority order, each in both languages', () => {
    const data = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
    expect(data.categories.map((c) => c.name)).toEqual(['dosing', 'interaction', 'pregnancy', 'paediatric', 'differential', 'explicit']);
    expect(CATEGORY_NAMES).toEqual(data.categories.map((c) => c.name));
    for (const c of data.categories) {
      expect(c.en.length).toBeGreaterThan(0);
      expect(c.th.length).toBeGreaterThan(0);
    }
    expect(REASONS).toEqual(['rescue', 'sticky', ...CATEGORY_NAMES, 'default']);
    expect(TIERS).toEqual(['fast', 'deep']);
  });
});

describe('priority order: rescue > sticky > keyword > default', () => {
  const DOSING = 'What dose of amoxicillin for CAP?';
  test('a rescue turn is ALWAYS fast, even sticky and even with a keyword', () => {
    expect(route(DOSING, { rescuing: true, sticky: true })).toEqual({ tier: 'fast', reason: 'rescue', version: ROUTER_LABEL });
    expect(route('First-line for CAP?', { rescuing: true })).toEqual({ tier: 'fast', reason: 'rescue', version: ROUTER_LABEL });
  });
  test('sticky beats the keyword match and the default', () => {
    expect(route(DOSING, { sticky: true })).toEqual({ tier: 'deep', reason: 'sticky', version: ROUTER_LABEL });
    expect(route('Thanks, and what next?', { sticky: true })).toEqual({ tier: 'deep', reason: 'sticky', version: ROUTER_LABEL });
  });
  test('a keyword match is deep with its category as the reason; nothing matched is fast default', () => {
    expect(route(DOSING)).toEqual({ tier: 'deep', reason: 'dosing', version: ROUTER_LABEL });
    expect(route('First-line antibiotic for CAP?')).toEqual({ tier: 'fast', reason: 'default', version: ROUTER_LABEL });
  });
  test('only a literal true counts for rescuing / sticky (a truthy string is not a latch)', () => {
    expect(route('Thanks', { sticky: 'yes' }).reason).toBe('default');
    expect(route(DOSING, { rescuing: 1 }).reason).toBe('dosing');
  });
  test('several categories: the first in file order names the reason', () => {
    expect(reasonOf('A pregnant woman: what dose of nitrofurantoin?')).toBe('dosing');
    expect(reasonOf('ผู้ป่วยเด็กตั้งครรภ์')).toBe('pregnancy');
    expect(reasonOf('In children, explain in depth')).toBe('paediatric');
  });
});

describe('every category fires, in English and in Thai', () => {
  test.each([
    ['dosing', 'What is the loading dose of vancomycin?'],
    ['dosing', 'Dosing of enoxaparin in CKD'],
    ['dosing', 'Give 500mg twice daily?'],
    ['dosing', 'Paracetamol 15 mg/kg every 6 hours, right?'],
    ['dosing', 'Bolus 20 ml/kg then reassess?'],
    ['dosing', 'How do I titrate insulin glargine?'],
    ['dosing', 'ขนาดยา amoxicillin ในผู้ใหญ่เท่าไร'],
    ['dosing', 'ให้ยา 500mgวันละสองครั้งได้ไหม'],
    ['dosing', 'ให้ 500 มก. วันละ 2 ครั้ง'],
    ['dosing', 'กินวันละกี่ครั้งครับ'],
    ['dosing', 'ต้องปรับขนาดตามการทำงานของไตไหม'],
    ['interaction', 'Any drug interaction between clarithromycin and simvastatin?'],
    ['interaction', 'Does warfarin interact with ciprofloxacin?'],
    ['interaction', 'Warfarin interacts with what antibiotics?'],
    ['interaction', 'warfarin กับ amiodarone ยาตีกันไหม'],
    ['interaction', 'มีปฏิกิริยาระหว่างยาหรือไม่'],
    ['interaction', 'ใช้ร่วมกับยาลดความดันได้ไหม'],
    ['pregnancy', 'Is this safe in pregnancy?'],
    ['pregnancy', 'She is pregnant, 12 weeks'],
    ['pregnancy', 'Third trimester hypertension management'],
    ['pregnancy', 'Is it compatible with breastfeeding?'],
    ['pregnancy', 'ผู้ป่วยตั้งครรภ์ 20 สัปดาห์'],
    ['pregnancy', 'คนไข้กำลังให้นมบุตร ใช้ยานี้ได้ไหม'],
    ['pregnancy', 'แพ้ท้องมาก ทำอย่างไรดี'],
    ['paediatric', 'What antibiotic for a child with otitis media?'],
    ['paediatric', 'Neonatal jaundice threshold'],
    ['paediatric', 'Fever in an infant under 3 months'],
    ['paediatric', 'Pediatric asthma step-up'],
    ['paediatric', 'A 6-month-old with bronchiolitis'],
    ['paediatric', 'ในเด็กใช้ยาอะไรดี'],
    ['paediatric', 'เด็ก[AGE-1] ไข้สูงชัก'],
    ['paediatric', 'ทารกแรกเกิดตัวเหลือง'],
    ['paediatric', 'ลูกอายุ 3 ขวบ ไอมาก'],
    ['differential', 'What is the differential diagnosis of chest pain?'],
    ['differential', 'DDx for a pleural effusion?'],
    ['differential', 'How do I rule out PE here?'],
    ['differential', 'วินิจฉัยแยกโรคมีอะไรบ้าง'],
    ['differential', 'คิดถึงโรคอะไรได้บ้างครับ'],
    ['explicit', 'Please explain in depth'],
    ['explicit', 'Can you go through it step by step?'],
    ['explicit', 'Explain the mechanism in detail'],
    ['explicit', 'ช่วยอธิบายละเอียดหน่อย'],
    ['explicit', 'ขออธิบายอย่างละเอียด'],
    ['explicit', 'ขอคำอธิบายเชิงลึก'],
  ])('%s: %s', (category, message) => {
    expect(route(message)).toEqual({ tier: 'deep', reason: category, version: ROUTER_LABEL });
  });
});

describe('false-positive guards', () => {
  test.each([
    // English word boundaries: a term never matches inside a longer word.
    ['kid inside kidney', 'Acute kidney injury after contrast'],
    ['mg inside a word', 'Amgen biosimilar availability'],
    ['teen inside fourteen', 'Fourteen days of symptoms'],
    ['child inside childhood', 'Asthma since childhood, now 45, what inhaler?'],
    // Bare kg is a weight, not a dosing question.
    ['a weight in a vignette', 'A 70 kg man with community-acquired pneumonia'],
    // The ignore list: lab units, Child-Pugh, child-bearing, adult history.
    ['mg/dL is a lab unit', 'Glucose 180 mg/dL, HbA1c 9%: next step?'],
    ['mg/L is a lab unit', 'CRP 120 mg/L, procalcitonin pending'],
    ['Child-Pugh', 'Child-Pugh B cirrhosis with ascites'],
    ['child-bearing age', 'A woman of child-bearing age with acne'],
    ['as a child', 'Had asthma as a child, now wheezy again'],
    ['Thai lab unit', 'น้ำตาล 180 มก./ดล. ควรทำอย่างไร'],
    ['ตั้งแต่เด็ก (since childhood)', 'ผู้ป่วยชายเป็นหอบหืดตั้งแต่เด็ก ตอนนี้หอบมากขึ้น'],
    ['ตอนเป็นเด็ก (as a child)', 'เคยเป็นไข้รูมาติกตอนเป็นเด็ก'],
    ['ตั้งแต่วัยรุ่น (since adolescence)', 'เป็นสิวตั้งแต่วัยรุ่น'],
    // Terms deliberately left out.
    ['ปวดท้อง is abdominal pain, not pregnancy', 'ปวดท้องด้านขวาล่างมา 2 วัน'],
    ['ห้องแยกโรค is an isolation room', 'ต้องเข้าห้องแยกโรคไหม'],
    ['serum lactate is not lactation', 'Serum lactate 4 mmol/L in sepsis'],
    ['a CBC differential is not a DDx', 'CBC with differential is normal'],
    ['comprehensive metabolic panel', 'Comprehensive metabolic panel is normal'],
    ['case narrative "examined in detail" (Thai)', 'ตรวจร่างกายอย่างละเอียดไม่พบความผิดปกติ'],
  ])('%s', (_label, message) => {
    expect(route(message)).toEqual({ tier: 'fast', reason: 'default', version: ROUTER_LABEL });
  });

  test('an ignored span hides only itself: a real occurrence elsewhere in the message still counts', () => {
    expect(reasonOf('Cr 1.2 mg/dL; can I start metformin 500 mg?')).toBe('dosing');
    expect(reasonOf('Child-Pugh B, and now a child of his has the same rash')).toBe('paediatric');
    expect(reasonOf('เป็นหอบหืดตั้งแต่เด็ก ตอนนี้ลูกก็เป็น ในเด็กใช้ยาอะไร')).toBe('paediatric');
  });

  test('boundaries are Latin letters only: digits, units and Thai around an English term still match', () => {
    for (const m of ['500mg', '(mg)', 'mg/kg/day', 'ให้mgละ', 'dose: 1g']) expect(reasonOf(m)).toBe('dosing');
  });
});

describe('normalisation: case, NFC, zero-width characters, whitespace', () => {
  test('case-insensitive', () => {
    expect(reasonOf('WHAT DOSE?')).toBe('dosing');
    expect(reasonOf('Pregnant, 30 weeks')).toBe('pregnancy');
    expect(reasonOf('IN DETAIL please')).toBe('explicit');
  });
  test('NFC: a decomposed character reads as its composed form', () => {
    expect(normalise('Café')).toBe('café');
    expect(normalise('A​B﻿c')).toBe('abc');
  });
  test('zero-width word-break hints inside a Thai term do not hide it', () => {
    expect(reasonOf('อธิบาย​ละเอียด')).toBe('explicit');
    expect(reasonOf('ขนาด​ยา')).toBe('dosing');
  });
  test('whitespace runs and newlines inside an English phrase still match', () => {
    expect(reasonOf('any drug   interaction?')).toBe('interaction');
    expect(reasonOf('step\nby\tstep')).toBe('explicit');
  });
});

describe('pure, deterministic, and blind to everything but the message', () => {
  test('the same input gives the same answer, every time; the input is not mutated', () => {
    const input = Object.freeze({ message: 'What dose in pregnancy?', historyLength: 3, socratic: true, rescuing: false, sticky: false });
    const first = routeTurn(input);
    for (let i = 0; i < 50; i++) expect(routeTurn(input)).toEqual(first);
  });

  test('router-v1 ignores historyLength and socratic (inputs for later versions)', () => {
    for (const message of ['What dose?', 'Thanks']) {
      const base = route(message);
      for (const historyLength of [0, 1, 40]) for (const socratic of [true, false]) {
        expect(route(message, { historyLength, socratic })).toEqual(base);
      }
    }
  });

  test('empty, whitespace or non-string messages are fast default, never a throw', () => {
    for (const message of ['', '   ', undefined, null, 42, {}]) expect(route(message).reason).toBe('default');
    expect(routeTurn()).toEqual({ tier: 'fast', reason: 'default', version: ROUTER_LABEL });
  });

  test('the output carries nothing from the message: three keys, each from a fixed set', () => {
    const message = 'Patient [NAME-1] HN [HN-1], pregnant, asks about the dose of ยาตีกัน in detail';
    const out = route(message);
    expect(Object.keys(out).sort()).toEqual(['reason', 'tier', 'version']);
    expect(TIERS).toContain(out.tier);
    expect(REASONS).toContain(out.reason);
    expect(out.version).toBe(ROUTER_LABEL);
    for (const word of message.split(/\s+/)) {
      if (word.length > 4) expect(JSON.stringify(out)).not.toContain(word);
    }
  });

  test('a masked identifier cannot trigger a keyword: the de-identified text is what is routed', () => {
    // Raw, an e-mail address that happens to contain a keyword would route deep; the PII filter
    // masks it to [EMAIL-1] before chat.js ever calls the router.
    expect(reasonOf('Please e-mail dose@example.com about the plan')).toBe('dosing');
    expect(reasonOf('Please e-mail [EMAIL-1] about the plan')).toBe('default');
  });

  test('matchCategory: the category or null', () => {
    expect(matchCategory('ddx?')).toBe('differential');
    expect(matchCategory('hello')).toBeNull();
  });
});

describe('a malformed keyword file fails LOUDLY at load, never as a term that silently never matches', () => {
  const loadWith = (data) => {
    const real = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => (p === KEYWORDS_FILE ? JSON.stringify(data) : real(p, ...rest)));
    try {
      let mod;
      jest.isolateModules(() => { mod = require('../src/services/router'); });
      return mod;
    } finally { spy.mockRestore(); }
  };
  const ok = { ignore: { en: [], th: [] }, categories: [{ name: 'dosing', en: ['dose*'], th: ['ขนาดยา'] }] };

  test('a well-formed file loads (and the sha is of the bytes read)', () => {
    const mod = loadWith(ok);
    expect(mod.routeTurn({ message: 'dose?' }).reason).toBe('dosing');
    expect(mod.ROUTER_KEYWORDS_SHA256).toBe(crypto.createHash('sha256').update(JSON.stringify(ok)).digest('hex'));
  });
  test.each([
    ['a Thai term in the en list', { ...ok, categories: [{ name: 'dosing', en: ['ขนาด'], th: [] }] }, /invalid English term/],
    ['a mid-word wildcard', { ...ok, categories: [{ name: 'dosing', en: ['do*se'], th: [] }] }, /invalid English term/],
    ['a Latin term in the th list', { ...ok, categories: [{ name: 'dosing', en: [], th: ['dose'] }] }, /invalid Thai term/],
    ['a wildcard in a Thai term', { ...ok, categories: [{ name: 'dosing', en: [], th: ['ขนาด*'] }] }, /invalid Thai term/],
    ['a nameless category', { ...ok, categories: [{ en: ['dose'], th: [] }] }, /has no name/],
    ['a duplicate category', { ...ok, categories: [{ name: 'a', en: ['x'], th: [] }, { name: 'a', en: ['y'], th: [] }] }, /duplicate category/],
  ])('%s', (_label, data, err) => {
    expect(() => loadWith(data)).toThrow(err);
  });
});
