-- db/migration-message-superseded-draft.sql
-- Streamed chat replies (physician-ui ↔ backend ↔ rimpl server-sent events, setting `chat_streaming`).
--
-- WHY. With streaming the physician watches the first draft of a reply arrive BEFORE the post-checks
-- run. When one fails (missing citation / ❓, or an English reply to a Thai question), rimpl's single
-- corrective retry replaces the draft on screen. `content` keeps the reply that stood, as always; these
-- columns keep the draft the physician also read, and which check replaced it, because the transcript is
-- scored evidence under CREC082 and the record should say what was shown. A rescue turn is never
-- streamed, so a rescue rewrite never lands here.
--
-- NOT READ by the evaluator, the auditor view or the physician: they select explicit columns.
--
-- ORDER: deploy the backend first, then apply this. Until it is applied the backend logs
-- "[stream] messages.superseded_draft missing" (throttled) and the turn is unaffected.
-- Additive + nullable; safe to re-run.

alter table public.messages
  add column if not exists superseded_draft text,
  add column if not exists superseded_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_superseded_reason_check') then
    alter table public.messages add constraint messages_superseded_reason_check
      check (superseded_reason is null or superseded_reason in ('citation', 'language', 'rescue'));
  end if;
end $$;

comment on column public.messages.superseded_draft is
  'Assistant rows only: a streamed first draft the physician saw before the corrective retry replaced it (content holds the reply that stood). NULL when nothing was replaced or the turn was not streamed.';
comment on column public.messages.superseded_reason is
  'Which post-check replaced superseded_draft: citation | language | rescue (rescue is never streamed today).';
