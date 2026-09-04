// Did the prompt that produced a probe report drift from the prompt in the working tree today?
//
// This lives in its own module for the same reason parseability.mjs does: it was inline in
// screening-verdict.mjs, and inline code cannot be tested. Inline, it was wrong in BOTH directions at
// once, and the only reason nobody caught it is that a warning which fires on every report reads as
// decoration:
//
//   const currentSha  = sha256(pis7PromptFor('local')).slice(0, 12);          // the ASSEMBLED prompt
//   const promptDrift = recorded && !recorded.includes(currentSha.slice(0, 8))
//                       && recorded !== agreement.prompt_version;
//
// 1. IT COMPARED TWO DIFFERENT DIGESTS. `pis7PromptFor('local')` is base + "\n\n" + addendum (6905
//    chars -> 6433003315e0). The `+local-XXXXXXXXXXXX` suffix that every report carries is sha256 of
//    the ADDENDUM ALONE (2264 chars -> c5ffe572aa81) — see rimpl/src/lib/versions.js promptVersionFor.
//    The substring test could therefore NEVER match, so the predicate collapsed into "this report used
//    the addendum" and fired on 7 of 7 addendum-ON reports: 4 genuinely stale, 3 exactly current. A
//    check with no discriminating power is worse than no check — it teaches the reader to skip the one
//    line that will someday be true.
//
// 2. IT WENT SILENT ON EXACTLY THE REPORTS A BASE-PROMPT EDIT WOULD INVALIDATE. The third clause,
//    `recorded !== agreement.prompt_version`, can only be true for a run that used the addendum, so an
//    addendum-OFF report could never warn at all. Edit the base rubric and every v0 baseline keeps its
//    stale label without a word.
//
// THE FIX: never re-derive a digest here. versions.js already produces the exact strings the reports
// were stamped with, so ask it for today's labels and compare WHOLE STRINGS. Equal or not — no
// prefixes, no substrings, no hashing. Nothing in this module knows what a sha looks like.
//
// The one structural question that remains is whether the RECORDED label carries the `+local-` marker.
// That is not a digest comparison; it answers "was the addendum on for this run", which decides which
// of the tree's two labels is the honest thing to compare against. It has to be asked, because
// `local_prompt_version` is present even when the addendum was OFF — promptVersionFor('local') returns
// the bare PROMPT_VERSION in that case, so "the field is present" does not mean "the addendum ran"
// (scripts/probe/report/tuning-agreement-v0.json records exactly `pis7-prompt-59561c29`). Keying on
// presence alone would warn on every addendum-off report: the same false alarm, pointed the other way.

/** The marker promptVersionFor appends when a local addendum was in play. Structural, not a digest. */
const LOCAL_MARKER = '+local-';

/** A usable provenance label, or null. An empty string is not a label — it is a missing one. */
const label = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * @param {object}      p
 * @param {string|null} p.recordedLocal  report.local_prompt_version — the label the RUN was stamped with
 * @param {string|null} p.recordedBase   report.prompt_version — the base label the RUN was stamped with
 * @param {string|null} p.treeLocal      promptVersionFor('local') in the working tree today
 * @param {string|null} p.treeBase       promptVersionFor() in the working tree today
 * @returns {{drift:boolean, recorded:string|null, tree:string|null}}
 *   `recorded` and `tree` are the two labels actually compared, so the caller can print BOTH and let a
 *   human read what changed instead of a bare sha. `recorded: null` means the report predates version
 *   recording — there is nothing to compare, which is not the same as agreeing.
 */
export function promptDrift({ recordedLocal, recordedBase, treeLocal, treeBase } = {}) {
  const rl = label(recordedLocal), rb = label(recordedBase);
  const usedAddendum = rl != null && rl.includes(LOCAL_MARKER);
  const recorded = usedAddendum ? rl : (rb ?? rl);
  const tree = label(usedAddendum ? treeLocal : treeBase);
  // Nothing recorded, or no tree label to compare it against: say nothing rather than guess.
  if (recorded == null || tree == null) return { drift: false, recorded, tree };
  return { drift: recorded !== tree, recorded, tree };
}
