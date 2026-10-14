// EVIDENCE-LEVEL MARKER (CCME R5) — the validator and the prompt text it checks.
//
// The line lib/prompts.js EVIDENCE_GUIDANCE asks for and services/post-filter.js extractEvidenceLevel
// accepts are built from ONE table (EVIDENCE_LEVELS). These tests pin that the two agree, what counts
// as a marker (and what does not), the ambiguity rule, the language-guard exclusion, and the cost bound.
// Pure functions: no route, no AI, no network.
const {
  extractEvidenceLevel, findEvidenceMarkers, parseEvidenceLine, EVIDENCE_LINE_MAX_CHARS,
  stripNonProse, isLanguageMismatch, thaiShare, isThaiMessage, hasCitation,
} = require('../src/services/post-filter');
const P = require('../src/lib/prompts');
const { promptLabel, PROMPT_VERSION } = require('../src/lib/versions');

const LINE = {
  high: 'ระดับหลักฐาน: สูง (Evidence: high)',
  moderate: 'ระดับหลักฐาน: ปานกลาง (Evidence: moderate)',
  low: 'ระดับหลักฐาน: ต่ำ (Evidence: low)',
  expert: 'ระดับหลักฐาน: ความเห็นผู้เชี่ยวชาญ (Evidence: expert opinion)',
};
const PROSE = 'Start amoxicillin 1 g three times daily for 5 days (BTS, 2019).';

describe('the prompt asks for exactly the lines the parser accepts', () => {
  test('every level in EVIDENCE_LEVELS appears in both guidance texts as the exact bilingual line', () => {
    expect(P.EVIDENCE_LEVELS.map((l) => l.key)).toEqual(['high', 'moderate', 'low', 'expert']);
    for (const mode of ['natural', 'examiner']) {
      for (const [key, line] of Object.entries(LINE)) {
        expect(P.EVIDENCE_GUIDANCE[mode]).toContain(`\n${line}\n`);
        expect(parseEvidenceLine(line)).toBe(key);
      }
    }
  });

  test('placement differs by mode: natural = the last line; examiner = just before the ❓ line', () => {
    expect(P.EVIDENCE_GUIDANCE.natural).toMatch(/VERY LAST line of the reply/);
    expect(P.EVIDENCE_GUIDANCE.natural).not.toMatch(/❓/);   // natural mode never asks for a ❓
    expect(P.EVIDENCE_GUIDANCE.examiner).toMatch(/immediately BEFORE the closing ❓ question, so the ❓ question is still the VERY LAST line/);
    for (const mode of ['natural', 'examiner']) {
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/self-check this too/);           // joins the existing self-check
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/never inside a table, a code block or a fenced/);
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/never guess high/);              // the honesty rule, extended
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/IN ADDITION to your \(Source, Year\) citation/);
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/GRADE "very low" is also reported as low/);
    }
  });

  test('the shipped prompts are untouched: the guidance lives only in EVIDENCE_GUIDANCE', () => {
    for (const p of [P.RIMPL_SYSTEM_PROMPT_NATURAL, P.RIMPL_SYSTEM_PROMPT_EXAMINER, P.RIMPL_SYSTEM_PROMPT_RESCUE,
      P.ARTIFACT_GUIDANCE, P.RIMPL_SYSTEM_PROMPT_AUDIT_DISCUSS, P.PIS7_EVALUATOR_PROMPT, P.PIS7_LOCAL_ADDENDUM]) {
      expect(p).not.toMatch(/ระดับหลักฐาน|EVIDENCE LEVEL/);
    }
    // The evaluator's version is a hash of the evaluator prompt alone, so this change cannot move it.
    expect(PROMPT_VERSION).toBe('pis7-prompt-59561c29');
  });

  test('with and without the guidance are two different prompt versions, per mode', () => {
    const labels = [
      P.RIMPL_SYSTEM_PROMPT_NATURAL, P.RIMPL_SYSTEM_PROMPT_NATURAL + P.EVIDENCE_GUIDANCE.natural,
      P.RIMPL_SYSTEM_PROMPT_EXAMINER, P.RIMPL_SYSTEM_PROMPT_EXAMINER + P.EVIDENCE_GUIDANCE.examiner,
    ].map((t) => promptLabel('chat', t));
    expect(new Set(labels).size).toBe(4);
  });

  test('the retry prompts: bilingual for a Thai turn, English for an English one, never a "<...>" template', () => {
    expect(P.EVIDENCE_RETRY_PROMPT.suffix.th).toMatch(/ระดับหลักฐาน/);
    expect(P.EVIDENCE_RETRY_PROMPT.suffix.th).toMatch(/\(Also add the single evidence-level line/);
    expect(P.EVIDENCE_RETRY_PROMPT.suffix.en).not.toMatch(/[฀-๿]/);
    for (const lang of ['th', 'en']) {
      const only = P.EVIDENCE_RETRY_PROMPT.only[lang];
      for (const line of Object.values(LINE)) expect(only).toContain(line);
      expect(only).not.toMatch(/<[^>]*\|/);
      expect(only).toMatch(/Keep any :::artifact block exactly as is/);
      expect(only).toMatch(/Keep the same language, clinical content, \(Source, Year\) citations and any ❓ question/);
      expect(only).toMatch(/low or expert opinion/);
    }
    expect(P.EVIDENCE_RETRY_PROMPT.only.th).toMatch(/^กรุณาเขียนคำตอบก่อนหน้านี้ใหม่/);
    expect(P.EVIDENCE_RETRY_PROMPT.only.en).toMatch(/^Please rewrite your previous reply/);
  });
});

describe('parseEvidenceLine: what counts as one marker line', () => {
  test.each([
    [LINE.high, 'high'],
    [LINE.expert, 'expert'],
    ['ระดับหลักฐาน: ต่ำ', 'low'],                                  // Thai label only
    ['Evidence: moderate', 'moderate'],                              // English label only
    ['evidence: HIGH', 'high'],                                      // English is case-insensitive
    ['Evidence: Expert   Opinion', 'expert'],                        // extra spaces inside "expert opinion"
    ['Evidence: low (ระดับหลักฐาน: ต่ำ)', 'low'],                    // English first, Thai in parentheses
    ['   ระดับหลักฐาน: สูง (Evidence: high)   ', 'high'],            // surrounding whitespace
    ['**ระดับหลักฐาน: ปานกลาง (Evidence: moderate)**', 'moderate'],   // bold
    ['**ระดับหลักฐาน:** สูง (**Evidence:** high)', 'high'],          // bold on the labels only
    ['__Evidence: low__', 'low'],
    ['ระดับหลักฐาน：ความเห็นผู้เชี่ยวชาญ', 'expert'],                   // full-width colon, no space
    ['ระดับหลักฐาน: สูง (Evidence: high)\r', 'high'],                // CRLF (the caller strips \r; parse tolerates via trim)
  ])('%j -> %s', (line, key) => expect(parseEvidenceLine(line)).toBe(key));

  test.each([
    'Evidence: very low',                                  // not one of the four levels
    'ระดับหลักฐาน: สูงมาก',
    'ระดับหลักฐาน: สูง.',                                    // trailing punctuation: not the line asked for
    '- ระดับหลักฐาน: สูง (Evidence: high)',                 // bulleted
    '`ระดับหลักฐาน: สูง (Evidence: high)`',                 // inline code
    'Metformin is first-line. ระดับหลักฐาน: สูง (Evidence: high)',   // run into prose
    'Evidence: RCTs show a mortality benefit',
    'The evidence: high quality trials support it',
    '',
    null,
    'ระดับหลักฐาน: สูง (Evidence: high) ' + 'x'.repeat(EVIDENCE_LINE_MAX_CHARS),  // over the length bound
  ])('%j is not a marker', (line) => expect(parseEvidenceLine(line)).toBeNull());

  test('Thai and English disagreeing is a conflict, not a level', () => {
    expect(parseEvidenceLine('ระดับหลักฐาน: สูง (Evidence: low)')).toBe('conflict');
    expect(parseEvidenceLine('Evidence: expert opinion (ระดับหลักฐาน: ปานกลาง)')).toBe('conflict');
  });
});

describe('extractEvidenceLevel: one checkable answer per reply, or null', () => {
  test('natural placement (last line) and examiner placement (just before ❓) both read', () => {
    expect(extractEvidenceLevel(`${PROSE}\n${LINE.moderate}`)).toBe('moderate');
    expect(extractEvidenceLevel(`${PROSE}\n${LINE.high}\n❓ How would renal function change the dose?`)).toBe('high');
    expect(extractEvidenceLevel(`${PROSE}\r\n${LINE.low}\r\n`)).toBe('low');
  });

  test('no marker -> null', () => {
    expect(extractEvidenceLevel(PROSE)).toBeNull();
    expect(extractEvidenceLevel('')).toBeNull();
    expect(extractEvidenceLevel(undefined)).toBeNull();
  });

  test('SEVERAL markers are ambiguous -> null, even when they agree', () => {
    expect(extractEvidenceLevel(`${PROSE}\n${LINE.high}\n${LINE.low}`)).toBeNull();
    expect(extractEvidenceLevel(`${LINE.high}\n${PROSE}\n${LINE.high}`)).toBeNull();
    expect(findEvidenceMarkers(`${LINE.high}\n${PROSE}\n${LINE.high}`)).toEqual([
      { line: 0, level: 'high' }, { line: 2, level: 'high' },
    ]);
  });

  test('one self-contradicting marker -> null', () => {
    expect(extractEvidenceLevel(`${PROSE}\nระดับหลักฐาน: สูง (Evidence: low)`)).toBeNull();
  });

  test('a marker inside a :::artifact block does not count (and does not conflict with one outside)', () => {
    const art = `:::artifact{type="evidence" title="Evidence"}\n| Trial | Result |\n|---|---|\n${LINE.high}\n:::`;
    expect(extractEvidenceLevel(`${PROSE}\n${art}`)).toBeNull();
    expect(extractEvidenceLevel(`${PROSE}\n${art}\n${LINE.low}`)).toBe('low');
    // An unterminated artifact (a truncated reply) runs to the end, as in stripNonProse.
    expect(extractEvidenceLevel(`${PROSE}\n:::artifact{type="evidence" title="x"}\nbody\n${LINE.low}`)).toBeNull();
  });

  test('a marker inside a fenced code block does not count; an unterminated fence runs to the end', () => {
    expect(extractEvidenceLevel(`${PROSE}\n\`\`\`text\n${LINE.high}\n\`\`\``)).toBeNull();
    expect(extractEvidenceLevel(`${PROSE}\n\`\`\`text\n${LINE.high}\n\`\`\`\n${LINE.moderate}`)).toBe('moderate');
    expect(extractEvidenceLevel(`${PROSE}\n\`\`\`\n${LINE.high}`)).toBeNull();
    // ```inline``` on one line is inline code, not a fence opener (CommonMark), so it closes nothing.
    expect(extractEvidenceLevel(`\`\`\`x\`\`\` is code\n${LINE.high}`)).toBe('high');
  });
});

describe('stripNonProse drops the marker line, so the language guard is not skewed by it', () => {
  test('the whole line goes, and only that line', () => {
    const s = stripNonProse(`ให้ยาปฏิชีวนะภายในหนึ่งชั่วโมง\n${LINE.expert}\nต่อไป`);
    expect(s).not.toMatch(/ระดับหลักฐาน|Evidence/);
    expect(s).toMatch(/ให้ยาปฏิชีวนะภายในหนึ่งชั่วโมง/);
    expect(s).toMatch(/ต่อไป/);
    // A prose sentence that merely mentions evidence stays.
    expect(stripNonProse('The evidence: high quality trials support it')).toMatch(/high quality trials/);
  });

  test('the bilingual line cannot HIDE an English reply to a Thai question', () => {
    // Every marker line is itself 54-60% Thai, well over the 0.30 bar. Measured, it would lift a short
    // English reply over the bar and the guard would wave it through; stripped, the reply is judged on
    // its own prose (share 0) and the retry fires.
    for (const line of Object.values(LINE)) expect(thaiShare(line)).toBeGreaterThan(0.5);
    const reply = `Give ceftriaxone plus azithromycin now (IDSA, 2019).\n${LINE.expert}`;
    expect(thaiShare(reply)).toBeGreaterThanOrEqual(0.30);          // what an unstripped measure would see
    expect(isLanguageMismatch(reply, 'th')).toBe(true);              // what the guard does see
  });

  test('a Thai reply keeps its measured share: the line is neither credited nor held against it', () => {
    const thai = 'ให้ ceftriaxone และ azithromycin ในผู้ป่วย CAP ภายในหนึ่งชั่วโมง';
    expect(thaiShare(stripNonProse(`${thai}\n${LINE.expert}`))).toBe(thaiShare(stripNonProse(thai)));
    expect(isLanguageMismatch(`${thai}\n${LINE.low}`, 'th')).toBe(false);
  });

  test('an English reply does not read as more Thai because of the Thai label', () => {
    const reply = `${PROSE}\n${LINE.expert}`;
    expect(thaiShare(stripNonProse(reply))).toBe(0);
    expect(hasCitation(stripNonProse(reply))).toBe(false);   // (citations are stripped as before)
  });

  test('a physician message that is only a marker-shaped line has no prose to judge', () => {
    expect(isThaiMessage(LINE.high)).toBe(false);
  });
});

describe('the marker steps are linear on hostile input (< 50 ms at ~5000 chars)', () => {
  const N = 5000;
  const HOSTILE = {
    'label + spaces': `ระดับหลักฐาน:${' '.repeat(N)}x`,
    'label + spaces + paren': `ระดับหลักฐาน: สูง${' '.repeat(N)}(Evidence:${' '.repeat(N)}`,
    'english label + tabs': `Evidence:${'\t'.repeat(N)}expert`,
    'expert + spaces + opinion-less': `Evidence: expert${' '.repeat(N)}x`,
    'many marker lines': `${LINE.high}\n`.repeat(N / 40),
    'many bold runs': '**'.repeat(N / 2),
    'many short evidence lines': 'Evidence: \n'.repeat(N / 11),
    'many fence toggles': '```\n'.repeat(N / 4),
    'many artifact openers': ':::artifact{a}\n'.repeat(N / 15),
  };
  test.each(Object.entries(HOSTILE))('%s', (_name, text) => {
    const t0 = process.hrtime.bigint();
    extractEvidenceLevel(text);
    findEvidenceMarkers(text);
    stripNonProse(text);
    isLanguageMismatch(text, 'th');
    isThaiMessage(text);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(50);
  });
});
