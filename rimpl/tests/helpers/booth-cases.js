// Every booth case file rimpl could be sent text from: each event's pool (booth-cases/<EVENT>/*.json) and each staged
// pool (booth-cases/staging/<EVENT>/*.json), which a cutover moves into the live folder whole (#386). A case check reads
// this list, so a new, staged or re-shaped case is checked without an edit to the test.
const fs = require('fs');
const path = require('path');
const { bankAt, bankKey, stepCount } = require('../../../backend/src/services/booth-dialogue');
const { tierPaths } = require('../../../backend/src/booth-cases/tree-schema');

const ROOT = path.join(__dirname, '../../../backend/src/booth-cases');
// backend/src/services/booth.js SAFE_EVENT_CODE: the folders the loader reads a pool from.
const EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const LANGUAGES = ['th', 'en'];

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const eventDirs = (dir) => (isDir(dir) ? fs.readdirSync(dir).filter((n) => EVENT_CODE.test(n)).sort()
  .map((n) => path.join(dir, n)).filter(isDir) : []);

const CASES = [...eventDirs(ROOT), ...eventDirs(path.join(ROOT, 'staging'))].flatMap((dir) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: path.relative(ROOT, path.join(dir, f)), kase: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) })));

// A step's banks are one bank, or an object of banks keyed by tier path (booth-dialogue.js bankEntry).
const isBank = (level) => Array.isArray(level?.variants);
/** Every bank the file holds, read from its own layout, with its place in the file. */
const bankEntries = (kase) => Object.entries(kase.banks).flatMap(([step, level]) => (isBank(level) ? [[`banks.${step}`, level]]
  : Object.entries(level).map(([key, bank]) => [`banks.${step}.${key}`, bank])));

/** Each bank a play can reach, once, with the first tier path (in tierPaths order) that reaches it. */
function reachableBanks(kase) {
  const seen = new Map();
  for (let n = 0; n < stepCount(kase); n += 1) {
    for (const tierPath of tierPaths(n)) {
      const bank = bankAt(kase, tierPath);
      if (!seen.has(bank)) seen.set(bank, { key: bankKey(kase, tierPath), tierPath, bank });
    }
  }
  return [...seen.values()];
}

/** Every string of the case in both languages, with its place in the file: the teaser, the vignette, and each bank's
 *  variant questions and option labels and lines. */
const caseTexts = (kase) => [
  ['teaser', kase.teaser],
  ['vignette', kase.vignette],
  ...bankEntries(kase).flatMap(([at, bank]) => [
    ...bank.variants.map((v, i) => [`${at}.variants[${i}].question`, v.question]),
    ...bank.options.flatMap((o, i) => [[`${at}.options[${i}].label`, o.label], [`${at}.options[${i}].line`, o.line]]),
  ]),
].flatMap(([at, text]) => LANGUAGES.map((lang) => ({ at: `${at}.${lang}`, lang, text: text[lang] })));

/** Every variant and option id of the case, with its place in the file. rimpl sends them to the AI as written
 *  (rimpl/src/services/booth.js bankIn), so the case text scan reads them too. */
const caseIds = (kase) => bankEntries(kase).flatMap(([at, bank]) => [
  ...bank.variants.map((v, i) => ({ at: `${at}.variants[${i}].id`, text: v.id })),
  ...bank.options.map((o, i) => ({ at: `${at}.options[${i}].id`, text: o.id })),
]);

module.exports = { CASES, bankEntries, reachableBanks, caseTexts, caseIds };
