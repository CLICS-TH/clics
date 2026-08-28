// Front-end copies of back-end vocabulary, checked against the back-end file itself.
//
// Three lists are duplicated across the layers because the dashboard has no build step that could
// import from `backend/`: the per-assessment attestations, the anchor-clarity triple, and (for the
// anchors) a set of SQL CHECK constraints. Every one of them is enforced server-side, so drift does
// not show up as a type error — it shows up as a form the rater can complete and the API refuses,
// or a value the API accepts and Postgres rejects.
//
// The existing ATTESTATIONS test asserts against a hand-written list, which drifts if someone edits
// both sides. This reads the actual sources instead.
import fs from 'fs';
import path from 'path';
import { ATTESTATIONS } from '@/lib/pis7-rubric';
import { ANCHOR_CLARITY } from '@/components/DomainScorer';

const REPO = path.join(__dirname, '..', '..');
const SCHEMAS = path.join(REPO, 'backend', 'src', 'lib', 'schemas.js');
const MIGRATION = path.join(REPO, 'db', 'migration-auditor-assessment-form.sql');

// `const NAME = ['a', 'b', 'c'];` — the backend declares both lists in exactly this shape.
function stringArray(source: string, name: string): string[] {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`${name} not found in ${SCHEMAS} — did the declaration change shape?`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('front-end mirrors of back-end vocabulary', () => {
  const schemas = fs.readFileSync(SCHEMAS, 'utf8');

  it('reads the backend source at all', () => {
    // A silent read failure would make every assertion below vacuous.
    expect(schemas.length).toBeGreaterThan(100);
  });

  it('ATTESTATIONS matches the set the API re-validates, exactly and in order', () => {
    expect(ATTESTATIONS.map((a) => a.key)).toEqual(stringArray(schemas, 'SCORE_ATTESTATIONS'));
  });

  it('ANCHOR_CLARITY matches the enum the request schema accepts', () => {
    // The dashboard offers three buttons; the zod enum decides which of them the API will take.
    expect(ANCHOR_CLARITY.map((a) => a.value)).toEqual(stringArray(schemas, 'ANCHOR_CLARITY'));
  });

  it('ANCHOR_CLARITY matches the CHECK constraint the column carries', () => {
    // A third copy, in SQL. A value the API accepts and the column rejects fails at write time,
    // after the rater has submitted — the worst place of the three to find out. The migration
    // builds all seven constraints from one format() template, with SQL-doubled quotes.
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const m = /_anchor in \(([^)]*)\)/i.exec(sql);
    if (!m) throw new Error('the anchor CHECK template was not found — did the migration change shape?');
    const values = [...m[1].matchAll(/''([^']+)''/g)].map((x) => x[1]);
    expect(values).toEqual(ANCHOR_CLARITY.map((a) => a.value));

    // …and the template really is applied to all seven domains.
    const domains = /array\[([^\]]*)\]/.exec(sql);
    expect(domains && [...domains[1].matchAll(/'(d\d)'/g)].map((x) => x[1]))
      .toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
  });

  it('every anchor option gives both languages — a Thai-only rater must not get a blank', () => {
    for (const a of ANCHOR_CLARITY) {
      expect(a.th.trim().length).toBeGreaterThan(0);
      expect(a.en.trim().length).toBeGreaterThan(0);
    }
  });
});
