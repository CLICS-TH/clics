#!/usr/bin/env node
/*
 * The reply bank's authoring tool (ADR 0011, #382). A five-step case's reply bank sits at <EVENT>/replies/<case_id>.json
 * beside the case file (backend/src/booth-cases/reply-bank.js).
 *
 *   node scripts/booth/reply-bank.mjs sheet <case.json>   # what to write: per bank and option, the case text a reply may quote
 *   node scripts/booth/reply-bank.mjs check <case.json>   # the bank's problems, then the two hashes its review must name
 *
 * check exits 1 on any problem but a missing or stale safety review, which it reports and leaves to the reviewer;
 * 2 on a bad argument or an unreadable file.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CASES = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../backend/src/booth-cases');
const { treeSha } = require(path.join(CASES, 'tree-sha'));
const { repliesSha, replyContentProblems, replyBankProblems } = require(path.join(CASES, 'reply-bank'));

const [command, caseFile] = process.argv.slice(2);
if (!['sheet', 'check'].includes(command) || !caseFile) {
  console.error('usage: reply-bank.mjs sheet|check <case.json>');
  process.exit(2);
}
const read = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (err) { console.error(`cannot read ${file}: ${err.message}`); process.exit(2); }
};
const kase = read(caseFile);
const replyFile = path.join(path.dirname(caseFile), 'replies', path.basename(caseFile));

if (command === 'sheet') {
  console.log(`# ${kase.case_id} v${kase.version}: reply bank at ${path.relative(process.cwd(), replyFile)}`);
  console.log(`vignette.th: ${kase.vignette.th}\nvignette.en: ${kase.vignette.en}\n`);
  for (const [step, level] of Object.entries(kase.banks)) {
    for (const [key, bank] of Array.isArray(level.variants) ? [[step, level]] : Object.entries(level).map(([k, b]) => [`${step}.${k}`, b])) {
      console.log(`## ${key}`);
      for (const v of bank.variants) console.log(`  question ${v.id}: ${v.question.th} | ${v.question.en}`);
      for (const o of bank.options) console.log(`  option ${o.id} (${o.tier}): ${o.label.th}: ${o.line.th} | ${o.label.en}: ${o.line.en}`);
      console.log('');
    }
  }
} else {
  const file = read(replyFile);
  const content = replyContentProblems(kase, file.replies ?? {});
  const all = replyBankProblems(kase, file);
  for (const p of all) console.log(p);
  console.log(`tree sha256 ${treeSha(kase)}`);
  if (file.replies) console.log(`replies sha256 ${repliesSha(file.replies)}`);
  const reviewOnly = all.every((p) => p.startsWith('safety_review:'));
  console.log(all.length === 0 ? 'ok' : reviewOnly && content.length === 0 ? 'content ok; review pending' : `${all.length} problem(s)`);
  process.exit(reviewOnly && content.length === 0 ? 0 : 1);
}
