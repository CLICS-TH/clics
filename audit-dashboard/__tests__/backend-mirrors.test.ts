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
import { REPORT_REASON, REPORTED_REPLY_SIGNAL } from '@/lib/report-reasons';
import { EVALUATOR_LOCK_BLOCKERS } from '@/lib/types';
import { BLOCKER_COPY, DECODING_FIELDS, LOCK_NOTE, LOCK_REASON, NOTE_MAX, POST_ERROR_TITLE, TEXT_FIELDS, UNBOUND_COPY } from '@/lib/evaluator-lock';

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

  it('REPORT_REASON labels exactly the reasons the report endpoint accepts', () => {
    // A reason the API takes and this page cannot name would render as a raw key in the safety queue.
    expect(Object.keys(REPORT_REASON)).toEqual(stringArray(schemas, 'REPORT_REASONS'));
    for (const r of Object.values(REPORT_REASON)) {
      expect(r.th.trim().length).toBeGreaterThan(0);
      expect(r.en.trim().length).toBeGreaterThan(0);
    }
  });

  it('the reported-reply signal is the one the backend writes', () => {
    const scan = fs.readFileSync(path.join(REPO, 'backend', 'src', 'services', 'integrity-scan.js'), 'utf8');
    const m = /const REPORTED_REPLY_SIGNAL = '([A-Z0-9_]+)'/.exec(scan);
    if (!m) throw new Error('REPORTED_REPLY_SIGNAL not found in integrity-scan.js — did the declaration change shape?');
    expect(REPORTED_REPLY_SIGNAL).toBe(m[1]);
  });
});

// ---- The Model Lock (CCME R2, #75) ------------------------------------------------------------------
// The declaration form, the blocker vocabulary, the POST refusals and the lock reasons the readiness
// screen names are all copies of backend/src/routes/superadmin.js and backend/src/services/model-lock.js.
//
// The form's fields mirror ModelLockSchema, which predates PR 6b and is unchanged by it, so that pin
// always runs. Everything else exists only from 6b (#159) on. On a checkout without
// services/model-lock.js the 6b assertions cannot run, and rather than pass vacuously the test then
// asserts the tree really IS pre-6b — so a 6b that landed and moved a file fails loudly instead of being
// skipped. CLICS_BACKEND_ROOT points this block at another checkout (e.g. a master that has 6b).
describe('Model Lock mirrors of back-end vocabulary', () => {
  const ROOT = process.env.CLICS_BACKEND_ROOT || REPO;
  const superadmin = fs.readFileSync(path.join(ROOT, 'backend', 'src', 'routes', 'superadmin.js'), 'utf8');
  const lockSvcPath = path.join(ROOT, 'backend', 'src', 'services', 'model-lock.js');
  const has6b = fs.existsSync(lockSvcPath);
  const lockSvc = has6b ? fs.readFileSync(lockSvcPath, 'utf8') : '';

  // `const ModelLockSchema = z.object({ ... });` — top-level keys at two spaces, decoding's at four.
  const schema = (() => {
    const m = /const ModelLockSchema = z\.object\(\{\n([\s\S]*?)\n\}\);/.exec(superadmin);
    if (!m) throw new Error('ModelLockSchema not found in superadmin.js — did the declaration change shape?');
    return m[1];
  })();
  const topLines = schema.split('\n').filter((l) => /^ {2}\w+:/.test(l));
  const top = topLines.map((l) => /^ {2}(\w+):/.exec(l)![1]);
  const decoding = (/decoding: z\.object\(\{\n([\s\S]*?)\n {2}\}\)/.exec(schema)?.[1] ?? '')
    .split('\n').map((l) => /^ {4}(\w+):/.exec(l)?.[1]).filter(Boolean);

  it('the form sends exactly the fields ModelLockSchema accepts', () => {
    expect([...TEXT_FIELDS.map((f) => f.key), 'decoding', 'environment', 'note', 'confirm_relock'].sort()).toEqual([...top].sort());
    expect(DECODING_FIELDS.map((f) => f.key)).toEqual(decoding);
  });

  it('the fields the form requires are the ones the schema requires', () => {
    const required = topLines.filter((l) => !/\.optional\(\)/.test(l) && !/z\.object\(/.test(l)).map((l) => /^ {2}(\w+):/.exec(l)![1]);
    expect(TEXT_FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual(required);
    // The digest is 64 hex characters on both sides, and the note limit is the server's.
    expect(topLines.find((l) => l.startsWith('  weights_sha256:'))).toContain('[0-9a-fA-F]{64}');
    expect(topLines.find((l) => l.startsWith('  note:'))).toContain(`.max(${NOTE_MAX})`);
    expect(/max_tokens: z\.number\(\)\.int\(\)/.test(schema)).toBe(true);
    expect(/seed: z\.number\(\)\.int\(\)\.nullable\(\)/.test(schema)).toBe(true);
  });

  if (!has6b) {
    it('this checkout predates PR 6b, so the 6b vocabulary pins below cannot run here', () => {
      // Not a skip: if 6b's GET is here and its service file is not, something moved.
      expect(superadmin).not.toMatch(/blockers\.push\(/);
    });
    return;
  }

  it('every blocker GET /admin/evaluator-lock can send is typed and has bilingual copy', () => {
    const sent = new Set<string>();
    for (const call of superadmin.matchAll(/blockers\.push\(([^)]*)\)/g)) {
      for (const q of call[1].matchAll(/'([a-z_]+)'/g)) sent.add(q[1]);
    }
    expect(sent.size).toBeGreaterThan(5);
    expect([...sent].sort()).toEqual([...EVALUATOR_LOCK_BLOCKERS].sort());
    for (const b of EVALUATOR_LOCK_BLOCKERS) {
      expect(BLOCKER_COPY[b].th.trim().length).toBeGreaterThan(0);
      expect(BLOCKER_COPY[b].en.trim().length).toBeGreaterThan(0);
    }
  });

  it('every refusal POST /admin/evaluator-lock can send has a title', () => {
    const post = /router\.post\('\/evaluator-lock'[\s\S]*?\n\}\);/.exec(superadmin)?.[0];
    if (!post) throw new Error("router.post('/evaluator-lock') not found — did the route change shape?");
    const codes = new Set([...post.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]));
    // Bodies the handler returns from helpers: rollbackIncomplete in superadmin.js, and model-lock.js's
    // error bodies MINUS the two only PATCH /admin/ai-providers sends.
    codes.add(/code: '(rollback_incomplete)'/.exec(superadmin)![1]);
    for (const m of lockSvc.matchAll(/code: '([a-z_]+)'/g)) if (!['use_model_lock', 'saved_state_unreadable'].includes(m[1])) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(10);
    expect([...codes].filter((c) => !POST_ERROR_TITLE[c])).toEqual([]);
  });

  it('every lock reason and note the readiness screen can receive has words', () => {
    const reasons = [...lockSvc.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]);
    const notes = [...lockSvc.matchAll(/\.note = '([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(3);
    expect([...new Set(reasons)].sort()).toEqual(Object.keys(LOCK_REASON).sort());
    expect(notes).toEqual(Object.keys(LOCK_NOTE));
  });

  it('every lock-record state /admin/ai-providers reports has its own sentence', () => {
    const states = new Set<string>();
    for (const m of lockSvc.matchAll(/record: ([^,}\n]*)/g)) for (const q of m[1].matchAll(/'([a-z_]+)'/g)) states.add(q[1]);
    expect([...states].sort()).toEqual(Object.keys(UNBOUND_COPY).sort());
  });
});

