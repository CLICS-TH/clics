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
  ward) but a **bare, unlabelled Thai surname** can slip through. Mitigated by structured patient intake +
  physician guidance; the full reversible-pseudonym table is ROADMAP P2. Treat any change here as
  security-sensitive and run `npm test` (the PII-leak adversarial suite).
- **Reproducibility:** AI evaluations are tagged `CCME_LLM_v8.0`. If you change the model in `claude.js`,
  re-run the Tier-2 calibration sample for drift (pilot protocol — see [../docs/ROADMAP.md](../docs/ROADMAP.md)).

Deploy: `railway up . --path-as-root --service rimpl --ci` (the local `rimpl/` dir is mis-linked to the
`backend` service — **always pass `--service rimpl`**). See [../docs/deployment.md](../docs/deployment.md).
