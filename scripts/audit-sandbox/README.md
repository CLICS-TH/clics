# Adversarial audit sandbox

```bash
npm run test:audit-sandbox              # every mutation
node scripts/audit-sandbox/run.mjs rescue privacy   # only ids containing these
node scripts/audit-sandbox/run.mjs --list
```

## Why

A green suite proves the tests pass. It does not prove they would **fail** if the thing they guard
were removed. This repo has shipped three defects that a fully green suite watched go by:

| Defect | Why the suite stayed green |
|---|---|
| `text-danger` rendered as plain body text | the test asserted the **class name**, which is present whether or not the token resolves |
| the Socratic rescue reverted to the examiner prompt at round nine | the test asserted `rescue === null` while its comment claimed the prompt stayed in force |
| three admin screens 404'd in production | every route test builds its own express app and picks its own mount prefix, so the right and the wrong prefix were both green |

So this runs the other direction. Each entry in `mutations.mjs` names one protective line and one
suite, deletes or corrupts the line, and demands the suite go red.

| Verdict | Meaning |
|---|---|
| `KILLED` | the suite caught it. The guard is real. |
| `SURVIVED` | the suite stayed green with the protection gone. **A finding.** |
| `STALE` | the pattern no longer matches the source. Also a finding — a mutation nobody can apply is a guard nobody is checking. |

Exit code is non-zero if anything survived or went stale.

## Safety

Every edit is reverted in a `finally` block, the run **refuses to start** against a file with
uncommitted changes, and the tree is verified clean again before exit. A crash cannot leave a
mutation behind, and a mutation can never be confused with your own work in progress.

## Adding a guard

Add it to `mutations.mjs` in the same movement as the guard itself. A guard that is not in this
table has not been shown to guard anything.

```js
{
  id: 'area/what-it-protects',
  why: 'One sentence: what breaks in the real world if this line goes.',
  file: 'backend/src/routes/thing.js',
  find: "  if (somethingImportant) {",   // must match EXACTLY ONCE
  replace: "  if (false) {",
  dir: 'backend',
  suite: 'tests/thing.test.js',
}
```

Two things the first run of this sandbox got wrong, both worth copying as warnings:

- **Name the suite that covers the call site, not the concept.** `pii-leak-adversarial.test.js`
  exercises `stripPii` as a pure function; deleting the call from the route left it green. The suites
  that actually catch it are `chat.test.js` and `rag-pii.test.js`.
- **Make sure the mutation can fail.** Removing `if (!token) return next();` looks like it disables
  the dev carve-out, but with no header sent `undefined !== undefined` is false, so behaviour is
  unchanged. The mutation surviving meant the *test* was weak — it only omitted the header. It now
  sends a garbage one.
