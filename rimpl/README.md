# rimpl — on-premise PII / AI middleware

The **RIMPL** layer (port **3003**, internal-only — no public domain). It is the **PII boundary**: the
backend hands it transcripts, RIMPL strips identifiers, calls cloud AI, and returns de-identified results.
This is the layer that keeps PII on-premise. Node **≥ 22**. Deployed to **Railway** (reachable only at
`rimpl.railway.internal:3003`).

See [../docs/architecture.md](../docs/architecture.md) and
[../docs/MIDDLEWARE-KNOWN-GAPS.md](../docs/MIDDLEWARE-KNOWN-GAPS.md) for the planned-vs-as-built picture.

## Run

```bash
npm install
cp .env.example .env      # SUPABASE_*, ANTHROPIC_API_KEY, INTERNAL_TOKEN (must match backend), PORT
npm run dev               # node --watch, port 3003  (npm start for no-watch)
npm test                  # jest --runInBand — includes adversarial PII-leak tests
```

Every request must carry the `x-internal-token` shared secret (matched against the backend's
`INTERNAL_TOKEN`). RIMPL has no user auth — it only talks to the backend.

## Layout

- `src/routes/` — `chat.js` (a chat turn: RAG + PII strip → Claude → citation/Socratic post-filter +
  retry), `evaluate.js` (PIS-7 d1–d7 evaluation of a finished session), `evaluate-criteria.js` (C1–C6
  screening signals).
- `src/services/` — `claude.js` (Anthropic SDK; **Claude-only today**, pinned to `claude-sonnet-4-6`),
  `pii-filter.js` (regex de-identification + pseudonyms), `post-filter.js` (citation + Socratic
  enforcement), `rag.js` (reference retrieval).
- `src/lib/` — **`prompts.js`** (the system prompts **and the authoritative PIS-7 rubric / scale anchors**),
  `transcript.js`, `parse.js`, `supabase.js`.

## Critical for maintainers

- **`src/lib/prompts.js` is the source of truth for the PIS-7 rubric.** The auditor scorer mirrors it in
  `audit-dashboard/lib/pis7-rubric.ts` — **change both together** or human raters and the AI evaluator
  drift apart (which corrupts ICC).
- **Known PII gap:** `pii-filter.js` masks labelled identifiers (names with a title/anchor, dates, HN,
  ward) but a **bare, unlabelled Thai surname** with no masked given name beside it (`ใจดี
  มาด้วยไข้`; next to a masked given name any word is taken for the surname since #224 unless it is on
  the short clinical allowlist in `src/services/pii-clinical-words.th.js`), or a **bare English name
  with no title** (`John Smith presented…`), can slip through. Mitigated by structured patient intake +
  physician guidance; the full reversible-pseudonym table is ROADMAP P2. Treat any change here as
  security-sensitive and run `npm test` (the PII-leak adversarial suite).
- **Reproducibility:** AI evaluations are tagged `CCME_LLM_v8.0`. If you change the pinned Claude model
  (`src/lib/provider-policy.js` `ANTHROPIC_MODEL`, which `services/providers/anthropic.js` sends),
  re-run the Tier-2 calibration sample for drift (pilot protocol — see [../docs/ROADMAP.md](../docs/ROADMAP.md)).
- **Model manifest (CCME R2):** `src/model-manifest.json` is GENERATED from the code — prompts, evaluator
  prompt versions, rubric, decoding defaults, router, thinking and provider policy — plus the declared
  target in `src/model-manifest.declared.json`. After changing any of those, run
  `node scripts/manifest/build.mjs` and commit the result; CI's `manifest` job fails otherwise.
  `/health/deep` reports drift against it (warn-only); `GET /manifest` (internal token) returns it with
  the live view. See [../scripts/manifest/README.md](../scripts/manifest/README.md).
- **Booth reply cache (#387), off by default:** `src/services/embed.js` embeds a typed booth answer's
  de-identified text in-process with a pinned local model (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, q8),
  never through an embedding API, and `src/lib/booth-cache.js` holds the guards that decide a reuse. The model is
  fetched only by `node scripts/fetch-embed-model.js` (into `models/`, gitignored; the Docker build runs it);
  at run time remote models are off. A reuse also needs `src/lib/booth-cache-calibration.json`, written by
  `scripts/booth/reply-cache-calibration.mjs --write` only from the committed pair set, with pairs of every kind
  and zero unsafe reuses, and bound to the sha256 of `booth-cache.js`: any edit to the guards switches reuse off
  until the pairs are run again. CI fails a record whose `pairs_sha` is not the committed pair set's. The
  switch-on order is in `db/migration-booth-reply-cache.sql`.
- **Local-only mode ([ADR 0012](../docs/adr/0012-on-prem-data-custody.md)), dormant:** `CLICS_LOCAL_ONLY=1`
  makes `services/ai.js` refuse every provider other than `local` (the on-prem evaluator) and `local-tutor`
  (the on-prem tutor), for every purpose, before any request: shadow, embed and `CHAT_FAILOVER_PROVIDER`
  included. A settings cache that has never been read refuses too, and the default becomes `local`. A
  refusal is a 503 `local_only_refused`; an on-prem tutor that is down under the mode is a 503
  `ai_unavailable` (no fail-over). `/health/deep` and `GET /health/mode` (memory only, no probe) report
  `local_only: on|off`. **The mode counts as on when either side is on:** the backend's provider switch
  hides and refuses every commercial provider when its own `CLICS_LOCAL_ONLY` is on, or rimpl's
  `/health/mode` says on, or that read fails. rimpl's variable is the one that refuses calls, so set it
  here first and give the backend the same value (the vm1 preflight refuses backend on with rimpl off).
- **The evaluator rule:** `ai_provider_evaluate` stays `anthropic` until the on-prem evaluator passes the
  decisive gate, and no participant starts before local-only mode is on.

Deploy: `railway up . --path-as-root --service rimpl --ci` (the local `rimpl/` dir is mis-linked to the
`backend` service — **always pass `--service rimpl`**). See [../docs/deployment.md](../docs/deployment.md).
