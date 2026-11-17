// #511: a build re-checks only the cases it builds, against the pool as it stands then. A later build that moves the pool
// medians can leave an admitted case outside its band with nothing to see it (copd at ab8aaba1: best 62 against a
// median of 54 ± 7.42 once the pool held the eight final tables). This re-runs the re-check over every committed
// five-step table, for free, and holds every admitted case to it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isAdmitted } = require('../src/booth-cases/tree-schema');

const TOOL = path.join(__dirname, '..', '..', 'scripts', 'booth', 'recheck-committed.mjs');
const DIR = path.join(__dirname, '..', 'src', 'booth-cases', 'NFCME-2026');

test('every admitted NFCME-2026 case passes the re-check against the pool of all committed five-step tables, or holds a table waiver for its table (#511)', () => {
  const raws = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  const report = JSON.parse(execFileSync(process.execPath, [TOOL, '--cases', DIR], { encoding: 'utf8' }));
  const admitted = raws.filter(isAdmitted);
  expect(admitted.length).toBeGreaterThan(0);
  const failing = admitted.filter((raw) => {
    const waived = raw.admission.table_waiver?.run_id === raw.path_score_table.provenance.run_id;
    return !waived && !report.cases[raw.case_id]?.pass;
  }).map((raw) => [raw.case_id, report.cases[raw.case_id]?.reasons ?? ['its table is not bound to its tree']]);
  expect(failing).toEqual([]);
});
