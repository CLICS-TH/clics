// A study snapshot is the part of one admitted case version that rebuilds a play's transcript for the auditor
// queue (#389): kept per version at <EVENT>/versions/<case_id>@<version>.json, append-only, so a play stays
// auditable after its case file moves to a new version. Its schema is lenient on purpose: a snapshot must outlive
// the admission schema and any change in the number of steps.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { z } = require('zod');
const { TIERS } = require('./tree-schema');

const SNAPSHOT_KEYS = ['case_id', 'event_code', 'version', 'teaser', 'vignette', 'banks'];
const FILE_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT = 'node scripts/booth/snapshot-case-versions.mjs';

const snapshotOf = (kase) => Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, kase[k]]));

/** Throws on a part that is not filename-safe: a snapshot is never written under an encoded name. */
function snapshotFile(dir, code, caseId, version) {
  const unsafe = Object.entries({ event_code: code, case_id: caseId, version })
    .find(([, v]) => typeof v !== 'string' || !FILE_SAFE.test(v));
  if (unsafe) throw new Error(`${unsafe[0]} ${JSON.stringify(unsafe[1])} cannot name a snapshot file: it must match ${FILE_SAFE}`);
  return path.join(dir, code, 'versions', `${caseId}@${version}.json`);
}

const Bilingual = z.object({ th: z.string(), en: z.string() });
const StudyBank = z.object({
  variants: z.array(z.object({ id: z.string(), question: Bilingual })).min(1),
  options: z.array(z.object({ id: z.string(), tier: z.enum(TIERS.map((t) => t.name)), label: Bilingual, line: Bilingual })),
});
const StudyCaseSchema = z.object({
  case_id: z.string(),
  event_code: z.string(),
  version: z.string(),
  teaser: Bilingual,
  vignette: Bilingual,
  // step1 is one bank; a later step is one bank, or banks keyed by the tier path so far or by the previous tier.
  banks: z.record(z.string().regex(/^step[1-9][0-9]*$/), z.union([StudyBank, z.record(z.string(), StudyBank)])),
}).refine(({ banks }) => {
  const keys = Object.keys(banks);
  return keys.every((k) => Number(k.slice('step'.length)) <= keys.length) && Array.isArray(banks.step1?.variants);
}, { message: 'banks must be step1 (one bank) through stepN, with no gap', path: ['banks'] });

/** The snapshot of one case version, parsed; null when there is none. A snapshot that is there but unreadable is
 *  logged, since its plays then leave the queue. */
function readStudyCase(dir, code, caseId, version) {
  let file;
  try { file = snapshotFile(dir, code, caseId, version); } catch { return null; }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[booth] study snapshot ${code}/versions/${caseId}@${version}.json is not readable JSON`);
    return null;
  }
  const parsed = StudyCaseSchema.safeParse(raw);
  const named = parsed.success && parsed.data.case_id === caseId && parsed.data.event_code === code && parsed.data.version === version;
  if (!named) console.warn(`[booth] study snapshot ${code}/versions/${caseId}@${version}.json left out: it is not a study snapshot of that version`);
  return named ? parsed.data : null;
}

/** Whether the snapshot of `kase` (a parsed, admitted case) is kept as derived from it, missing, or different. */
function snapshotState(dir, kase) {
  const file = snapshotFile(dir, kase.event_code, kase.case_id, kase.version);
  if (!fs.existsSync(file)) return { file, state: 'missing' };
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, state: isDeepStrictEqual(kept, snapshotOf(kase)) ? 'kept' : 'differs' };
}

const STATE_FIX = {
  missing: `has no study snapshot: run ${SCRIPT}`,
  differs: `has a study snapshot that differs from the case file: the case changed without a new version. Raise "version" in the case file, then run ${SCRIPT}. Never edit or delete a snapshot`,
};
const snapshotProblem = (kase, state) => `${kase.event_code}/${kase.case_id}@${kase.version} ${STATE_FIX[state]}`;

module.exports = { snapshotOf, snapshotFile, StudyCaseSchema, readStudyCase, snapshotState, snapshotProblem };
