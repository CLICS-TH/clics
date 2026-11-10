// The booth reply cache's guards (#387, rimpl/src/lib/booth-cache.js): when two de-identified typed answers may share
// a reply. Pure: no model, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { THRESHOLD, cuesOf, cosine, bestReusable, calibrated, guardSha } = require('../src/lib/booth-cache');

const same = (a, b) => expect(cuesOf(a)).toEqual(cuesOf(b));
const differ = (a, b) => expect(cuesOf(a)).not.toEqual(cuesOf(b));

describe('cuesOf: a negation, stop word or number makes a cue; the rest of the text does not', () => {
  test('an answer with none has no cues, and every cue is a 16-hex digest, never text', () => {
    expect(cuesOf('ให้ doxycycline นัดดูอาการพรุ่งนี้')).toEqual([]);
    const cues = cuesOf('ไม่ให้ยา ห้ามกิน อย่าเพิ่งส่ง งดน้ำ หยุดยา เลิกบุหรี่ do not give, never stop 500 mg');
    expect(cues).toHaveLength(10);
    for (const c of cues) expect(c).toMatch(/^[0-9a-f]{16}$/);
  });

  test.each(['ไม่', 'ห้าม', 'อย่า', 'งด', 'หยุด', 'เลิก'])('Thai %s is a cue, even inside a word', (term) => {
    differ(`${term}ให้ยา`, 'ให้ยา');
    expect(cuesOf(`ผู้ป่วย${term}ให้ยา`)).toHaveLength(1);
  });

  test('อย่าง (how, like) is not อย่า (do not)', () => {
    expect(cuesOf('ให้ยาอย่างไร')).toEqual([]);
    expect(cuesOf('อย่างแรกให้ยา')).toEqual([]);
    expect(cuesOf('อย่าให้ยา')).toHaveLength(1);
  });

  test.each(['no', 'not', "don't", 'dont', 'never', 'cannot', 'without', 'avoid', 'stop', 'withhold', 'hold', 'discontinue'])(
    'English %s is a cue, whatever its case', (term) => {
      differ(`${term} aspirin`, 'aspirin');
      same(`${term.toUpperCase()} aspirin`, `${term} aspirin`);
    },
  );

  test("n't is a cue after a letter; any other English term is not, so cannot is one cue and know is none", () => {
    differ("isn't safe", 'is safe');
    expect(cuesOf('cannot give')).toHaveLength(1);
    expect(cuesOf('i know the dose')).toEqual([]);
    expect(cuesOf('anchor the tube')).toEqual([]);
  });

  test('a curly apostrophe is the straight one', () => {
    same('don’t give aspirin', "don't give aspirin");
    same('isn‘t safe', "isn't safe");
  });

  test('a moved negation is another answer, which a count of negations would miss', () => {
    differ('ไม่ให้ยา ให้น้ำเกลือ', 'ให้ยา ไม่ให้น้ำเกลือ');
    differ('no insulin, give bicarbonate', 'give insulin, no bicarbonate');
    differ('ให้ heparin ไม่ให้ aspirin', 'ให้ aspirin ไม่ให้ heparin');
    expect(cuesOf('ไม่ให้ยา ให้น้ำเกลือ')).toHaveLength(cuesOf('ให้ยา ไม่ให้น้ำเกลือ').length);
  });

  test('re-spacing, case and line breaks around a negation are the same answer', () => {
    same('ไม่ ให้ยา', 'ไม่ให้ยา');
    same('Do  NOT give   aspirin', 'do not give aspirin');
    same("don't give aspirin\n\nstart heparin", "don't give aspirin\nstart heparin");
  });

  test('a clause ends at a mark, a line break or a space between Thai letters, not inside a number', () => {
    differ("don't give aspirin, give heparin", "don't give aspirin give heparin");
    differ("don't give aspirin\ngive heparin", "don't give aspirin give heparin");
    same('ไม่ให้ยา ให้น้ำเกลือ', 'ไม่ให้ยา ให้เลือด');
    same('no aspirin. give heparin', 'no aspirin. give enoxaparin');
    differ('no 0.5 mg aspirin', 'no 0.5 mg heparin');
    differ('no 1,000 ml saline', 'no 1,000 ml dextrose');
  });

  test('a number with its unit is a cue: a changed dose or unit is another answer', () => {
    differ('ceftriaxone 500 mg', 'ceftriaxone 5000 mg');
    differ('ceftriaxone 500 mg', 'ceftriaxone 500 g');
    differ('NSS 20 ml/kg', 'NSS 20 ml');
    differ('0.5 mg', '5 mg');
    same('ceftriaxone 500 mg', 'ceftriaxone 500mg');
    same('NSS 20 ml/kg', 'nss 20ml/kg');
    same('platelets 110,000', 'platelets 110000');
  });

  test('Thai digits are the same number as 0-9', () => {
    same('ให้ยา ๕๐๐ mg', 'ให้ยา 500 mg');
    differ('ให้ยา ๕๐ mg', 'ให้ยา 500 mg');
  });

  test('a Thai unit is a unit: hours are not days, milligrams are not grams, millilitres are not litres', () => {
    differ('4 ชม.', '4 วัน');
    differ('ORS 750 ml ใน 4 ชม. + zinc', 'ORS 750 ml ใน 4 วัน + zinc');
    differ('40 มก.', '40 กรัม');
    differ('furosemide 40 มก. IV', 'furosemide 40 กรัม IV');
    differ('NSS 1 ลิตร ใน 1 ชม.แรก', 'NSS 1 มล. ใน 1 ชม.แรก');
  });

  test('a unit is the Latin or Thai letters right after the number, spaces between dropped, to a space or clause mark', () => {
    same('ORS 750 ml ใน 4 ชม. + zinc', 'ORS 750ml ใน 4ชม. + zinc');
    same('ให้ 4 วัน แล้วนัด', 'ให้ 4 วัน, แล้วนัด');
    differ('ให้ 10 มก./กก.', 'ให้ 10 มก.');
    differ('ให้ 10 mgต่อกก.', 'ให้ 10 mg');
  });

  test('a Thai run in a unit keeps its first 8 characters, and a number word inside a long one is still a number', () => {
    same('ให้ 5 นาทีจนปอดแห้ง', 'ให้ 5 นาทีจนปอดแห้งสนิท');
    differ('ให้ 5 นาที', 'ให้ 5 นาทีจนปอดแห้ง');
    differ('ORS ใน 4 ชั่วโมงสองครั้ง', 'ORS ใน 4 ชั่วโมงสามครั้ง');
    differ('ให้ 10 มก./กก./วัน', 'ให้ 10 มก./กก./ครั้ง');
  });

  test.each([
    ['insulin drip 0.1 units/kg/hr', 'insulin drip 0.1 units/kg/min'],
    ['KCl 0.3 mmol/kg/hr', 'KCl 0.3 mmol/kg/day'],
  ])('a Latin or slash-joined unit is read whole, however long: %s is not %s', (a, b) => differ(a, b));

  test('any whitespace, a line break included, may sit between the number and its unit', () => {
    same('ceftriaxone 500\nmg', 'ceftriaxone 500 mg');
    differ('ceftriaxone 500\nmg', 'ceftriaxone 500\ng');
  });

  test.each(['หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า', 'สิบ', 'ยี่สิบ', 'ร้อย', 'พัน', 'ครึ่ง'])(
    'Thai %s is a number', (word) => {
      differ(`ให้ยาวันละ${word}ครั้ง`, 'ให้ยาวันละครั้ง');
      expect(cuesOf(`ให้ยาวันละ${word}ครั้ง`)).toHaveLength(1);
    },
  );

  test('a changed Thai number word is another answer, read with the unit after it', () => {
    differ('สองครั้ง', 'สี่ครั้ง');
    differ('ให้ยาวันละสองครั้ง', 'ให้ยาวันละสามครั้ง');
    differ('สองเม็ด', 'สองครั้ง');
    differ('ครึ่งเม็ด', 'หนึ่งเม็ด');
    differ('ยี่สิบนาที', 'สิบนาที');
    differ('สองร้อยมล.', 'สามร้อยมล.');
    same('ให้สองครั้ง', 'ให้สอง ครั้ง');
  });

  test('a bare leading point is 0., in the number and in a negated clause', () => {
    differ('.5 mg', '5 mg');
    differ('adrenaline .5 mg IM', 'adrenaline 5 mg IM');
    same('adrenaline .5 mg IM', 'adrenaline 0.5 mg IM');
    differ('no .5 mg aspirin', 'no .5 mg heparin');
  });
});

describe('bestReusable: the most similar entry of the same model, with equal cues, at the threshold or above', () => {
  const unit = (i, n = 16) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
  const at = (c) => unit(0).map((x, k) => (k === 0 ? c : k === 1 ? Math.sqrt(1 - c * c) : 0));
  const query = { model: 'm', embedding: unit(0), cues: ['aaaaaaaaaaaaaaaa'] };
  const entry = (id, embedding, over = {}) => ({ id, model: 'm', embedding, cues: ['aaaaaaaaaaaaaaaa'], ...over });

  test('the cosine of the vectors', () => {
    expect(cosine(unit(0), unit(0))).toBeCloseTo(1);
    expect(cosine(unit(0), unit(1))).toBeCloseTo(0);
    expect(cosine(unit(0), at(0.97))).toBeCloseTo(0.97);
    expect(cosine(unit(0), unit(0, 8))).toBe(-1);
  });

  test('reuses at 0.96, not at 0.94', () => {
    expect(THRESHOLD).toBe(0.95);
    expect(bestReusable(query, [entry('e1', at(0.96))])).toBe('e1');
    expect(bestReusable(query, [entry('e1', at(0.94))])).toBeNull();
  });

  test('picks the most similar, and the first of equals (the newest, as the backend sends them)', () => {
    expect(bestReusable(query, [entry('old', at(0.96)), entry('close', at(0.99)), entry('far', at(0.97))])).toBe('close');
    expect(bestReusable(query, [entry('newest', at(0.98)), entry('older', at(0.98))])).toBe('newest');
  });

  test('never an entry of another model, or with other cues, however close', () => {
    expect(bestReusable(query, [entry('e1', unit(0), { model: 'other' })])).toBeNull();
    expect(bestReusable(query, [entry('e1', unit(0), { cues: [] })])).toBeNull();
    expect(bestReusable(query, [entry('e1', unit(0), { cues: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] })])).toBeNull();
  });

  test('cues compare as a set in any order', () => {
    const q = { ...query, cues: ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'] };
    expect(bestReusable(q, [entry('e1', unit(0), { cues: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] })])).toBe('e1');
  });
});

describe('calibrated: reuse needs a record of zero unsafe reuses for this model, threshold and guard source, over pairs of every kind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cache-cal-'));
  const file = path.join(dir, 'record.json');
  const counts = { same: { pairs: 16 }, negated: { pairs: 17 }, unsafe: { pairs: 21 } };
  const good = { unsafe_reuses: 0, model: 'm@1:q8', threshold: THRESHOLD, guard_sha: guardSha(), counts };
  const write = (record) => fs.writeFileSync(file, JSON.stringify(record));
  beforeEach(() => { process.env.BOOTH_CACHE_CALIBRATION_FILE = file; fs.rmSync(file, { force: true }); });
  afterAll(() => { delete process.env.BOOTH_CACHE_CALIBRATION_FILE; });

  test('the matching record calibrates its model only', () => {
    write(good);
    expect(calibrated('m@1:q8')).toBe(true);
    expect(calibrated('m@2:q8')).toBe(false);
  });

  test.each([
    ['no record', null],
    ['an unsafe reuse', { ...good, unsafe_reuses: 1 }],
    ['no count', { ...good, unsafe_reuses: undefined }],
    ['another threshold', { ...good, threshold: 0.9 }],
    ['another guard source', { ...good, guard_sha: '0'.repeat(64) }],
    ['no counts', { ...good, counts: undefined }],
    ['no negated pair', { ...good, counts: { ...counts, negated: { pairs: 0 } } }],
    ['no unsafe count', { ...good, counts: { same: counts.same, negated: counts.negated } }],
    ['a count that is not a whole number', { ...good, counts: { ...counts, same: { pairs: '16' } } }],
  ])('%s: not calibrated', (_label, record) => {
    if (record) write(record);
    expect(calibrated('m@1:q8')).toBe(false);
  });

  test('a record that is not JSON: not calibrated', () => {
    fs.writeFileSync(file, '{ not json');
    expect(calibrated('m@1:q8')).toBe(false);
  });

  test('the shipped default path holds no record: this PR calibrates nothing', () => {
    delete process.env.BOOTH_CACHE_CALIBRATION_FILE;
    expect(calibrated(require('../src/services/embed').MODEL_ID)).toBe(false);
  });
});
