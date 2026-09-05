// Tests for the prompt-provenance drift check.
//
// Every case below is a real report in scripts/probe/report/ or a real failure the inline version of
// this check produced on 2026-09-04. Inline, it was broken in both directions at once: it fired on all
// 7 addendum-ON reports (4 stale, 3 current — zero discriminating power) and could never fire on an
// addendum-OFF one. The literals here are the actual labels those reports carry, so if versions.js
// changes shape these tests are the thing that notices. Run with:
//   node --test 'scripts/probe/*.test.mjs'   (the bare-directory form does not resolve here)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptDrift } from './prompt-drift.mjs';

// The working tree on 2026-09-04, straight from rimpl/src/lib/versions.js promptVersionFor.
const TREE_LOCAL = 'pis7-prompt-59561c29+local-c5ffe572aa81';
const TREE_BASE = 'pis7-prompt-59561c29';
// The addendum before it was re-punctuated to kill the quoting hazard — 4 reports still carry this.
const STALE_LOCAL = 'pis7-prompt-59561c29+local-cae23b1a5f37';

const tree = { treeLocal: TREE_LOCAL, treeBase: TREE_BASE };

test('a run made under TODAY\'s addendum is quiet — the false alarm this replaces', () => {
  // report/heldout-c5ffe-adaptive.json. The old check hashed the ASSEMBLED prompt (6905 chars ->
  // 6433003315e0) and looked for that in a label carrying a digest of the ADDENDUM ALONE
  // (2264 chars -> c5ffe572aa81), so it warned about a run whose prompt is byte-identical to the tree's.
  const r = promptDrift({ recordedLocal: TREE_LOCAL, recordedBase: TREE_BASE, ...tree });
  assert.equal(r.drift, false);
});

test('a run made under a SUPERSEDED addendum still warns', () => {
  // report/tuning-agreement-addendum.json, noise-*-addendum.json, noise-*-noaddendum.json,
  // tuning-agreement-median3.json. These four are genuinely stale; the ICC 0.735 they produced is not
  // comparable to a c5ffe run, and this line is the only thing that says so.
  const r = promptDrift({ recordedLocal: STALE_LOCAL, recordedBase: TREE_BASE, ...tree });
  assert.equal(r.drift, true);
  assert.deepEqual([r.recorded, r.tree], [STALE_LOCAL, TREE_LOCAL]);
});

test('an addendum-OFF run warns when the BASE prompt changed — the false negative', () => {
  // The old third clause (`recorded !== agreement.prompt_version`) is only ever true for an
  // addendum-ON run, so editing the base rubric left every v0 baseline silently mislabelled.
  const r = promptDrift({
    recordedLocal: 'pis7-prompt-aaaaaaaa', recordedBase: 'pis7-prompt-aaaaaaaa',
    treeLocal: 'pis7-prompt-bbbbbbbb+local-c5ffe572aa81', treeBase: 'pis7-prompt-bbbbbbbb',
  });
  assert.equal(r.drift, true);
  assert.deepEqual([r.recorded, r.tree], ['pis7-prompt-aaaaaaaa', 'pis7-prompt-bbbbbbbb']);
});

test('an addendum-OFF run is quiet when the base prompt is unchanged', () => {
  // report/tuning-agreement-v0.json. Note what it records: local_prompt_version is PRESENT and equal
  // to the bare base, because promptVersionFor('local') returns PROMPT_VERSION when the addendum is
  // off. Keying on "the field is present" would compare it to TREE_LOCAL and warn on every such run.
  const r = promptDrift({ recordedLocal: TREE_BASE, recordedBase: TREE_BASE, ...tree });
  assert.equal(r.drift, false);
  assert.equal(r.tree, TREE_BASE, 'an addendum-off run is judged against the tree BASE label');
});

test('a report that recorded nothing is quiet — no comparison is not agreement', () => {
  // report/ctx-2026-09-02.json predates version recording. Guessing here is what produced the
  // 2026-09-02 bug in the first place: a pre-addendum baseline stamped with the addendum's sha.
  const r = promptDrift({ recordedLocal: null, recordedBase: null, ...tree });
  assert.equal(r.drift, false);
  assert.equal(r.recorded, null, 'the caller must be able to say "unrecorded", not print a guess');
});

test('an 8-char digest prefix in common is NOT a match — the substring bug, pinned', () => {
  // The exact shape the old `recorded.includes(currentSha.slice(0, 8))` would wave through: two
  // different addenda whose digests happen to share their first 8 hex chars. Whole-string equality
  // is the only test that survives this; a prefix test reports "same prompt" for a different prompt.
  const twinPrefix = 'pis7-prompt-59561c29+local-c5ffe572bbbb';
  assert.ok(twinPrefix.includes(TREE_LOCAL.slice(-12).slice(0, 8)), 'the fixture really does share 8 chars');
  assert.equal(promptDrift({ recordedLocal: twinPrefix, recordedBase: TREE_BASE, ...tree }).drift, true);
});

test('an addendum removed from the tree warns, though each label contains the other', () => {
  // recorded = 'pis7-prompt-59561c29+local-c5ffe572aa81', tree = 'pis7-prompt-59561c29'. A substring
  // test in EITHER direction calls this a match; the run really did score under a prompt the tree no
  // longer builds.
  const r = promptDrift({ recordedLocal: TREE_LOCAL, recordedBase: TREE_BASE, treeLocal: TREE_BASE, treeBase: TREE_BASE });
  assert.equal(r.drift, true);
  assert.deepEqual([r.recorded, r.tree], [TREE_LOCAL, TREE_BASE]);
});

test('both labels come back in full so the note can print them, not a bare sha', () => {
  // The old note printed "the working tree now holds 6433003315e0" — a digest that appears in no
  // report, no prompt-versions.md row, and nowhere in versions.js. It was unactionable even when true.
  const r = promptDrift({ recordedLocal: STALE_LOCAL, recordedBase: TREE_BASE, ...tree });
  assert.equal(typeof r.recorded, 'string');
  assert.equal(typeof r.tree, 'string');
  assert.ok(r.recorded.startsWith('pis7-prompt-') && r.tree.startsWith('pis7-prompt-'));
});

test('a missing tree label is quiet — there is nothing to compare against', () => {
  const r = promptDrift({ recordedLocal: TREE_LOCAL, recordedBase: TREE_BASE, treeLocal: null, treeBase: null });
  assert.equal(r.drift, false);
});

test('an empty string is a missing label, not a label that differs', () => {
  assert.equal(promptDrift({ recordedLocal: '', recordedBase: '', ...tree }).drift, false);
  assert.equal(promptDrift({ recordedLocal: '', recordedBase: '', ...tree }).recorded, null);
});

test('recordedBase alone is compared to the tree base', () => {
  // report/tuning-repeat-v0.json shape: prompt_version recorded, local_prompt_version absent.
  assert.equal(promptDrift({ recordedLocal: null, recordedBase: TREE_BASE, ...tree }).drift, false);
  assert.equal(promptDrift({ recordedLocal: null, recordedBase: 'pis7-prompt-deadbeef', ...tree }).drift, true);
});
