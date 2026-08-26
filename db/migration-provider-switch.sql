-- Migration: DB-backed, per-purpose AI provider switch (Claude ↔ on-prem Local), plus the
-- evaluator lock that freezes the scoring instrument for the pilot.
--
-- WHY a DB layer at all. Until now the provider was resolved from env only
-- (AI_PROVIDER_<PURPOSE> → AI_PROVIDER → 'anthropic'), so moving chat on-prem meant a Railway
-- variable change and a restart on the RIMPL service. That is fine for an engineer and useless for
-- the superadmin who actually owns the decision, and it leaves no record of WHO switched WHAT and
-- WHEN — which §10.2 provenance needs, because a score is only interpretable alongside the system
-- that produced it. Putting the override in app_settings makes the cutover a toggle, and makes every
-- flip an audit_log entry.
--
-- Resolution order after this migration:
--   app_settings.ai_provider_<purpose>  →  AI_PROVIDER_<PURPOSE>  →  AI_PROVIDER  →  'anthropic'
-- The DB layer sits ON TOP of env and fails SOFT: an unreachable database leaves the env value in
-- force. It must never fail soft to a hardcoded default — that would silently move PIS-7 scoring to
-- a different model during an outage.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend/rimpl that read these rows.

-- app_settings.value is `numeric not null` — it cannot hold a provider NAME or a timestamp. Rather
-- than encode providers as magic numbers (0=anthropic, 1=local), which stops being self-describing
-- the moment a third provider exists, add a nullable text column beside it. Existing numeric
-- settings and every existing reader are untouched: they never look at value_text.
alter table public.app_settings
  add column if not exists value_text text;

comment on column public.app_settings.value_text is
  'Text-valued settings (provider names, ISO timestamps). NULL for the numeric settings that '
  'predate this column. Readers pick the column their setting is typed as — value OR value_text.';

-- Per-purpose provider overrides. Seeded to 'anthropic', i.e. exactly today's behaviour: applying
-- this migration changes nothing until a superadmin deliberately flips a purpose.
-- `value` is set to 0 purely to satisfy the NOT NULL on the numeric column; nothing reads it.
--
-- NOTE the embed row is 'openai', NOT 'anthropic'. Anthropic has no embeddings API, so seeding
-- 'anthropic' here would make rimpl's embedText() throw on every retrieval; ragLookup swallows that
-- and returns no documents, so RAG would silently stop working with only a warn line to show for it.
-- Chat and scoring are unaffected, which is exactly what makes it easy to miss.
insert into public.app_settings (key, value, value_text) values
  ('ai_provider_chat',     0, 'anthropic'),
  ('ai_provider_evaluate', 0, 'anthropic'),
  ('ai_provider_criteria', 0, 'anthropic'),
  ('ai_provider_discuss',  0, 'anthropic'),
  ('ai_provider_embed',    0, 'openai')
on conflict (key) do nothing;

-- The evaluator lock. `evaluate` is not a preference — it is the measuring instrument, and CME credit
-- is gated on ICC ≥ 0.75 against it. Once the pilot's locked configuration is declared (§10.2), the
-- scoring model must not move, so setting this to an ISO timestamp makes the backend REFUSE any
-- further change to ai_provider_evaluate rather than merely warning about it. NULL = not yet locked.
insert into public.app_settings (key, value, value_text) values
  ('evaluator_locked_at', 0, null)
on conflict (key) do nothing;
