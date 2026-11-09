// #406: the booth sends rimpl each typed step as the bank question, a newline, then the visitor's typed answer
// (backend/src/services/booth-dialogue.js dialogueTurns). A question that opens with the pronoun คุณ ("you") must
// not turn the answer on the next line into a name: the AI sorts and replies to that answer, and ADR 0010 keeps it.
const fs = require('fs');
const path = require('path');
const { stripPii, primeRegistry, makeRegistry, deriveHintTokens } = require('../src/services/pii-filter');

const CASES_DIR = path.join(__dirname, '../../backend/src/booth-cases/NFCME-2026');

function bankQuestions(node, out) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'question' && typeof value?.th === 'string') out.add(value.th);
    else bankQuestions(value, out);
  }
  return out;
}

const PAIRS = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((file) => {
  const kase = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8'));
  return [...bankQuestions(kase.banks, new Set())].map((question) => [file, question, kase.vignette.th]);
});

const ANSWERS = [
  'ให้ออกซิเจนและส่งตรวจเพิ่มเติม',
  'ส่งตรวจ CBC และ electrolyte',
  'ให้น้ำเกลือและยาปฏิชีวนะทันที',
  'คิดถึงภาวะช็อกจากการเสียเลือด',
];

const hints = deriveHintTokens(undefined); // the booth sends no patient_ref

// rimpl's chat route primes one registry over the whole turn, then strips it (routes/chat.js deidentifyTurn).
function stripLikeChatRoute(message) {
  const registry = makeRegistry();
  primeRegistry([message], registry, hints);
  return stripPii(message, registry, hints);
}

test('the NFCME-2026 banks are all read', () => {
  expect(new Set(PAIRS.map(([file]) => file)).size).toBe(11);
  expect(PAIRS.length).toBeGreaterThan(150);
});

describe.each(PAIRS)('%s: %s', (_file, question, vignette) => {
  test.each(ANSWERS)('typed answer survives: %s', (answer) => {
    for (const message of [`${question}\n${answer}`, `${vignette}\n\n${question}\n${answer}`]) {
      expect(stripPii(message, makeRegistry(), hints).endsWith(`\n${answer}`)).toBe(true);
      expect(stripLikeChatRoute(message).endsWith(`\n${answer}`)).toBe(true);
    }
  });
});
