-- db/migration-message-provenance.sql
-- Per-turn AI provenance: which provider and model produced each assistant message, under which
-- prompt (rimpl lib/versions.js promptLabel). Until now only ples.provider_used recorded a provider,
-- once per episode — which a hybrid or failed-over episode cannot state honestly, and which cannot
-- separate a before/after prompt edit at all. Needed before any local-vs-cloud quality comparison
-- of tutor replies (calibration + Thai-quality plan, Phase 1.4).
--
-- ORDER: apply THIS FIRST, then deploy the backend that writes the columns. They are additive and
-- nullable, so the currently deployed code (which never names them) is unaffected; the reverse order
-- would make every chat turn's insert fail on an unknown column.
-- Safe to re-run (idempotent). Pre-existing rows stay NULL: their provenance was never recorded and
-- must not be back-filled with a guess.
-- ===========================================================================

alter table public.messages
  add column if not exists provider       text,
  add column if not exists model          text,
  add column if not exists prompt_version text;

alter table public.audit_discussions
  add column if not exists provider       text,
  add column if not exists model          text,
  add column if not exists prompt_version text;

comment on column public.messages.provider is 'AI provider that produced this assistant turn (anthropic | local); NULL for physician turns and for rows written before 2026-10.';
comment on column public.messages.prompt_version is 'rimpl promptLabel of the system prompt actually sent, e.g. chat-prompt-1a2b3c4d.';
comment on column public.audit_discussions.provider is 'AI provider that produced this assistant turn; NULL for auditor turns and for rows written before 2026-10.';
