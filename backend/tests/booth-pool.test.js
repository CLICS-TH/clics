// An event's pool holds one step count (spec #370, #386), a record that judges a tree admits only the tree its
// hash names (#468, #470), and a five-step case is dealt only with a complete, reviewed reply bank (ADR 0011, #382).
const fs = require('fs');
const path = require('path');
const { isAdmitted, caseTreeProblems } = require('../src/booth-cases/tree-schema');
const { readEventFiles, eventPool } = require('../src/booth-cases/event-pool');
const { treeSha } = require('../src/booth-cases/tree-sha');
const { stamped, stampedBank } = require('./helpers/booth-tree');

const read = (file) => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
const THREE = stamped({ ...read('fixtures/booth-case-tree.json'), path_score_table: read('fixtures/booth-path-score-table.json') });
const FIVE = stamped({ ...read('fixtures/booth-case-tree-5.json'), path_score_table: read('fixtures/booth-path-score-table-5.json') });
const BANK5 = read('fixtures/booth-reply-bank-5.json');
const EVENT = THREE.event_code;
const file = (k, replies = k.banks?.step5 ? BANK5 : undefined) => ({ name: `${k.case_id}.json`, raw: k, replies });
const ids = (pool) => pool.cases.map((k) => k.case_id);

describe('a record that judges a tree admits only the tree its hash names', () => {
  const STALE = 'f'.repeat(64);
  const withRecord = (name, record) => ({ ...THREE, admission: { ...THREE.admission, [name]: record } });
  const waived = (k, record) => {
    const { sandbox: _sandbox, ...rest } = k.admission;
    return { ...k, admission: { ...rest, owner_waiver: { date: '2026-11-03', adr: '0005', reason: 'Owner waiver', sandbox_run_id: 'sbx-1', ...record } } };
  };

  test('the fixtures, bound to their own trees, are admitted', () => {
    expect(THREE.admission.safety_review.tree_sha256).toBe(treeSha(THREE));
    expect([isAdmitted(THREE), isAdmitted(FIVE)]).toEqual([true, true]);
  });

  test.each(['safety_review', 'sandbox'])('a %s bound to another tree, or to none, does not admit', (name) => {
    const { tree_sha256: _sha, ...unbound } = THREE.admission[name];
    expect(isAdmitted(withRecord(name, { ...unbound, tree_sha256: STALE }))).toBe(false);
    expect(isAdmitted(withRecord(name, unbound))).toBe(false);
  });

  test('an owner waiver admits in place of the sandbox only when bound to this tree', () => {
    expect(isAdmitted(waived(THREE, { tree_sha256: treeSha(THREE) }))).toBe(true);
    expect(isAdmitted(waived(THREE, { tree_sha256: STALE }))).toBe(false);
    expect(isAdmitted(waived(THREE, {}))).toBe(false);
  });

  test('a tree edited after its records were written is no longer admitted', () => {
    const edited = structuredClone(THREE);
    edited.teaser.en = `${edited.teaser.en}.`;
    expect(isAdmitted(edited)).toBe(false);
  });

  // gate #370 on PR #482: tree_sha256 is the mover's copy, so an edit with every hash field recomputed must still be
  // refused. Only the reviewer's findings keep naming the tree the review read.
  test('edit + recomputed tree_sha256, findings unchanged: not admitted, and a case problem', () => {
    const edited = structuredClone(THREE);
    edited.teaser.en = `${edited.teaser.en}.`;
    const sha = treeSha(edited);
    for (const record of [edited.admission.safety_review, edited.admission.sandbox, edited.path_score_table.provenance]) record.tree_sha256 = sha;
    expect(edited.admission.safety_review.findings).toBe(THREE.admission.safety_review.findings);
    expect(isAdmitted(edited)).toBe(false);
    expect(caseTreeProblems(edited)).toEqual([expect.stringMatching(/^admission\.safety_review\.tree_sha256: is not the tree its findings name/)]);
    // The same edit with a review that names the new tree, as a new review would, is admitted.
    expect(isAdmitted(stamped(edited))).toBe(true);
  });

  test('a safety review whose findings name no tree, or two, admits nothing', () => {
    const sha = treeSha(THREE);
    for (const findings of ['No must-fix.', `Tree sha256 ${sha}. Earlier tree sha256 ${'a'.repeat(64)}.`]) {
      expect(isAdmitted(withRecord('safety_review', { ...THREE.admission.safety_review, findings }))).toBe(false);
    }
  });

  test('the leptospirosis edit the gate made (7 days of doxycycline to 5, tree_sha256 recomputed) is a case problem', () => {
    const k = read('../src/booth-cases/NFCME-2026/leptospirosis.json');
    expect(caseTreeProblems(k)).toEqual([]);
    k.banks.step4.B.options[0].label.en = k.banks.step4.B.options[0].label.en.replace('7 days', '5 days');
    k.admission.safety_review.tree_sha256 = treeSha(k);
    expect(caseTreeProblems(k)).toEqual([expect.stringMatching(/^admission\.safety_review\.tree_sha256: is not the tree its findings name/)]);
  });
});

describe('the event pool holds one step count', () => {
  test('a three-step event deals its admitted three-step cases', () => {
    expect(eventPool(EVENT, [file(THREE)])).toMatchObject({ steps: 3, left: [] });
    expect(ids(eventPool(EVENT, [file(THREE)]))).toEqual([THREE.case_id]);
  });

  test('beside a five-step case the three-step one is left out, naming why', () => {
    const pool = eventPool(EVENT, [file(THREE), file(FIVE)]);
    expect(pool.steps).toBe(5);
    expect(ids(pool)).toEqual([FIVE.case_id]);
    expect(pool.left).toEqual([{ name: `${THREE.case_id}.json`, why: 'is a three-step case in a five-step event' }]);
  });

  test('a five-step tree not yet admitted already moves the event to five steps, so the pool is empty rather than mixed', () => {
    const { admission: _admission, ...unadmitted } = FIVE;
    const pool = eventPool(EVENT, [file(THREE), file(unadmitted)]);
    expect([pool.steps, ids(pool)]).toEqual([5, []]);
    expect(pool.left.map((l) => l.why)).toEqual(['is a three-step case in a five-step event', 'is not admitted']);
  });

  test('an unreadable file counts toward no step count', () => {
    expect(ids(eventPool(EVENT, [file(THREE), { name: 'broken.json', raw: undefined }]))).toEqual([THREE.case_id]);
  });

  test('the NFCME-2026 pool deals five-step cases only, and dka-young-adult is out', () => {
    const pool = eventPool('NFCME-2026', readEventFiles(path.join(__dirname, '../src/booth-cases'), 'NFCME-2026'));
    expect(pool.steps).toBe(5);
    expect(pool.cases.filter((k) => !k.banks.step5).map((k) => k.case_id)).toEqual([]);
    expect(pool.left.find((l) => l.name === 'dka-young-adult.json')?.why).toBe('is a three-step case in a five-step event');
  });
});

describe('a five-step case is dealt only with a complete reply bank whose review binds it (ADR 0011, #382)', () => {
  const withBank = (replies) => eventPool(EVENT, [file(FIVE, replies)]);
  const whyLeft = (replies) => withBank(replies).left.map((l) => l.why);

  test('with its reviewed bank it is admitted, and the pool carries the bank\'s replies by case_id, not on the case', () => {
    const pool = withBank(BANK5);
    expect([ids(pool), pool.left]).toEqual([[FIVE.case_id], []]);
    expect(pool.replyBanks).toEqual({ [FIVE.case_id]: BANK5.replies });
    expect(pool.cases[0]).not.toHaveProperty('replies');
  });

  test('a three-step case needs no bank, and the pool carries none for it', () => {
    expect(eventPool(EVENT, [file(THREE)])).toMatchObject({ replyBanks: {}, left: [] });
  });

  test('with no bank it is left out, naming why', () => {
    expect(eventPool(EVENT, [{ ...file(FIVE), replies: undefined }]).left.map((l) => l.why)).toEqual(['has no reply bank']);
  });

  test('with an incomplete bank it is left out, even when its review binds what it holds', () => {
    const { 'step5.W': _gone, ...replies } = BANK5.replies;
    expect(whyLeft(stampedBank(FIVE, { ...BANK5, replies }))).toEqual([expect.stringMatching(/^has a reply bank with 1 problem\(s\), first replies\.step5\.W: is missing$/)]);
  });

  test('with a bank whose review names another tree it is left out', () => {
    const other = structuredClone(FIVE);
    other.teaser.en = `${other.teaser.en}.`;
    expect(whyLeft(stampedBank(other, BANK5))).toEqual([expect.stringMatching(/^has a reply bank with 1 problem\(s\), first safety_review: does not bind this tree/)]);
  });

  test('with replies edited after their review it is left out', () => {
    const edited = structuredClone(BANK5);
    edited.replies.step1.a.en[0].weigh = 'Edited after the review.';
    expect(whyLeft(edited)).toEqual([expect.stringMatching(/^has a reply bank with 1 problem\(s\), first safety_review: does not bind these replies/)]);
  });

  test('the shared reader takes each case\'s bank from replies/<case_id>.json beside it, and none where there is none', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'booth-pool-'));
    fs.mkdirSync(path.join(dir, EVENT, 'replies'), { recursive: true });
    fs.writeFileSync(path.join(dir, EVENT, `${FIVE.case_id}.json`), JSON.stringify(FIVE));
    fs.writeFileSync(path.join(dir, EVENT, 'replies', `${FIVE.case_id}.json`), JSON.stringify(BANK5));
    fs.writeFileSync(path.join(dir, EVENT, `${THREE.case_id}.json`), JSON.stringify(THREE));
    const files = readEventFiles(dir, EVENT);
    expect(Object.fromEntries(files.map((f) => [f.name, f.replies]))).toEqual({ [`${FIVE.case_id}.json`]: BANK5, [`${THREE.case_id}.json`]: undefined });
    expect(ids(eventPool(EVENT, files))).toEqual([FIVE.case_id]);
    expect(readEventFiles(dir, 'NOPE-2026')).toEqual([]);
  });
});
