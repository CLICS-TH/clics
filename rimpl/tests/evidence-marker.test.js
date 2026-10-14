// EVIDENCE-LEVEL MARKER (CCME R5) — the validator, the splice, and the prompt text they check.
//
// The line lib/prompts.js EVIDENCE_GUIDANCE asks for and services/post-filter.js extractEvidenceLevel
// accepts are built from ONE table (EVIDENCE_LEVELS). These tests pin that the two agree, what counts
// as a marker (and what does not), the ambiguity rule, the splice, the language-guard exclusion, and
// the cost bound. Pure functions: no route, no AI, no network.
const {
  extractEvidenceLevel, findEvidenceMarkers, parseEvidenceLine, spliceEvidenceLine, EVIDENCE_LINE_MAX_CHARS,
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
    ['ระดับหลักฐาน: สูง (Evidence: high)', 'high'],          // NBSP
    ['ระดับ​หลักฐาน: สูง​ (Evidence: high)﻿', 'high'],       // zero-width characters
    [`${LINE.high}\r`, 'high'],
  ])('%j -> %s', (line, key) => expect(parseEvidenceLine(line)).toBe(key));

  test.each([
    'Evidence: very low',                                  // not one of the five levels
    'ระดับหลักฐาน: สูงมาก',
    `${LINE.high}..`,                                      // more than ONE trailing full stop
    `- ${LINE.high}`,                                      // bulleted
    `* ${LINE.high}`,
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

  test('natural: appended as the last line, as a pure append of the first reply', () => {
    const r = spliceEvidenceLine(PROSE, 'Evidence: moderate', { socratic: false });
    expect(r).toEqual({ text: `${PROSE}\n${LINE.moderate}`, level: 'moderate' });
    expect(r.text.startsWith(PROSE)).toBe(true);
    expect(spliceEvidenceLine(`${PROSE}\n`, LINE.low).text).toBe(`${PROSE}\n${LINE.low}`);
  });

  test('examiner: inserted directly above the LAST ❓ line, so the ❓ stays last', () => {
    const first = `${PROSE}\n❓ an earlier aside?\nMore text.\n${Q}`;
    const r = spliceEvidenceLine(first, LINE.high, { socratic: true });
    expect(r.text).toBe(`${PROSE}\n❓ an earlier aside?\nMore text.\n${LINE.high}\n${Q}`);
    expect(r.text.trim().split('\n').at(-1)).toBe(Q);
    expect(extractSocraticQuestion(r.text)).toBe(Q.slice(2));
    // No ❓ at all (cannot happen on an evidence-only examiner turn, but must not throw): appended.
    expect(spliceEvidenceLine(PROSE, LINE.high, { socratic: true }).text).toBe(`${PROSE}\n${LINE.high}`);
  });

  test('the CANONICAL line is written, whatever form the model used; the rest of its answer is ignored', () => {
    const r = spliceEvidenceLine(PROSE, 'Sure — here it is:\n**Evidence: expert opinion**\n❓ Anything else?');
    expect(r).toEqual({ text: `${PROSE}\n${LINE.expert}`, level: 'expert' });
  });

  test('the first reply survives byte for byte, artifact and all', () => {
    const first = `${PROSE}\n${ART}\nSee the table.`;
    const r = spliceEvidenceLine(first, 'Evidence: low');
    expect(r.text).toBe(`${first}\n${LINE.low}`);
    expect(r.text).toContain(ART);
    expect(hasCitation(r.text)).toBe(true);
  });

  test('no single marker in the answer -> null (the caller keeps the first reply unchanged)', () => {
    expect(spliceEvidenceLine(PROSE, 'I cannot grade that.')).toBeNull();
    expect(spliceEvidenceLine(PROSE, `${LINE.high}\n${LINE.low}`)).toBeNull();
    expect(spliceEvidenceLine(PROSE, 'ระดับหลักฐาน: สูง (low)')).toBeNull();
    expect(spliceEvidenceLine(PROSE, `\`\`\`\n${LINE.high}\n\`\`\``)).toBeNull();
    expect(spliceEvidenceLine(PROSE, '')).toBeNull();
  });

  test('stray marker lines in the first reply (why the check fired) are replaced by the one line', () => {
    const first = `${PROSE}\n${LINE.high}\nMore.\n${LINE.low}`;
    const r = spliceEvidenceLine(first, 'Evidence: moderate');
    expect(r.text).toBe(`${PROSE}\nMore.\n${LINE.moderate}`);
    expect(extractEvidenceLevel(r.text)).toBe('moderate');
    const fenced = spliceEvidenceLine(`${PROSE}\n${ART.replace('| CAP | fever |', LINE.high)}`, 'Evidence: low');
    expect(fenced.text).toContain(LINE.high);   // a line inside a fence is content, and stays
    expect(extractEvidenceLevel(fenced.text)).toBe('low');
  });

  test('a splice that would not read back (first reply ends inside an unterminated fence) -> null', () => {
    expect(spliceEvidenceLine(`${PROSE}\n:::artifact{type="x" title="t"}\ntruncated`, 'Evidence: low')).toBeNull();
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
    expect(stripNonProse(`ข้อความ\nระดับ​หลักฐาน: สูง (Evidence: high)`)).not.toMatch(/Evidence/);
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
    'many zero-width chars': '​'.repeat(N),
    'many short evidence lines': 'Evidence: \n'.repeat(N / 11),
    'many fence toggles': '```\n'.repeat(N / 4),
    'many artifact openers': ':::artifact{a}\n'.repeat(N / 15),
  };
  test.each(Object.entries(HOSTILE))('%s', (_name, text) => {
    const t0 = process.hrtime.bigint();
    extractEvidenceLevel(text);
    findEvidenceMarkers(text);
    spliceEvidenceLine(text, text);
    stripNonProse(text);
    isLanguageMismatch(text, 'th');
    isThaiMessage(text);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(50);
  });
});
