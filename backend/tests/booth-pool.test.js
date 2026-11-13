// An event's pool holds one step count (spec #370, #386), and a record that judges a tree admits only the tree its
// hash names (#468, #470).
const fs = require('fs');
const path = require('path');
const { isAdmitted, eventPool } = require('../src/booth-cases/tree-schema');
const { treeSha } = require('../src/booth-cases/tree-sha');
const { stamped } = require('./helpers/booth-tree');

const read = (file) => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
const THREE = stamped({ ...read('fixtures/booth-case-tree.json'), path_score_table: read('fixtures/booth-path-score-table.json') });
const FIVE = stamped({ ...read('fixtures/booth-case-tree-5.json'), path_score_table: read('fixtures/booth-path-score-table-5.json') });
const EVENT = THREE.event_code;
const file = (k) => ({ name: `${k.case_id}.json`, raw: k });
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
    const dir = path.join(__dirname, '../src/booth-cases/NFCME-2026');
    const pool = eventPool('NFCME-2026', fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((name) => ({ name, raw: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) })));
    expect(pool.steps).toBe(5);
    expect(pool.cases.filter((k) => !k.banks.step5).map((k) => k.case_id)).toEqual([]);
    expect(pool.left.find((l) => l.name === 'dka-young-adult.json')?.why).toBe('is a three-step case in a five-step event');
  });
});
