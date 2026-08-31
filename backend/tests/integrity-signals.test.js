// Deterministic integrity signals — gaming/delegation detection.
//
// Thresholds here are CALIBRATED against 398 real messages across 33 prod CLEs (2026-08-26), not
// guessed. The tests that matter most are the negative ones: a signal that flags honest physicians
// is worse than no signal, because it routes real clinicians to an accusation queue.
const { detectIntegritySignals, trigrams, jaccard, genreProfile, SIGNALS } = require('../src/services/integrity');

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

// ---- genre counters: telling a pasted CASE NOTE from pasted REASONING -------------------------
// F3 cannot distinguish these on timing, and only one of them is misconduct — PIS-7 scores
// reasoning, so pasting data is fine and pasting an answer is not. These counters go into F3's
// evidence so the human reading the flag can see which one it is. Nothing branches on them.
describe('genre counters separate a case note from generated prose', () => {
  const CASE_NOTE = 'ผู้ป่วยชายอายุ 62 ปี DM type 2, Cr 2.1 mg/dL, eGFR 34, K 5.2 mEq/L, '
    + 'BP 158/94 mmHg, HR 92 bpm, Hb 9.8 g/dL, HbA1c 8.4%, EF 35%';
  const AI_PROSE = 'ประการแรก ควรพิจารณาว่าภาวะเหนื่อยนี้อาจเกิดจากหลายสาเหตุ **หัวใจล้มเหลว** พบบ่อยที่สุด\n'
    + '- ภาวะน้ำเกิน\n- ภาวะซีด\nอย่างไรก็ตาม จำเป็นต้องคำนึงถึงการทำงานของไต โดยสรุป ควรประเมินทั้งสองระบบ';
  const TYPED = 'คิดว่าน่าจะเป็น HF แต่ไม่แน่ใจว่าจะปรับ metformin ยังไงดีครับ ไตแย่ลง';

  test('a case note reads as clinical data and carries no discourse structure', () => {
    const g = genreProfile(CASE_NOTE);
    expect(g.clinical_density).toBeGreaterThan(5);
    expect(g.discourse_density).toBe(0);
    expect(g.markdown_marks).toBe(0);
  });

  test('generated prose reads as discourse and carries no clinical data', () => {
    const g = genreProfile(AI_PROSE);
    expect(g.discourse_density).toBeGreaterThan(1);
    expect(g.markdown_marks).toBeGreaterThan(0);
    expect(g.clinical_density).toBe(0);
  });

  // The separation must be an ORDERING, not two thresholds that happen to hold on two strings.
  test('the two genres are ordered oppositely on both axes', () => {
    const c = genreProfile(CASE_NOTE), a = genreProfile(AI_PROSE);
    expect(c.clinical_density).toBeGreaterThan(a.clinical_density);
    expect(a.discourse_density).toBeGreaterThan(c.discourse_density);
  });

  // The likeliest false positive: ordinary Thai clinical writing that happens to use ดังนั้น or
  // เนื่องจาก. Those are deliberately NOT in the marker set; if someone adds them, this fails.
  test('ordinary typed Thai is not read as generated prose', () => {
    expect(genreProfile(TYPED).discourse_density).toBe(0);
    expect(genreProfile('เนื่องจากไตแย่ลง ดังนั้นจึงควรลดขนาดยา').discourse_density).toBe(0);
  });

  test('empty and missing text are safe', () => {
    expect(genreProfile('').chars).toBe(0);
    expect(genreProfile(null).clinical_density).toBe(0);
    expect(genreProfile(undefined).markdown_marks).toBe(0);
  });

  // The counters must actually REACH the reader — they are useless sitting in a function.
  test('F3 carries the genre profile in its evidence', () => {
    const flags = detectIntegritySignals([
      turn(0, 'สวัสดีครับ', 10),
      turn(2, AI_PROSE.repeat(3), 900),
    ]);
    const f3 = flags.find(f => f.signal === 'F3_PASTE_BURST');
    expect(f3).toBeDefined();
    expect(f3.evidence.genre).toBeDefined();
    expect(f3.evidence.genre.markdown_marks).toBeGreaterThan(0);
  });
});

// ---- F6: a turn that does not write like the physician's own other turns ----------------------
// Ships DISABLED, so every test here passes it in explicitly. The point of the signal is that the
// comparison is WITHIN-subject: a physician who always writes formally has a formal baseline and
// must never fire.
describe('F6 register discontinuity', () => {
  const ON = { F6_REGISTER_DISCONTINUITY: { ...SIGNALS.F6_REGISTER_DISCONTINUITY, enabled: true } };
  // Terse Thai clinical notes — one physician's habitual register.
  const terse = (n) => `ผู้ป่วยรายนี้ Cr ${n}.1 mg/dL ไตแย่ลง คิดว่าควรลดยา metformin ลงครับ ` +
    'ขอความเห็นเพิ่มเติมด้วยครับ ผมยังไม่แน่ใจเรื่องขนาดยาที่เหมาะสม';
  const baseline = Array.from({ length: 10 }, (_, i) => ({ cle_id: `c${i}`, content: terse(i + 1) }));
  // The same physician suddenly emitting structured, marked-up, English-heavy essay prose.
  const PASTED = ('ประการแรก ควรพิจารณาว่า **chronic kidney disease** progression requires careful review. '
    + '- Assess volume status\n- Review nephrotoxic agents\n1. Metformin accumulation risk\n'
    + 'However, it is important to note that eGFR trends matter more than a single value. '
    + 'In summary, consider dose adjustment. อย่างไรก็ตาม โดยสรุป ควรพิจารณาถึงการทำงานของไต ')
    .repeat(3);

  test('fires when one turn breaks the physician\'s own register', () => {
    const flags = detectIntegritySignals(
      [turn(0, terse(1)), turn(120, PASTED, 900), turn(400, terse(2))], baseline, ON);
    const f6 = flags.find(f => f.signal === 'F6_REGISTER_DISCONTINUITY');
    expect(f6).toBeDefined();
    expect(f6.evidence.shifted_features.length).toBeGreaterThanOrEqual(2);
    expect(f6.severity === 'low' || f6.severity === 'medium').toBe(true);
  });

  // The property that decides whether this is shippable at all.
  test('a physician who ALWAYS writes that way never fires', () => {
    const formalBaseline = Array.from({ length: 10 }, (_, i) => ({ cle_id: `c${i}`, content: PASTED }));
    const flags = detectIntegritySignals([turn(0, PASTED, 900)], formalBaseline, ON);
    expect(flags.find(f => f.signal === 'F6_REGISTER_DISCONTINUITY')).toBeUndefined();
  });

  test('an honest varied session does not fire', () => {
    expect(detectIntegritySignals(HUMAN, baseline, ON)
      .find(f => f.signal === 'F6_REGISTER_DISCONTINUITY')).toBeUndefined();
  });

  test('too small a baseline is no baseline — it stays silent rather than guessing', () => {
    const flags = detectIntegritySignals([turn(0, PASTED, 900)], baseline.slice(0, 3), ON);
    expect(flags.find(f => f.signal === 'F6_REGISTER_DISCONTINUITY')).toBeUndefined();
  });

  test('short turns are skipped — a one-liner has no style to measure', () => {
    const flags = detectIntegritySignals([turn(0, 'ครับ **ok**', 5)], baseline, ON);
    expect(flags.find(f => f.signal === 'F6_REGISTER_DISCONTINUITY')).toBeUndefined();
  });

  test('DISABLED by default — it has not been calibrated against real sessions', () => {
    expect(SIGNALS.F6_REGISTER_DISCONTINUITY.enabled).toBe(false);
    expect(detectIntegritySignals([turn(0, PASTED, 900)], baseline)
      .find(f => f.signal === 'F6_REGISTER_DISCONTINUITY')).toBeUndefined();
  });

  test('never reaches high severity', () => {
    const flags = detectIntegritySignals([turn(0, PASTED, 900)], baseline, ON);
    for (const f of flags.filter(x => x.signal === 'F6_REGISTER_DISCONTINUITY')) {
      expect(f.severity).not.toBe('high');
    }
  });
});
