// EVIDENCE-LEVEL MARKER (CCME R5) — the validator, the splice, and the prompt text they check.
//
// The line lib/prompts.js EVIDENCE_GUIDANCE asks for and services/post-filter.js extractEvidenceLevel
// accepts are built from ONE table (EVIDENCE_LEVELS). These tests pin that the two agree, what counts
// as a marker (and what does not), the ambiguity rule, the splice, the language-guard exclusion, and
// the cost bound. Pure functions: no route, no AI, no network.
const {
  extractEvidenceLevel, findEvidenceMarkers, parseEvidenceLine, spliceEvidenceLine, EVIDENCE_LINE_MAX_CHARS,
  isEvidenceStatementLine, isRemovableEvidenceStatement, findEvidenceStatements, evidenceMarkerPlaced, placeEvidenceLine,
  stripNonProse, isLanguageMismatch, thaiShare, isThaiMessage, hasCitation, extractSocraticQuestion,
} = require('../src/services/post-filter');
const P = require('../src/lib/prompts');
const { promptLabel, PROMPT_VERSION } = require('../src/lib/versions');
const { EVIDENCE_LINE_MAX_TOKENS } = require('../src/lib/turn-limits');

const LINE = {
  high: 'ระดับหลักฐานของข้อแนะนำหลัก: สูง (Evidence for the main recommendation: high)',
  moderate: 'ระดับหลักฐานของข้อแนะนำหลัก: ปานกลาง (Evidence for the main recommendation: moderate)',
  low: 'ระดับหลักฐานของข้อแนะนำหลัก: ต่ำ (Evidence for the main recommendation: low)',
  expert: 'ระดับหลักฐานของข้อแนะนำหลัก: ความเห็นผู้เชี่ยวชาญ (Evidence for the main recommendation: expert opinion)',
  not_graded: 'ระดับหลักฐานของข้อแนะนำหลัก: ไม่ได้ประเมิน (Evidence for the main recommendation: not graded)',
};
const PROSE = 'Start amoxicillin 1 g three times daily for 5 days (BTS, 2019).';
const Q = '❓ How would a penicillin allergy change your choice?';

describe('the prompt asks for exactly the lines the parser accepts', () => {
  test('the five levels, in order, with stable keys', () => {
    expect(P.EVIDENCE_LEVELS.map((l) => l.key)).toEqual(['high', 'moderate', 'low', 'expert', 'not_graded']);
    for (const [key, line] of Object.entries(LINE)) expect(P.evidenceLineFor(key)).toBe(line);
    expect(P.evidenceLineFor('very_low')).toBeNull();
  });

  test('every level appears in both guidance texts as the exact bilingual line, and parses back', () => {
    for (const mode of ['natural', 'examiner']) {
      for (const [key, line] of Object.entries(LINE)) {
        expect(P.EVIDENCE_GUIDANCE[mode]).toContain(`\n${line}\n`);
        expect(parseEvidenceLine(line)).toBe(key);
      }
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/Copy one of these five lines/);
    }
  });

  test('placement differs by mode: natural = the last line; examiner = just before the ❓ line', () => {
    expect(P.EVIDENCE_GUIDANCE.natural).toMatch(/VERY LAST line of the reply/);
    expect(P.EVIDENCE_GUIDANCE.natural).not.toMatch(/❓/);   // natural mode never asks for a ❓
    expect(P.EVIDENCE_GUIDANCE.examiner).toMatch(/immediately BEFORE the closing ❓ question, so the ❓ question is still the VERY LAST line/);
    for (const mode of ['natural', 'examiner']) {
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/self-check this too/);           // joins the existing self-check
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/never inside a table, a code block or a fenced/);
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/IN ADDITION to your \(Source, Year\) citation/);
      expect(P.EVIDENCE_GUIDANCE[mode]).toMatch(/GRADE "very low" is also reported as low/);
    }
  });

  test('"How to choose" is generated from EVIDENCE_LEVELS: one bullet per level, in table order', () => {
    for (const mode of ['natural', 'examiner']) {
      const bullets = P.EVIDENCE_GUIDANCE[mode].split('\n').filter((l) => l.startsWith('- ') && / \/ .* — /.test(l));
      expect(bullets).toEqual(P.EVIDENCE_LEVELS.map((l) => `- ${l.th} / ${l.en} — ${l.guide}`));
    }
    // Every level name, Thai and English, appears in the guidance and in both line-only prompts.
    for (const l of P.EVIDENCE_LEVELS) {
      for (const text of [P.EVIDENCE_GUIDANCE.natural, P.EVIDENCE_GUIDANCE.examiner, P.EVIDENCE_RETRY_PROMPT.only.th, P.EVIDENCE_RETRY_PROMPT.only.en]) {
        expect(text).toContain(l.th);
        expect(text).toContain(l.en);
      }
    }
  });

  test('placement asks for a blank line before the evidence line (markdown paragraph break)', () => {
    expect(P.EVIDENCE_GUIDANCE.natural).toMatch(/on its own line, after a blank line, as the VERY LAST line/);
    expect(P.EVIDENCE_GUIDANCE.examiner).toMatch(/on its own line, after a blank line, immediately BEFORE the closing ❓/);
  });

  test('the honesty rule: unsure -> not graded; never high, never expert opinion as a stand-in for unknown', () => {
    const g = P.EVIDENCE_GUIDANCE.natural;
    expect(g).toMatch(/if you are not sure how strong the evidence is, write ไม่ได้ประเมิน \(not graded\) — never guess high, and never use ความเห็นผู้เชี่ยวชาญ \(expert opinion\) as a stand-in for "I don't know"/);
    expect(g).toMatch(/expert opinion — the recommendation rests only on guideline consensus, expert opinion or established practice/);
    expect(g).toMatch(/not graded — you cannot grade the evidence behind the main recommendation, or the reply makes no recommendation or clinical claim at all/);
    expect(g).not.toMatch(/write ต่ำ \(low\) or ความเห็นผู้เชี่ยวชาญ/);   // the old fallback is gone
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

  test('the retry prompts: the suffix asks for the line; the marker-only prompt asks for the LINE ALONE, all five offered', () => {
    expect(P.EVIDENCE_RETRY_PROMPT.suffix.th).toMatch(/ระดับหลักฐาน/);
    expect(P.EVIDENCE_RETRY_PROMPT.suffix.th).toMatch(/\(Also add the single evidence-level line/);
    expect(P.EVIDENCE_RETRY_PROMPT.suffix.en).not.toMatch(/[฀-๿]/);
    for (const lang of ['th', 'en']) {
      const only = P.EVIDENCE_RETRY_PROMPT.only[lang];
      for (const line of Object.values(LINE)) expect(only).toContain(line);
      expect(only).not.toMatch(/<[^>]*\|/);                                   // no "<a|b>" template
      expect(only).toMatch(/single evidence-level line ONLY, and no other text/);
      expect(only).toMatch(/use not graded: never guess high, and never use expert opinion as a stand-in/);
      expect(only).not.toMatch(/rewrite|:::artifact/i);                         // a line, not a rewrite
    }
    expect(P.EVIDENCE_RETRY_PROMPT.only.th).toMatch(/^สำหรับคำตอบก่อนหน้านี้ ให้ตอบกลับด้วยบรรทัดระดับหลักฐานเพียงบรรทัดเดียว/);
    expect(P.EVIDENCE_RETRY_PROMPT.only.th).toMatch(/ให้ใช้ ไม่ได้ประเมิน ห้ามเดาว่าสูง/);
    expect(P.EVIDENCE_RETRY_PROMPT.only.en).toMatch(/^For your previous reply, answer with the single evidence-level line ONLY/);
  });
});

describe('line length and token budget', () => {
  test('the five lines are 76-104 chars, well under the parser bound', () => {
    const lens = Object.values(LINE).map((l) => l.length);
    expect(Math.min(...lens)).toBe(76);
    expect(Math.max(...lens)).toBe(104);
    expect(Math.max(...lens) * 1.5).toBeLessThan(EVIDENCE_LINE_MAX_CHARS);   // room for decoration
  });

  test('the marker-only call cap covers the longest line at one token per Thai codepoint, twice over', () => {
    const longest = LINE.expert;
    const thai = (longest.match(/[฀-๿]/g) || []).length;
    // Everything that is not Thai, one token per word or punctuation mark: a generous count.
    const other = (longest.replace(/[฀-๿]+/g, ' ').match(/[A-Za-z]+|[^\sA-Za-z]/g) || []).length;
    expect(thai).toBe(47);
    expect(thai + other).toBeLessThan(64);
    expect(EVIDENCE_LINE_MAX_TOKENS).toBeGreaterThanOrEqual(2 * (thai + other));
    expect(EVIDENCE_LINE_MAX_TOKENS).toBeLessThanOrEqual(256);                  // still a LINE, not a reply
  });
});

describe('parseEvidenceLine: what counts as one marker line', () => {
  test.each([
    [LINE.high, 'high'],
    [LINE.expert, 'expert'],
    [LINE.not_graded, 'not_graded'],
    ['ระดับหลักฐานของข้อแนะนำหลัก: ต่ำ', 'low'],                          // full Thai label only
    ['ระดับหลักฐาน: ต่ำ', 'low'],                                          // SHORT Thai label
    ['Evidence for the main recommendation: moderate', 'moderate'],          // full English label only
    ['Evidence: moderate', 'moderate'],                                      // SHORT English label
    ['ระดับหลักฐาน: สูง (Evidence: high)', 'high'],                          // the pre-scope short pair
    ['ระดับหลักฐาน: สูง (high)', 'high'],                                    // bare level in parentheses
    ['Evidence: not graded (ไม่ได้ประเมิน)', 'not_graded'],                  // English first, bare Thai
    ['Evidence: low (ระดับหลักฐานของข้อแนะนำหลัก: ต่ำ)', 'low'],
    ['evidence: HIGH', 'high'],                                              // English is case-insensitive
    ['Evidence: Expert   Opinion', 'expert'],
    ['Evidence: not   graded', 'not_graded'],
    ['   ระดับหลักฐาน: สูง (Evidence: high)   ', 'high'],                    // surrounding whitespace
    [`**${LINE.moderate}**`, 'moderate'],                                    // bold
    ['**ระดับหลักฐานของข้อแนะนำหลัก:** สูง (**Evidence for the main recommendation:** high)', 'high'],
    ['__Evidence: low__', 'low'],
    [`*${LINE.low}*`, 'low'],                                                // ONE italic wrapper
    ['_Evidence: high_', 'high'],
    [`***${LINE.high}***`, 'high'],                                          // bold-italic
    [`> ${LINE.expert}`, 'expert'],                                          // blockquote
    [`> **${LINE.high}**`, 'high'],
    [`${LINE.high}.`, 'high'],                                               // ONE trailing full stop
    [`${LINE.high}。`, 'high'],
    ['ระดับหลักฐาน: สูง.', 'high'],
    [`*${LINE.low}*.`, 'low'],
    [`*${LINE.low}.*`, 'low'],
    ['ระดับหลักฐาน：ความเห็นผู้เชี่ยวชาญ', 'expert'],                          // full-width colon, no space
    ['ระดับหลักฐาน:\u00A0สูง\u00A0(Evidence:\u00A0high)', 'high'],          // NBSP
    ['ระดับ\u200Bหลักฐาน: สูง\u200B (Evidence: high)\uFEFF', 'high'],       // zero-width characters
    [`${LINE.high}\r`, 'high'],
    [`- ${LINE.high}`, 'high'],                                              // ONE leading list marker
    [`* ${LINE.low}`, 'low'],
    [`+ ${LINE.low}`, 'low'],
    [`• ${LINE.moderate}`, 'moderate'],                                 // • bullet
    [`1. ${LINE.expert}`, 'expert'],
    [`2) ${LINE.not_graded}`, 'not_graded'],
    [`- **${LINE.high}**`, 'high'],
    [`> - ${LINE.high}`, 'high'],
  ])('%j -> %s', (line, key) => expect(parseEvidenceLine(line)).toBe(key));

  test.each([
    'Evidence: very low',                                  // not one of the five levels
    'ระดับหลักฐาน: สูงมาก',
    `${LINE.high}..`,                                      // more than ONE trailing full stop
    `- - ${LINE.high}`,                                    // more than ONE list marker
    `  - ${LINE.high}`,                                    // a NESTED list item grades one option, not the reply
    '  - Evidence: high',
    ` - ${LINE.high}`,                                     // an indented list item, however shallow
    `    ${LINE.high}`,                                    // an indented block (continuation or code)
    `\t${LINE.high}`,
    `-${LINE.high}`,                                       // a dash with no space is not a list marker
    `### ${LINE.high}`,                                    // a heading (a near-miss: removed, not read)
    `\u{1F4CA} ${LINE.high}`,                              // a leading emoji (likewise)
    `${LINE.high} (BTS, 2019)`,                            // a trailing citation (likewise)
    'ระดับหลักฐาน: สูง / high',                             // a slash pair (likewise)
    'Evidence level: high',                                // another label (likewise)
    `\`${LINE.high}\``,                                    // inline code
    `Metformin is first-line. ${LINE.high}`,               // run into prose
    `${LINE.high} — see above`,
    'Evidence: RCTs show a mortality benefit',
    'The evidence: high quality trials support it',
    'ระดับหลักฐาน: high',                                  // Thai label with an English level
    '',
    null,
    `${LINE.high} ${'x'.repeat(EVIDENCE_LINE_MAX_CHARS)}`, // over the length bound
  ])('%j is not a marker', (line) => expect(parseEvidenceLine(line)).toBeNull());

  test('Thai and English disagreeing is a conflict, not a level', () => {
    expect(parseEvidenceLine('ระดับหลักฐาน: สูง (Evidence: low)')).toBe('conflict');
    expect(parseEvidenceLine('ระดับหลักฐาน: สูง (low)')).toBe('conflict');
    expect(parseEvidenceLine('Evidence: expert opinion (ระดับหลักฐาน: ไม่ได้ประเมิน)')).toBe('conflict');
  });
});

describe('extractEvidenceLevel: one checkable answer per reply, or null', () => {
  test('natural placement (last line) and examiner placement (just before ❓) both read', () => {
    expect(extractEvidenceLevel(`${PROSE}\n${LINE.moderate}`)).toBe('moderate');
    expect(extractEvidenceLevel(`${PROSE}\n${LINE.high}\n${Q}`)).toBe('high');
    expect(extractEvidenceLevel(`${PROSE}\r\n${LINE.not_graded}\r\n`)).toBe('not_graded');
  });

  test('no marker -> null', () => {
    expect(extractEvidenceLevel(PROSE)).toBeNull();
    expect(extractEvidenceLevel('')).toBeNull();
    expect(extractEvidenceLevel(undefined)).toBeNull();
  });

  test('SEVERAL markers are ambiguous -> null, even when they agree', () => {
    expect(extractEvidenceLevel(`${PROSE}\n${LINE.high}\n${LINE.low}`)).toBeNull();
    expect(extractEvidenceLevel(`${LINE.high}\n${PROSE}\nEvidence: high`)).toBeNull();
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

describe('spliceEvidenceLine: take ONE line from the marker-only answer, keep the first reply', () => {
  const ART = ':::artifact{type="differential" title="DDx"}\n| Dx | Feature |\n|---|---|\n| CAP | fever |\n:::';

  test('natural: appended as the last line after a blank line, as a pure append of the first reply', () => {
    const r = spliceEvidenceLine(PROSE, 'Evidence: moderate', { socratic: false });
    expect(r).toEqual({ text: `${PROSE}\n\n${LINE.moderate}`, level: 'moderate' });
    expect(r.text.startsWith(PROSE)).toBe(true);
    // A first reply that already ends in one or two newlines gets just enough for ONE blank line.
    expect(spliceEvidenceLine(`${PROSE}\n`, LINE.low).text).toBe(`${PROSE}\n\n${LINE.low}`);
    expect(spliceEvidenceLine(`${PROSE}\n\n`, LINE.low).text).toBe(`${PROSE}\n\n${LINE.low}`);
    expect(spliceEvidenceLine('', LINE.low).text).toBe(LINE.low);
  });

  test('natural: the blank line makes the marker its own paragraph after a list or a table too', () => {
    const list = `${PROSE}\n- amoxicillin\n- doxycycline`;
    expect(spliceEvidenceLine(list, LINE.low).text).toBe(`${list}\n\n${LINE.low}`);
    const table = `${PROSE}\n| Dx | p |\n|---|---|\n| CAP | 0.7 |`;
    expect(spliceEvidenceLine(table, LINE.low).text).toBe(`${table}\n\n${LINE.low}`);
  });

  test('examiner: inserted directly above the LAST ❓ line after a blank line, so the ❓ stays last', () => {
    const first = `${PROSE}\n❓ an earlier aside?\nMore text.\n${Q}`;
    const r = spliceEvidenceLine(first, LINE.high, { socratic: true });
    expect(r.text).toBe(`${PROSE}\n❓ an earlier aside?\nMore text.\n\n${LINE.high}\n${Q}`);
    expect(r.text.trim().split('\n').at(-1)).toBe(Q);
    expect(extractSocraticQuestion(r.text)).toBe(Q.slice(2));
    // physician-ui ple-chat.js / guest-chat.js lift the question with /\n❓[^\n]*$/: still one match,
    // and what is left ends in the marker as its own paragraph.
    expect(r.text.match(/\n❓[^\n]*$/)[0]).toBe(`\n${Q}`);
    expect(r.text.replace(/\n❓[^\n]*$/, '').trim().endsWith(`More text.\n\n${LINE.high}`)).toBe(true);
    // A blank line already above the ❓: no second one.
    expect(spliceEvidenceLine(`${PROSE}\n\n${Q}`, LINE.high, { socratic: true }).text)
      .toBe(`${PROSE}\n\n${LINE.high}\n${Q}`);
    // No ❓ at all (cannot happen on an evidence-only examiner turn, but must not throw): appended.
    expect(spliceEvidenceLine(PROSE, LINE.high, { socratic: true }).text).toBe(`${PROSE}\n\n${LINE.high}`);
  });

  test('the CANONICAL line is written, whatever form the model used; the rest of its answer is ignored', () => {
    const r = spliceEvidenceLine(PROSE, 'Sure — here it is:\n**Evidence: expert opinion**\n❓ Anything else?');
    expect(r).toEqual({ text: `${PROSE}\n\n${LINE.expert}`, level: 'expert' });
    expect(spliceEvidenceLine(PROSE, `- ${LINE.low}`).text).toBe(`${PROSE}\n\n${LINE.low}`);   // bulleted answer
  });

  test('the first reply survives byte for byte, artifact and all', () => {
    const first = `${PROSE}\n${ART}\nSee the table.`;
    const r = spliceEvidenceLine(first, 'Evidence: low');
    expect(r.text).toBe(`${first}\n\n${LINE.low}`);
    expect(r.text).toContain(ART);
    expect(hasCitation(r.text)).toBe(true);
  });

  test('no single marker in the answer -> null (the caller keeps the first reply unchanged)', () => {
    expect(spliceEvidenceLine(PROSE, 'I cannot grade that.')).toBeNull();
    expect(spliceEvidenceLine(PROSE, `${LINE.high}\n${LINE.low}`)).toBeNull();
    expect(spliceEvidenceLine(PROSE, 'ระดับหลักฐาน: สูง (low)')).toBeNull();
    expect(spliceEvidenceLine(PROSE, `\`\`\`\n${LINE.high}\n\`\`\``)).toBeNull();
    expect(spliceEvidenceLine(PROSE, 'Evidence level: high')).toBeNull();   // a near-miss is not a level
    expect(spliceEvidenceLine(PROSE, '')).toBeNull();
  });

  test('stray marker lines in the first reply (why the check fired) are replaced by the one line', () => {
    const first = `${PROSE}\n${LINE.high}\nMore.\n${LINE.low}`;
    const r = spliceEvidenceLine(first, 'Evidence: moderate');
    expect(r.text).toBe(`${PROSE}\nMore.\n\n${LINE.moderate}`);
    expect(extractEvidenceLevel(r.text)).toBe('moderate');
    expect(findEvidenceStatements(r.text)).toHaveLength(1);
    const fenced = spliceEvidenceLine(`${PROSE}\n${ART.replace('| CAP | fever |', LINE.high)}`, 'Evidence: low');
    expect(fenced.text).toContain(LINE.high);   // a line inside a fence is content, and stays
    expect(extractEvidenceLevel(fenced.text)).toBe('low');
  });

  test('a splice that would not read back (first reply ends inside an unterminated fence) -> null', () => {
    expect(spliceEvidenceLine(`${PROSE}\n:::artifact{type="x" title="t"}\ntruncated`, 'Evidence: low')).toBeNull();
  });
});

describe('near-miss evidence statements: recognised for REMOVAL, never read as a level', () => {
  // Label + colon + level and NOTHING else (end-anchored): detected, and removable.
  const NEAR_MISS = [
    `### ${LINE.high}`,
    `## Evidence level: moderate`,
    `\u{1F4CA} ${LINE.high}`,                          // emoji prefix
    `\u{1F4CA}\u{FE0F} **Evidence level:** low`,
    'ระดับหลักฐาน: สูง / high',                         // slash pair
    'Evidence level: high',
    'Level of evidence: moderate',
    'Level of evidence (GRADE): low',                  // the pre-colon ALLOWLIST: (GRADE) / (overall)
    'Level of evidence (overall): moderate',
    'Level of evidence: moderate (GRADE)',
    'Level of the evidence: low',
    'Quality of evidence: moderate',
    'Strength of evidence: high',
    'Certainty of evidence: low',
    'Evidence grade: A',
    'Level of evidence: B-R',
    'Evidence quality: moderate',
    '**Evidence level:** high',
    '*Evidence level: high*.',
    '- Evidence level: high',
    '- - Evidence level: high',                        // stacked list markers
    '> ### \u{1F4CA} *Evidence level: high*',           // stacked decoration
    '1. Level of evidence: moderate',
    'Evidence: very low',
    'Evidence: low certainty.',
    'Evidence: moderate-certainty',
    'ระดับหลักฐาน: สูงมาก',
    'ระดับหลักฐาน: high',
    'ระดับหลักฐานของข้อแนะนำนี้: ปานกลาง',               // the Thai ALLOWLIST: the prompt's scope, or โดยรวม
    'ระดับหลักฐานโดยรวม: สูง',
    'คุณภาพหลักฐาน: ปานกลาง',
    'คุณภาพของหลักฐาน: ต่ำ',
    'ความน่าเชื่อถือของหลักฐาน: สูง',
  ];
  // Detected (so they count, and the result is never claimed to hold one statement) but NOT removable:
  // something after the level is content. A splice or a move that would delete one is refused whole.
  const CARRIES_CONTENT = [
    `${LINE.high} (BTS, 2019)`,                        // a citation
    'Evidence: high (BTS, 2019)',
    'Evidence level: high (two RCTs, n=120)',          // a trial size
    'Level of evidence (Smith, 2020): low',
    'ระดับหลักฐาน (Smith, 2020): สูง',
    // A QUALIFIER before the colon: a grade for one population or outcome is clinical content.
    'Level of evidence (adults): high',
    'Level of evidence (children): low',
    'Evidence level (pregnancy): low',
    'Certainty of evidence (mortality): moderate',
    'Certainty of evidence (bleeding): low',
    'Quality of evidence (stroke prevention): high',
    'ระดับหลักฐานในเด็ก: ต่ำ',
    'ระดับหลักฐานในผู้ใหญ่: สูง',
    'ระดับหลักฐานสำหรับผู้ป่วยไตวาย: ต่ำ',
  ];
  const BULLETED = [`- ${LINE.high}`, `* ${LINE.high}`, `• ${LINE.high}`, `1. ${LINE.high}`];
  // Clinical lines that START like an evidence statement. A start-anchored detector deleted these from
  // correct replies; they must never be touched.
  const PROSE_CONTROLS = [
    'Evidence: two RCTs show a mortality benefit (BTS, 2019).',
    'Evidence: high-quality RCTs show a mortality benefit.',   // a level word inside a compound: content
    '**Evidence:** high sensitivity troponin below the limit of detection at arrival rules out MI (ESC, 2023).',
    'Evidence: low molecular weight heparin remains preferred in cancer-associated VTE.',
    'Evidence: high blood pressure accelerates eGFR decline.',
    'Evidence: low back pain usually resolves within six weeks.',
    'Quality of evidence: two small RCTs (n=120), no trials in children.',
    'Level of evidence: 1 RCT and two cohorts',
    'ระดับหลักฐานตาม GRADE มี 4 ระดับ:',
    'คุณภาพของหลักฐาน: RCT ขนาดเล็ก 2 ฉบับ (Smith, 2020)',
    'Evidence: สูงอายุและไตเสื่อมเพิ่มความเสี่ยงเลือดออก',   // สูง is not สูงอายุ
    'ระดับหลักฐาน: สูงอายุเป็นปัจจัยเสี่ยง',
    'The evidence is high quality.',
    'Evidence suggests benefit in older adults.',
    'Evidence-based practice: start with the guideline.',
    'High-quality evidence supports amoxicillin.',
    'ระดับหลักฐานยังไม่ชัดเจน ควรติดตามอาการ',          // no colon: a sentence, not a label
    'หลักฐานจาก RCT: สนับสนุนการให้ยา',
    '❓ Evidence level: what would change your plan?',  // the examiner's question, never removed
    `\`${LINE.high}\``,
    '  - Evidence: high',                              // a nested item: grades one option, content
    `    ${LINE.low}`,
  ];

  test.each(NEAR_MISS)('%j is a removable statement but not a marker', (line) => {
    expect(isEvidenceStatementLine(line)).toBe(true);
    expect(isRemovableEvidenceStatement(line)).toBe(true);
    expect(parseEvidenceLine(line)).toBeNull();
  });

  test.each(CARRIES_CONTENT)('%j is a statement that carries content: detected, never removed', (line) => {
    expect(isEvidenceStatementLine(line)).toBe(true);
    expect(isRemovableEvidenceStatement(line)).toBe(false);
    expect(parseEvidenceLine(line)).toBeNull();
    // Refused whole: the retry splice keeps the first reply, and a valid marker beside it is not moved.
    expect(spliceEvidenceLine(`${PROSE}\n${line}`, LINE.low)).toBeNull();
    expect(spliceEvidenceLine(`${PROSE}\n${line}\n${Q}`, LINE.low, { socratic: true })).toBeNull();
    expect(placeEvidenceLine(`${PROSE}\n${line}\n\n${LINE.low}`)).toBeNull();
  });

  test.each(BULLETED)('%j (bulleted canonical) is a marker AND a statement', (line) => {
    expect(parseEvidenceLine(line)).toBe('high');
    expect(isEvidenceStatementLine(line)).toBe(true);
    expect(isRemovableEvidenceStatement(line)).toBe(true);
  });

  test.each(PROSE_CONTROLS)('%j is content, and stays — in a splice and beside a valid marker', (line) => {
    expect(isEvidenceStatementLine(line)).toBe(false);
    expect(isRemovableEvidenceStatement(line)).toBe(false);
    expect(spliceEvidenceLine(`${PROSE}\n${line}`, LINE.low).text).toBe(`${PROSE}\n${line}\n\n${LINE.low}`);
    // A correct reply holding the line comes back byte-identical: nothing to move, nothing removed.
    for (const socratic of [false, true]) {
      const reply = socratic ? `${PROSE}\n${line}\n\n${LINE.low}\n${Q}` : `${PROSE}\n${line}\n\n${LINE.low}`;
      expect(placeEvidenceLine(reply, { socratic })).toBeNull();
      expect(findEvidenceStatements(reply)).toHaveLength(1);
    }
  });

  test.each([...NEAR_MISS, ...BULLETED])('%j is removed in both modes; the result holds exactly one statement', (nm) => {
    const nat = spliceEvidenceLine(`${PROSE}\n${nm}`, LINE.low, { socratic: false });
    expect(nat.text).toBe(`${PROSE}\n\n${LINE.low}`);
    expect(findEvidenceStatements(nat.text)).toEqual([2]);
    expect(nat.text.startsWith(`${PROSE}\n${nm}`)).toBe(false);   // NOT a pure append: the route must replace
    const exam = spliceEvidenceLine(`${PROSE}\n${nm}\n${Q}`, LINE.low, { socratic: true });
    expect(exam.text).toBe(`${PROSE}\n\n${LINE.low}\n${Q}`);
    expect(findEvidenceStatements(exam.text)).toEqual([2]);
    expect(extractSocraticQuestion(exam.text)).toBe(Q.slice(2));
  });

  test('near-misses that state DIFFERENT levels are per-option grades: refused whole, though each is bare', () => {
    const options = `${PROSE}\n**Option 1: Apixaban**\n- Evidence level: high\n**Option 2: LMWH**\n- Evidence level: moderate`;
    for (const line of ['- Evidence level: high', '- Evidence level: moderate']) expect(isRemovableEvidenceStatement(line)).toBe(true);
    expect(spliceEvidenceLine(options, LINE.moderate)).toBeNull();                        // the retry splice
    expect(placeEvidenceLine(`${options}\n\n${LINE.moderate}`)).toBeNull();             // beside a valid marker
    expect(spliceEvidenceLine(`${PROSE}\nระดับหลักฐาน: สูง / low`, LINE.low)).toBeNull();  // one line, two levels
    // Near-misses that AGREE are one statement said twice: removed.
    expect(spliceEvidenceLine(`${PROSE}\nEvidence level: high\n### Level of evidence: high`, LINE.high).text)
      .toBe(`${PROSE}\n\n${LINE.high}`);
    // Strict markers that disagree are the ambiguity the retry fixes: still replaced (not counted here).
    expect(spliceEvidenceLine(`${PROSE}\n${LINE.high}\n${LINE.low}`, LINE.moderate).text).toBe(`${PROSE}\n\n${LINE.moderate}`);
  });

  test('one content-carrying statement refuses the whole splice, even beside removable ones', () => {
    expect(spliceEvidenceLine(`${PROSE}\nEvidence level: high\nEvidence: high (BTS, 2019)`, LINE.high)).toBeNull();
  });

  test('a near-miss inside a fence is content: it stays, and does not count', () => {
    const first = `${PROSE}\n\`\`\`\nEvidence level: high\n\`\`\``;
    const r = spliceEvidenceLine(first, LINE.low);
    expect(r.text).toBe(`${first}\n\n${LINE.low}`);
    expect(findEvidenceStatements(r.text)).toHaveLength(1);
  });

  test('a NESTED item is content: never the marker, never removed, never relabelled for the main recommendation', () => {
    const opts = `${PROSE}\n- Option A: amoxicillin\n  - Evidence: high\n- Option B: doxycycline\n  - ${LINE.low}`;
    expect(extractEvidenceLevel(opts)).toBeNull();
    expect(findEvidenceStatements(opts)).toEqual([]);
    expect(placeEvidenceLine(opts)).toBeNull();
    // The retry's line is appended; the nested ones stay exactly where they were.
    expect(spliceEvidenceLine(opts, LINE.moderate).text).toBe(`${opts}\n\n${LINE.moderate}`);
    // Beside a valid reply-level marker, a correct reply is left byte-identical.
    expect(placeEvidenceLine(`${opts}\n\n${LINE.moderate}`)).toBeNull();
    expect(extractEvidenceLevel(`${opts}\n\n${LINE.moderate}`)).toBe('moderate');
  });

  test('findEvidenceStatements counts strict markers and near-misses alike, outside fences', () => {
    expect(findEvidenceStatements(`${PROSE}\nEvidence level: high\n\n${LINE.high}\n${Q}`)).toEqual([1, 3]);
    expect(findEvidenceStatements(PROSE)).toEqual([]);
  });
});

describe('placement: one valid marker in the wrong place is moved with NO model call', () => {
  test('evidenceMarkerPlaced: natural = nothing after it; examiner = only the ❓ after it', () => {
    expect(evidenceMarkerPlaced(`${PROSE}\n\n${LINE.low}`)).toBe(true);
    expect(evidenceMarkerPlaced(`${PROSE}\n${LINE.low}\n\n`)).toBe(true);          // trailing blank lines
    expect(evidenceMarkerPlaced(`${LINE.low}\n${PROSE}`)).toBe(false);
    expect(evidenceMarkerPlaced(PROSE)).toBe(false);
    expect(evidenceMarkerPlaced(`${PROSE}\n${LINE.low}\n${LINE.low}`)).toBe(false);  // two: ambiguous
    expect(evidenceMarkerPlaced(`${PROSE}\nระดับหลักฐาน: สูง (Evidence: low)`)).toBe(false);
    const s = { socratic: true };
    expect(evidenceMarkerPlaced(`${PROSE}\n\n${LINE.low}\n${Q}`, s)).toBe(true);
    expect(evidenceMarkerPlaced(`${PROSE}\n\n${LINE.low}\n\n${Q}`, s)).toBe(true);
    expect(evidenceMarkerPlaced(`${PROSE}\n${Q}\n${LINE.low}`, s)).toBe(false);      // after the ❓
    expect(evidenceMarkerPlaced(`${LINE.low}\n${PROSE}\n${Q}`, s)).toBe(false);      // too early
    expect(evidenceMarkerPlaced(`${PROSE}\n\n${LINE.low}`, s)).toBe(true);           // examiner, no ❓
    expect(evidenceMarkerPlaced(`${PROSE}\n\n${LINE.low}\n${Q}`)).toBe(false);       // natural: ❓ after it
  });

  test('examiner: a marker after the ❓ (which also breaks physician-ui\'s question lift) moves above it', () => {
    const s = { socratic: true };
    const moved = placeEvidenceLine(`${PROSE}\n${Q}\n${LINE.low}`, s);
    expect(moved).toBe(`${PROSE}\n\n${LINE.low}\n${Q}`);
    expect(extractSocraticQuestion(moved)).toBe(Q.slice(2));
    expect(moved.match(/\n❓[^\n]*$/)[0]).toBe(`\n${Q}`);
    expect(placeEvidenceLine(`${LINE.high}\n${PROSE}\n${Q}`, s)).toBe(`${PROSE}\n\n${LINE.high}\n${Q}`);
    expect(placeEvidenceLine(`${PROSE}\n**Evidence: expert opinion**\nMore.\n${Q}`, s))
      .toBe(`${PROSE}\nMore.\n\n${LINE.expert}\n${Q}`);   // written canonically on the way
  });

  test('examiner: a marker after the ❓ with a blank line before it leaves NO trailing newline behind', () => {
    const moved = placeEvidenceLine(`${PROSE}\n\n${Q}\n\n${LINE.low}`, { socratic: true });
    expect(moved).toBe(`${PROSE}\n\n${LINE.low}\n${Q}`);
    expect(moved.endsWith(Q)).toBe(true);
    // audit-dashboard TranscriptView.tsx and physician-ui ple-chat.js / guest-chat.js lift the ❓ with this.
    expect(moved.match(/\n❓[^\n]*$/)[0]).toBe(`\n${Q}`);
    // A first reply that itself ended in a newline keeps it; a marker removed from the top takes the
    // blank line under it too.
    expect(placeEvidenceLine(`${PROSE}\n${Q}\n${LINE.low}\n`, { socratic: true })).toBe(`${PROSE}\n\n${LINE.low}\n${Q}\n`);
    expect(placeEvidenceLine(`${LINE.low}\n\n${PROSE}`)).toBe(`${PROSE}\n\n${LINE.low}`);
  });

  test('natural: a marker that is not the last line moves to the end', () => {
    expect(placeEvidenceLine(`${LINE.moderate}\n${PROSE}`)).toBe(`${PROSE}\n\n${LINE.moderate}`);
    expect(placeEvidenceLine(`${PROSE}\n${LINE.moderate}\nMore advice.`)).toBe(`${PROSE}\nMore advice.\n\n${LINE.moderate}`);
    // A stray ❓ in a natural reply is ordinary text: the marker still goes last.
    expect(placeEvidenceLine(`${PROSE}\n${LINE.low}\n❓ x?`)).toBe(`${PROSE}\n❓ x?\n\n${LINE.low}`);
  });

  test('a valid, well-placed marker next to a near-miss: the near-miss goes, the level is kept', () => {
    expect(placeEvidenceLine(`${PROSE}\nEvidence level: high\n\n${LINE.high}`)).toBe(`${PROSE}\n\n${LINE.high}`);
    expect(placeEvidenceLine(`${PROSE}\n### Level of evidence: low\n${LINE.moderate}\n${Q}`, { socratic: true }))
      .toBe(`${PROSE}\n\n${LINE.moderate}\n${Q}`);
  });

  test('nothing to do, or nothing safe to do -> null (the reply stands as it is)', () => {
    expect(placeEvidenceLine(`${PROSE}\n\n${LINE.low}`)).toBeNull();                       // placed
    expect(placeEvidenceLine(`${PROSE}\n\n${LINE.low}\n${Q}`, { socratic: true })).toBeNull();
    expect(placeEvidenceLine(`${PROSE}\n${LINE.low}`)).toBeNull();      // placed, no blank: not moved for that alone
    expect(placeEvidenceLine(`${PROSE}\n\n**Evidence: low**`)).toBeNull();  // placed: not rewritten canonically
    expect(placeEvidenceLine(PROSE)).toBeNull();                                            // no marker
    expect(placeEvidenceLine(`${LINE.high}\n${PROSE}\n${LINE.low}`)).toBeNull();          // two: no level to keep
    expect(placeEvidenceLine(`ระดับหลักฐาน: สูง (Evidence: low)\n${PROSE}`)).toBeNull();   // conflict
    expect(placeEvidenceLine(`Evidence level: high\n${PROSE}`)).toBeNull();               // near-miss only
    // Moving would drop the only citation (it sits on a near-miss): refused.
    expect(placeEvidenceLine(`Start amoxicillin.\nEvidence: high (BTS, 2019)\n\n${LINE.high}`)).toBeNull();
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
    // Zero-width characters inside the label do not smuggle the line past the strip.
    expect(stripNonProse(`ข้อความ\nระดับ\u200Bหลักฐาน: สูง (Evidence: high)`)).not.toMatch(/Evidence/);
  });

  test('each line is 45-51% Thai — over the 0.30 bar, so it could only ever HIDE an English reply', () => {
    const shares = Object.values(LINE).map((l) => thaiShare(l));
    expect(Math.min(...shares)).toBeGreaterThan(0.45);
    expect(Math.max(...shares)).toBeLessThan(0.52);
    // Measured, the line would lift a short English reply to a Thai question over the bar and the
    // guard would wave it through; stripped, the reply is judged on its own prose (share 0).
    const reply = `Give ceftriaxone plus azithromycin now (IDSA, 2019).\n${LINE.expert}`;
    expect(thaiShare(reply)).toBeGreaterThanOrEqual(0.30);          // what an unstripped measure would see
    expect(isLanguageMismatch(reply, 'th')).toBe(true);              // what the guard does see
  });

  test('a Thai reply keeps its measured share: the line is neither credited nor held against it', () => {
    const thai = 'ให้ ceftriaxone และ azithromycin ในผู้ป่วย CAP ภายในหนึ่งชั่วโมง';
    for (const line of Object.values(LINE)) {
      expect(thaiShare(stripNonProse(`${thai}\n${line}`))).toBe(thaiShare(stripNonProse(thai)));
    }
    expect(isLanguageMismatch(`${thai}\n${LINE.low}`, 'th')).toBe(false);
  });

  test('an English reply does not read as more Thai because of the Thai label', () => {
    const reply = `${PROSE}\n${LINE.expert}`;
    expect(thaiShare(stripNonProse(reply))).toBe(0);
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
    'long english label, spaced out': `Evidence${' for'.repeat(N / 4)}`,
    'expert + spaces + opinion-less': `Evidence: expert${' '.repeat(N)}x`,
    'many marker lines': `${LINE.high}\n`.repeat(N / 80),
    'many bold runs': '**'.repeat(N / 2),
    'many blockquote markers': '> '.repeat(N / 2),
    'many zero-width chars': '\u200B'.repeat(N),
    'many short evidence lines': 'Evidence: \n'.repeat(N / 11),
    'many fence toggles': '```\n'.repeat(N / 4),
    'many artifact openers': ':::artifact{a}\n'.repeat(N / 15),
    'many near-miss lines': 'Evidence level: high\n'.repeat(N / 21),
    'many emoji lines': `${'\u{1F4CA}'.repeat(90)}\n`.repeat(N / 181),
    'many stacked list markers': `${'- '.repeat(95)}x\n`.repeat(N / 192),
    'thai label + long tail': `ระดับหลักฐาน${'ก'.repeat(150)}\n`.repeat(N / 163),
    'label + long paren, no close': `Level of evidence (${'x'.repeat(150)}\n`.repeat(N / 170),
  };
  test.each(Object.entries(HOSTILE))('%s', (_name, text) => {
    const t0 = process.hrtime.bigint();
    extractEvidenceLevel(text);
    findEvidenceMarkers(text);
    spliceEvidenceLine(text, text);
    findEvidenceStatements(text);
    placeEvidenceLine(text, { socratic: true });
    evidenceMarkerPlaced(text, { socratic: true });
    stripNonProse(text);
    isLanguageMismatch(text, 'th');
    isThaiMessage(text);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(50);
  });
});
