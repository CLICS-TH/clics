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

test('the re-check refuses committed tables built with different samples per path, whose bands differ', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'recheck-'));
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (raw.case_id === 'organophosphate') raw.path_score_table.provenance.samples_per_path = 1;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(raw));
  }
  let err;
  try { execFileSync(process.execPath, [TOOL, '--cases', dir], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { err = e; }
  fs.rmSync(dir, { recursive: true, force: true });
  expect(err).toBeDefined();
  expect(err.stderr).toMatch(/mix 3 and 1 samples per path|mix 1 and 3 samples per path/);
  expect(err.stderr).toMatch(/organophosphate 1/);
});
