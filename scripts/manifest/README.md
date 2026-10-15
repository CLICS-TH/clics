# Model manifest (CCME R2)

`rimpl/src/model-manifest.json` says which models, prompts, rubric, decoding, routing and thinking
policy this build of rimpl runs, and which deployment it is meant to run in. It is content-addressed
(`sha256`). It lives under `rimpl/src/` because the rimpl Dockerfile copies only `src`.

| Part | Where it comes from |
|---|---|
| `expected.code` | **Computed** from the code by `rimpl/src/lib/manifest.js`: the prompt labels and hashes, the evaluator `prompt_version` per provider, the rubric and weights, the decoding **code defaults** with the env var that can override each one, the consistency rule, the router, the thinking policy, the provider policy and the pinned Anthropic model. |
| `expected.declared` | **Hand-maintained** in `rimpl/src/model-manifest.declared.json`: the target deployment (the local evaluator and tutor model ids, the expected engine fingerprint, the provider intended for each purpose). It states an intent. It measures nothing. |
| `sha256` | sha256 of the canonical JSON of everything else: keys sorted recursively, array order kept, 2-space indent, LF, one trailing newline. |

```bash
node scripts/manifest/build.mjs            # regenerate after changing code or the declared file
node scripts/manifest/build.mjs --check    # CI runs this under env -i; exit 1 if the committed copy is stale
node --test scripts/manifest/*.test.mjs
```

The output depends only on the code and the declared file. It contains no timestamp, Node version or
env value. Code defaults are resolved against an empty env.

**Never put a URL, host, IP or key in the declared file.** Its values show up in the drift report on
the unauthenticated `/health/deep`, and the build refuses any string that looks like one.

## At runtime

`rimpl/src/services/manifest.js` loads the file at startup, verifies its sha256, and checks whether its
`expected.code` matches this build (`code_match`). On request it builds the **live** view:

- the provider per purpose, as env and `app_settings` resolve it;
- the configured model ids;
- the decoding values actually in effect;
- `num_ctx` and the thinking style;
- the model and `system_fingerprint` each local provider last reported on a real call.

It then reports the **drift** between the live view and the manifest:

- `GET /health/deep` (unauthenticated) gets
  `manifest: { sha256, claimed_sha256, file, code_match, drift }` plus a `checks.manifest` entry.
  - The check is **warn-only** (never `down`), because production runs every purpose on anthropic while
    the declared target is on-prem, so drift is expected until CCME R1 and R3 close.
  - Each drift entry is `{ key, expected, live }`, except where the live value is free text supplied by
    an operator or a server: a configured or reported model id, a `system_fingerprint`, or any string
    outside a fixed vocabulary. That entry is `{ key, expected, live_present, live_sha256_12 }` (the
    first 12 hex of the value's sha256), so the public endpoint says *that* it differs without printing
    the value.
  - Provider names, consistency modes, thinking styles, known engine names, numbers and `null` are
    printed as they are.
  - Base URLs never enter the live view, only present or absent.
- `GET /manifest` returns `{ manifest, sha256, claimed_sha256, file, code_match, live, drift }` with the
  **raw** values, behind the internal token, for the backend's evaluator-lock record (PR 6b).

In both, `sha256` is the **verified** content address. It is `null` unless the file is present and its
stored hash is the hash of its content. `file` is `present`, `missing` or `invalid`. The hash the file
states about itself is reported separately as `claimed_sha256`, so a hand-edited manifest is never
vouched for by the hash it carries. As defence in depth, every string in the live view and in the drift
also passes through a redaction that replaces anything shaped like a URL, a `host:port`, an IP, a
domain with a path, or a key.

An engine that has not been observed since boot does not count as drift: `live.last_seen` shows `null`
for it.

## Not yet

- Locking the manifest's sha256 into the evaluator-lock record: PR 6b.
- The dashboard view: PR 6c.
- An ed25519 signature: deferred.
- `shadow_evaluations` has no column for decoding, so a shadow row does not record the decoding it ran
  under. Shadow now sends the evaluator's `temperature: 0` and `max_tokens: 4096`; 6b can add the
  column.
- The criteria prompt has a label here (`prompts.criteria`) but nothing stamps it on a result yet.
  Neither the backend's criteria finalise nor the rescue classifier records classifier provenance.
