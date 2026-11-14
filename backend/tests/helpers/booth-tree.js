const fs = require('fs');
const path = require('path');
const { treeSha } = require('../../src/booth-cases/tree-sha');
const { repliesSha } = require('../../src/booth-cases/reply-bank');

const TREE_BOUND = ['safety_review', 'sandbox', 'owner_waiver'];

// A safety review names the tree it read in its findings too (tree-sha.js reviewedSha), and a reply bank's review also
// names the replies it read (reply-bank.js).
const NAMED = /\s*Tree sha256 [0-9a-f]{64}\.?/gi;
const REPLIES_NAMED = /\s*Replies sha256 [0-9a-f]{64}\.?/gi;
const named = (record, sha) => ({ ...record, findings: `${record.findings.replace(NAMED, '')} Tree sha256 ${sha}.` });

/** A test case as a review and a build would leave it: its table, if any, and each record that judges its tree,
 *  stamped with the hash of the tree the test made, the safety review's findings included. */
const stamped = (k) => {
  const sha = treeSha(k);
  const admission = k.admission && Object.fromEntries(Object.entries(k.admission)
    .map(([name, record]) => [name, TREE_BOUND.includes(name) ? { ...(name === 'safety_review' ? named(record, sha) : record), tree_sha256: sha } : record]));
  return {
    ...k,
    ...(admission ? { admission } : {}),
    ...(k.path_score_table ? { path_score_table: { ...k.path_score_table, provenance: { ...k.path_score_table.provenance, tree_sha256: sha } } } : {}),
  };
};

/** A test reply bank as its review would leave it: bound by hash to the tree of `k` and to its own replies, the
 *  findings naming both. */
const stampedBank = (k, bank) => {
  const tree = treeSha(k);
  const sha = repliesSha(bank.replies);
  const review = bank.safety_review ?? { model: 'fixture', date: '2026-11-14', findings: 'Test fixture. No safety review was run.' };
  const findings = `${review.findings.replace(NAMED, '').replace(REPLIES_NAMED, '')} Tree sha256 ${tree}. Replies sha256 ${sha}.`;
  return { ...bank, safety_review: { ...review, findings, tree_sha256: tree, replies_sha256: sha } };
};

const FIXTURES = path.join(__dirname, '..', 'fixtures');

/** The five-step fixture's reply bank, generated: per bank, option and language, three alternatives
 *  that name their own bank and option, so a test can tell which entry a reply came from. */
function fixtureReplies(k) {
  const banks = Object.entries(k.banks).flatMap(([step, level]) => (Array.isArray(level.variants) ? [[step, level]]
    : Object.entries(level).map(([key, bank]) => [`${step}.${key}`, bank])));
  const alternatives = (id) => ({
    // No digits: a reply may not cite a number only some of its bank's variants show.
    th: ['หนึ่ง', 'สอง', 'สาม'].map((n, i) => ({ strength: `จุดเด่นของ ${id} แบบที่${n}`, weigh: `ข้อที่ควรชั่งน้ำหนักแบบที่${n}`, safety: i === 2 ? 'ระวังผลข้างเคียง' : '' })),
    en: ['one', 'two', 'three'].map((n, i) => ({ strength: `Strength of ${id}, take ${n}.`, weigh: `Worth weighing, take ${n}.`, safety: i === 2 ? 'Mind the side effects.' : '' })),
  });
  return Object.fromEntries(banks.map(([key, bank]) => [key, Object.fromEntries(bank.options.map((o) => [o.id, alternatives(o.id)]))]));
}

// Writes backend/tests/fixtures/booth-reply-bank-5.json from the five-step fixture: node backend/tests/helpers/booth-tree.js
if (require.main === module) {
  const k = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'booth-case-tree-5.json'), 'utf8'));
  const bank = stampedBank(k, { case_id: k.case_id, replies: fixtureReplies(k) });
  fs.writeFileSync(path.join(FIXTURES, 'booth-reply-bank-5.json'), `${JSON.stringify(bank, null, 2)}\n`);
}

module.exports = { stamped, stampedBank };
