// Deterministic integrity signals — gaming/delegation detection.
//
// Thresholds here are CALIBRATED against 398 real messages across 33 prod CLEs (2026-08-26), not
// guessed. The tests that matter most are the negative ones: a signal that flags honest physicians
// is worse than no signal, because it routes real clinicians to an accusation queue.
const { detectIntegritySignals, trigrams, jaccard, SIGNALS } = require('../src/services/integrity');

const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + s * 1000).toISOString();
const turn = (s, content, token_count = 40, role = 'physician') => ({ role, content, created_at: at(s), token_count });

// A realistic Thai session: varied content, irregular human rhythm.
const HUMAN = [
  turn(0, 'ผู้ป่วยชายอายุ 58 ปี มาด้วยอาการเจ็บหน้าอกเฉียบพลัน 2 ชั่วโมงก่อนมาโรงพยาบาล'),
  turn(3, 'ประเมินเบื้องต้นอย่างไรดีครับ', 20, 'assistant'),
  turn(64, 'ประวัติเดิมเป็นเบาหวานชนิดที่ 2 และความดันโลหิตสูง กินยาสม่ำเสมอครับ'),
  turn(70, 'ต่อไปควรตรวจอะไร', 20, 'assistant'),
  turn(203, 'ขอ ECG 12 lead และ high-sensitivity troponin ครับ'),
  turn(210, 'ผลออกมาแล้ว', 20, 'assistant'),
  turn(455, 'ถ้า troponin สูงขึ้นและมี ST elevation ต้องเข้า STEMI protocol ทันทีหรือไม่ครับ'),
];

describe('honest sessions produce NO flags — the property that matters most', () => {
  test('a varied Thai session with irregular timing is clean', () => {
    expect(detectIntegritySignals(HUMAN)).toEqual([]);
  });

  test('a physician who reuses one clinical phrase is not flagged for it', () => {
    // A cardiologist asks about troponin every time. That is expertise, not gaming — the signal has
    // to be near-identical whole TURNS, not shared vocabulary.
    const prior = [{ cle_id: 'other-1', content: 'ขอ high-sensitivity troponin และ ECG 12 lead ครับ เพื่อประเมิน ACS' }];
    expect(detectIntegritySignals(HUMAN, prior)).toEqual([]);
  });

  test('short turns are below the floor — "ครับ" repeated is not a duplicate finding', () => {
    const polite = [turn(0, 'ครับ'), turn(40, 'ครับ'), turn(95, 'ครับ')];
    expect(detectIntegritySignals(polite)).toEqual([]);
  });
});

describe('F1 — near-duplicate turns within one session', () => {
  const dup = 'ผู้ป่วยรายนี้มีอาการเจ็บหน้าอกร้าวไปแขนซ้าย ร่วมกับเหงื่อออกมากและคลื่นไส้อาเจียน';

  test('identical long turns are flagged high', () => {
    const flags = detectIntegritySignals([turn(0, dup), turn(70, dup), turn(150, dup)]);
    const f1 = flags.find(f => f.signal === 'F1_NEAR_DUPLICATE');
    expect(f1.severity).toBe('high');
    expect(f1.evidence.similarity).toBe(1);
  });

  test('ONE row per signal, with the occurrence count — not one row per pair', () => {
    // 6 identical turns make 15 pairs. Fifteen rows would make the admin queue unreadable and make
    // "how many CLEs are flagged" uncountable without a DISTINCT.
    const flags = detectIntegritySignals([0, 30, 60, 90, 120, 150].map(s => turn(s, dup)));
    const f1 = flags.filter(f => f.signal === 'F1_NEAR_DUPLICATE');
    expect(f1).toHaveLength(1);
    expect(f1[0].evidence.occurrences).toBe(15);
  });

  test('trigram similarity works on Thai, which has no inter-word spaces', () => {
    // A word-boundary measure degrades to one enormous token on Thai and reports 0 similarity
    // between two near-identical Thai turns.
    const a = trigrams('ผู้ป่วยมีอาการเจ็บหน้าอก');
    const b = trigrams('ผู้ป่วยมีอาการเจ็บหน้าอกมาก');
    expect(jaccard(a, b)).toBeGreaterThan(0.7);
    expect(jaccard(a, trigrams('ไข้สูงร่วมกับไอมีเสมหะ'))).toBeLessThan(0.2);
  });
});

describe('F2 — reuse across the physician\'s own other sessions', () => {
  const reused = 'ผู้ป่วยหญิงอายุ 45 ปี มาด้วยอาการปวดศีรษะรุนแรงเฉียบพลัน worst headache of my life ร่วมกับคอแข็ง';

  test('a turn copied from another CLE is flagged', () => {
    const flags = detectIntegritySignals([turn(0, reused)], [{ cle_id: 'cle-earlier', content: reused }]);
    const f2 = flags.find(f => f.signal === 'F2_CROSS_SESSION_REUSE');
    expect(f2).toBeTruthy();
    expect(f2.evidence.other_cle_id).toBe('cle-earlier');
  });

  test('it never reaches "high" — every observed instance came from the pilot\'s own test sessions', () => {
    const flags = detectIntegritySignals([turn(0, reused)], [{ cle_id: 'x', content: reused }]);
    expect(flags.find(f => f.signal === 'F2_CROSS_SESSION_REUSE').severity).toBe('medium');
  });

  test('one flag per turn, not one per matching prior', () => {
    const priors = ['a', 'b', 'c'].map(id => ({ cle_id: id, content: reused }));
    const f2 = detectIntegritySignals([turn(0, reused)], priors).filter(f => f.signal === 'F2_CROSS_SESSION_REUSE');
    expect(f2).toHaveLength(1);
    expect(f2[0].evidence.occurrences).toBe(1);
  });
});

describe('F3 — paste burst', () => {
  test('a large turn arriving seconds after the previous message is flagged LOW, never higher', () => {
    const flags = detectIntegritySignals([turn(0, 'x'.repeat(500), 50), turn(2, 'y'.repeat(2000), 800)]);
    const f3 = flags.find(f => f.signal === 'F3_PASTE_BURST');
    // Pasting a real de-identified case note is legitimate and looks exactly like this. It is a
    // reason to read the transcript, not a conclusion about the physician.
    expect(f3.severity).toBe('low');
  });

  test('the same large turn after a long pause is not flagged', () => {
    expect(detectIntegritySignals([turn(0, 'x'.repeat(500), 50), turn(600, 'y'.repeat(2000), 800)])).toEqual([]);
  });
});

describe('F4 — composition rate, DEFAULT OFF because it did not survive calibration', () => {
  test('it is off by default', () => {
    expect(SIGNALS.F4_COMPOSITION_RATE.enabled).toBe(false);
    // 2000 chars in 2s = 1000 chars/sec. Measured max on REAL physician turns was 937 chars/sec,
    // and message timestamps are genuine send times, so that is a physician pasting a case note —
    // which F3 already reports. A signal that implies automation must not fire on pasting.
    const flags = detectIntegritySignals([turn(0, 'x'.repeat(10), 5), turn(2, 'y'.repeat(2000), 10)]);
    expect(flags.find(f => f.signal === 'F4_COMPOSITION_RATE')).toBeUndefined();
  });

  test('it still works when explicitly enabled, for re-calibration', () => {
    const flags = detectIntegritySignals(
      [turn(0, 'x'.repeat(10), 5), turn(2, 'y'.repeat(2000), 10)],
      [], { F4_COMPOSITION_RATE: { ...SIGNALS.F4_COMPOSITION_RATE, enabled: true } },
    );
    expect(flags.find(f => f.signal === 'F4_COMPOSITION_RATE')).toBeTruthy();
  });
});

describe('F5 — machine-regular rhythm', () => {
  const dup = (i) => `คำถามที่ ${i} เกี่ยวกับการวินิจฉัยแยกโรคของผู้ป่วยรายนี้ ขอความเห็นเพิ่มเติมด้วยครับ`;

  test('a metronome rhythm over enough turns is flagged', () => {
    const bot = [0, 30, 60, 90, 120, 150, 180, 210].map((s, i) => turn(s, dup(i)));
    expect(detectIntegritySignals(bot).find(f => f.signal === 'F5_LATENCY_UNIFORMITY').severity).toBe('high');
  });

  test('too few turns to judge rhythm does NOT fire — this was a real false positive', () => {
    // At the original min_turns of 5 this fired on a genuine prod CLE that had only 4 gaps. A
    // coefficient of variation over 4 samples is noise. At 7 it fires on 0 of 27 real sessions.
    const short = [0, 30, 60, 90, 120].map((s, i) => turn(s, dup(i)));
    expect(detectIntegritySignals(short).find(f => f.signal === 'F5_LATENCY_UNIFORMITY')).toBeUndefined();
    expect(SIGNALS.F5_LATENCY_UNIFORMITY.min_turns).toBe(7);
  });

  test('an irregular human rhythm over many turns is clean', () => {
    const human = [0, 47, 133, 291, 402, 640, 705, 980].map((s, i) => turn(s, dup(i)));
    expect(detectIntegritySignals(human).find(f => f.signal === 'F5_LATENCY_UNIFORMITY')).toBeUndefined();
  });
});

describe('output shape', () => {
  test('flags are sorted most-severe first, so the queue opens the worst one', () => {
    const dup = 'ผู้ป่วยรายนี้มีอาการเจ็บหน้าอกร้าวไปแขนซ้ายร่วมกับเหงื่อออกมากและคลื่นไส้อาเจียนมาก';
    const flags = detectIntegritySignals([
      turn(0, dup, 50), turn(2, dup, 800), turn(60, dup), turn(120, dup),
    ]);
    const rank = { low: 1, medium: 2, high: 3 };
    for (let i = 1; i < flags.length; i++) {
      expect(rank[flags[i - 1].severity]).toBeGreaterThanOrEqual(rank[flags[i].severity]);
    }
  });

  test('empty input is empty output, not a crash', () => {
    expect(detectIntegritySignals([])).toEqual([]);
    expect(detectIntegritySignals(undefined)).toEqual([]);
    expect(detectIntegritySignals(null, null)).toEqual([]);
  });
});
