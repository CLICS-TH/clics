// Guards for the docs that tell people how to deploy around the vm1 cutover (#429, #488 review).
// Package-free: `node --test scripts/deploy/*.test.mjs`.
//
// From #429 on, physician-ui/vercel.json and audit-dashboard/vercel.json are redirects to
// https://clics.ccme.or.th. A Vercel deploy of this tree therefore moves every Portal and dashboard user to
// vm1, sign-in and the booth kiosk included, and before the cutover that origin is not live. So no doc may
// tell anyone to deploy a front end to Vercel unless the same paragraph or list item says so: before the
// cutover a Vercel deploy comes from a pre-#429 ref, and after it the front ends deploy to vm1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const ITEM = /^\s*(?:[-*+]|\d+\.)\s/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*```/;
const indent = (l) => l.length - l.trimStart().length;

// The paragraph, list item (without its nested items) or fenced block that holds line i.
export function unitAt(lines, i) {
  const fences = [];
  for (let j = 0, open = -1; j < lines.length; j++) {
    if (!FENCE.test(lines[j])) continue;
    if (open < 0) open = j; else { fences.push([open, j]); open = -1; }
  }
  const fence = fences.find(([a, b]) => i >= a && i <= b);
  if (fence) return lines.slice(fence[0], fence[1] + 1).join('\n');
  let start = i;
  while (!ITEM.test(lines[start]) && start > 0 && lines[start - 1].trim() && !HEADING.test(lines[start - 1])
    && !FENCE.test(lines[start - 1])) start--;
  const own = ITEM.test(lines[start]) ? indent(lines[start]) : Infinity;
  let end = i;
  while (end + 1 < lines.length && lines[end + 1].trim() && !HEADING.test(lines[end + 1]) && !FENCE.test(lines[end + 1])
    && !(ITEM.test(lines[end + 1]) && (own === Infinity || indent(lines[end + 1]) <= own + 2))) end++;
  return lines.slice(start, end + 1).join('\n');
}

// A sentence that sends a front end to Vercel: the CLI's production deploy, a present-tense deploy verb next to
// the platform's name, or "live on Vercel". `vercel.json` and `*.vercel.app` name a file and a host, not the
// platform; "a deploy of", "deploy time" are nouns, not instructions.
const CLI = /\b(?:npx\s+)?(?:vercel|vc)\s+(?:--prod|deploy|promote)\b/i;
const PLATFORM = /(?<![\w./-])vercel(?!\.(?:json|app)\b|[\w-])/i;
const VERB = /(?<!\b(?:a|an|the|any|each|every|this|that|newest|last)\s)\b(?:deploy|redeploy|ship|push|publish|promote)\b(?!\s+(?:time|freeze|of)\b)/i;
const NEAR = 80; // characters either side of the platform's name in which a deploy verb counts
export function sendsToVercel(sentence) {
  if (CLI.test(sentence) || /\blive on vercel\b/i.test(sentence)) return true;
  const g = new RegExp(PLATFORM.source, 'gi');
  for (let m = g.exec(sentence); m; m = g.exec(sentence)) {
    if (VERB.test(sentence.slice(Math.max(0, m.index - NEAR), m.index + NEAR))) return true;
  }
  return false;
}
// The caveat: the redirect's target, the pre-#429 ref, and vm1 as the front ends' home after the cutover.
export function carriesCaveat(unit) {
  return unit.includes('clics.ccme.or.th') && /\bpre-#429\b/.test(unit) && /\bvm1\b/.test(unit);
}

export function uncaveated(file, text) {
  const lines = text.split('\n');
  const out = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    if (!/vercel|\bvc\s/i.test(line)) return;
    const unit = unitAt(lines, i);
    if (seen.has(unit)) return;
    seen.add(unit);
    const sentences = unit.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?;])\s+/);
    if (sentences.some(sendsToVercel) && !carriesCaveat(unit)) out.push(`${file}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

const trackedMarkdown = () => execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean);

test('no tracked doc tells anyone to deploy a front end to Vercel without the #429 redirect caveat', () => {
  const files = trackedMarkdown();
  assert.ok(files.length > 20, 'git ls-files found the docs');
  const bad = files.flatMap((f) => uncaveated(f, read(f)));
  assert.deepEqual(bad, [], `these instructions deploy a #429+ tree to Vercel, which ships the redirect to clics.ccme.or.th:\n${bad.join('\n')}`);
});

test('the Vercel-instruction reader flags an uncaveated instruction and passes a caveated one', () => {
  assert.equal(uncaveated('x.md', 'Deploy: `vercel --prod --yes`.\n').length, 1);
  assert.equal(uncaveated('x.md', '- Push the dashboard to its Vercel project before the freeze.\n').length, 1);
  assert.equal(uncaveated('x.md', 'The booth only sees files that are live on Vercel.\n').length, 1);
  assert.equal(uncaveated('x.md', 'Then run `vc --prod` in each app.\n').length, 1);
  assert.equal(uncaveated('x.md', 'Publish the Portal through the Vercel CLI from master.\n').length, 1);
  assert.equal(uncaveated('x.md', '1. Merge.\n2. Deploy: `vercel --prod --yes`.\n3. Smoke: the redirect to clics.ccme.or.th is pre-#429 and vm1.\n').length, 1,
    'a caveat in a sibling item does not cover this one');
  assert.equal(uncaveated('x.md', 'Deploy: `vercel --prod --yes` from a pre-#429 ref only; this tree redirects to\n'
    + '`https://clics.ccme.or.th`, and after the cutover the front ends deploy to vm1.\n').length, 0);
  assert.equal(uncaveated('x.md', 'The prototype was deployed to Vercel in June.\n').length, 0, 'history is not an instruction');
});

// ---- the cutover runbook's step 4 names the owner steps the #429 PR body carried (#488 review) -------------
test('runbook cutover step 4 checks #487, the kiosk URL, the redirect period and a public front end first', () => {
  const md = read('deploy', 'vm1', 'README.md');
  const from = md.indexOf('4. **Move the users (owner).**');
  assert.ok(from >= 0, 'deploy/vm1/README.md has cutover step 4');
  const step = md.slice(from, md.indexOf('\n5. **Watch**', from));
  const before = step.slice(0, step.indexOf('In one sitting'));
  assert.ok(before.length < step.length, 'step 4 puts its checks before "In one sitting"');
  // (a) the booth service worker must stop caching same-origin /api before any kiosk runs on this origin.
  assert.match(before, /#487/);
  assert.match(before, /#491/);
  assert.match(before, /service worker/i);
  assert.match(before, /merged/i);
  // (b) the kiosk URL changes, and the booth spec's owner is told.
  assert.ok(before.includes('https://clics.ccme.or.th/booth'), 'names the new kiosk URL');
  assert.match(before, /#370/);
  // (c) the owner sets how long the Vercel redirects run.
  assert.match(before, /redirect period/i);
  // (d) the 2026-11-11 addendum: the front end is public on vm1, only the database and the models private.
  assert.match(before, /public on vm1/i);
  assert.match(before, /database/i);
  assert.match(before, /models/i);
  assert.match(before, /private/i);
});
