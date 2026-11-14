// An event's pool (spec #370, #386): the cases a booth may deal, and each five-step case's reply bank (ADR 0011, #382).
// Apart from tree-schema because the reply bank's checker needs services/booth-dialogue, which needs tree-schema.
const fs = require('fs');
const path = require('path');
const { treeSteps, CaseTreeSchema, caseTreeProblems, isAdmitted } = require('./tree-schema');
const { replyBankProblems } = require('./reply-bank');

const STEP_WORD = { 3: 'three', 5: 'five' };

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };

/** One event's case files under `dir` as eventPool takes them: each case JSON with the reply bank beside it at
 *  replies/<name>, raw and replies undefined when unreadable or missing. No files when the event has no folder. */
function readEventFiles(dir, code) {
  let names;
  try { names = fs.readdirSync(path.join(dir, code)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return names.map((name) => ({
    name, raw: readJson(path.join(dir, code, name)), replies: readJson(path.join(dir, code, 'replies', name)),
  }));
}

/**
 * One event's pool, pure. `files` are its case files as { name, raw, replies }, raw undefined when the file is not
 * readable JSON and replies the reply bank file beside it, if any. The event's step count is the largest among its
 * trees, admitted or not, so adding one five-step tree moves the whole event to five steps and the pool never mixes
 * counts. The pool is its admitted cases of that count, parsed and sorted by case_id, a five-step case only with a
 * complete reply bank whose review binds it (reply-bank.js); every other file is left out with why. A bank's replies
 * ride apart from its case, by case_id: a study snapshot and every other writer serialise the case object.
 * @returns {{ steps: number, cases: object[], replyBanks: Record<string, object>, left: { name: string, why: string }[] }}
 */
function eventPool(code, files) {
  const steps = Math.max(0, ...files.filter((f) => f.raw).map((f) => treeSteps(f.raw.banks)));
  const cases = [];
  const replyBanks = {};
  const left = [];
  for (const { name, raw, replies } of files) {
    const why = (() => {
      if (raw === undefined) return 'is not readable JSON';
      const problems = caseTreeProblems(raw);
      if (problems.length) return `has ${problems.length} problem(s), first ${problems[0]}`;
      if (raw.case_id !== name.replace(/\.json$/, '') || raw.event_code !== code) return 'is not named after its case_id and event folder';
      const own = treeSteps(raw.banks);
      if (own !== steps) return `is a ${STEP_WORD[own]}-step case in a ${STEP_WORD[steps]}-step event`;
      if (!isAdmitted(raw)) return 'is not admitted';
      if (own !== 5) return null;
      if (replies === undefined) return 'has no reply bank';
      const bankProblems = replyBankProblems(raw, replies);
      return bankProblems.length ? `has a reply bank with ${bankProblems.length} problem(s), first ${bankProblems[0]}` : null;
    })();
    if (why) {
      left.push({ name, why });
      continue;
    }
    const kase = CaseTreeSchema.parse(raw);
    cases.push(kase);
    if (treeSteps(raw.banks) === 5) replyBanks[kase.case_id] = replies.replies;
  }
  cases.sort((a, b) => (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0));
  return { steps, cases, replyBanks, left };
}

module.exports = { readEventFiles, eventPool };
