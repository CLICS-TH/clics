# RAG rollout checklist

Prepared 2026-09-06 from source at `afaf012`; production state was not queried and nothing here has
been deployed. This rollout stays separate from the D3 backend Docker builder change.

## Defect fixed before rollout

`db/migration-rag-enabled.sql` stores `rag_enabled` as numeric `app_settings.value`. RIMPL previously
selected only `value_text`, so a non-empty corpus seeded to `1` still behaved as OFF. A stale
`value_text='1'` could also override a numeric rollback to `0`. The accompanying fix selects both
columns and accepts only numeric `0` or `1` for this key. `local_ai_min_context` retains its existing
positive-`value_text` contract.

Hermetic regression coverage verifies these cases through the real settings cache, AI readiness and
RAG lookup seam: numeric 1 enables retrieval and exposes the selected embedding provider's readiness;
numeric 0, missing or malformed values keep retrieval OFF without probing embeddings; a refreshed
1→0 disables it. No real database, embedding vendor, transcript or paid API is used.

## Before applying SQL

- [ ] Merge and deploy the numeric-reader fix to the current Railway RIMPL first. Applying the SQL
  before that code is safe for an empty corpus but cannot enable retrieval correctly for a non-empty
  corpus.
- [ ] Confirm the deployment is still Railway RIMPL and record its deployment ID. Do not combine
  this rollout with the backend Dockerfile/D3 cutover.
- [ ] Query only counts and the setting, never document contents:

```sql
select count(*) as documents_rows from documents;
select key, value, value_text from app_settings where key = 'rag_enabled';
```

- [ ] If a row already exists with a value outside `0,1`, stop and resolve it explicitly. The
  idempotent migration preserves existing rows; it does not repair malformed historical values.
- [ ] For a non-empty corpus, verify the intended embedding provider, key, model and vector dimension
  match the stored documents. Enabling RAG with an incompatible embedding model invalidates nearest
  neighbour meaning even when `/health/deep` is green.

## Apply and verify

Run [migration-rag-enabled.sql](../db/migration-rag-enabled.sql) in the approved Supabase SQL editor.
It inserts one row only when absent: `1` if `documents` contains rows at that moment, otherwise `0`.
Its final query reports the resolved flag and document count. Re-running preserves the existing flag.

- [ ] Confirm the final migration result matches the preflight count.
- [ ] Wait longer than `PROVIDER_SETTINGS_TTL_MS` (default 15 seconds) or restart only RIMPL, then
  inspect `/health/deep`. With `rag_enabled=0`, no embedding dependency should appear. With `1`, the
  configured embedding provider must report ready; missing `OPENAI_API_KEY` causes degradation only
  when OpenAI is the selected embedding provider and RAG is enabled.
- [ ] With synthetic, de-identified text, verify chat still works. For an enabled, non-empty corpus,
  verify one known synthetic document can be retrieved without exposing raw transcript or document
  contents in logs. Do not use real patient data for the rollout smoke.
- [ ] Observe errors and latency before declaring the rollout complete. A successful migration alone
  proves neither embedding compatibility nor retrieval quality.

## Rollback

Disable retrieval without deleting data:

```sql
update app_settings set value = 0 where key = 'rag_enabled';
select key, value, value_text from app_settings where key = 'rag_enabled';
```

After cache expiry or a RIMPL restart, `/health/deep` must omit the embedding dependency and synthetic
chat must continue without an embedding call. Keep the row: absence is also OFF, but an explicit zero
is auditable and avoids reseeding from corpus contents on a later migration run.

If rollback is caused by a bad code deployment, restore the previous Railway RIMPL deployment and
retain `value=0` until the reader and embedding configuration are verified together. Do not switch
providers or move RIMPL on-prem as part of this rollback.
