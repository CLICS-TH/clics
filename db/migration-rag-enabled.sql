-- Migration: make retrieval an explicit switch instead of a side effect of an empty table.
--
-- WHAT WAS HAPPENING. services/rag.js ran on EVERY physician chat turn with no flag and no
-- short-circuit: it embedded the turn through the `embed` provider, then queried `match_documents`.
-- In production `documents` holds 0 rows, so the query could never return anything — while
-- `ai_provider_embed = 'openai'` meant each turn still paid a round trip to api.openai.com. Every
-- one of those calls was pure waste.
--
-- WHY IT MATTERS BEYOND WASTE. The revised CREC082 submission set declares "local open-weight AI and
-- no commercial external AI/API for research transcripts", in four attachments and the instruction
-- sheet. routes/chat.js de-identifies before calling (rag.js's header forbids a second strip site),
-- so this was a CONFORMANCE GAP, not a PII leak — but "does CLICS send transcript text to a third
-- vendor?" must have an answer an auditor can read off a setting, not one that depends on whether a
-- table happens to be empty this month.
--
-- WHY 0/1 IN `value` RATHER THAN value_text. app_settings.value is `numeric not null` and this is a
-- boolean; value_text exists for names and timestamps (see migration-provider-switch.sql). rimpl
-- reads it through provider-settings.NUMBER_KEYS in the same round trip as the provider overrides —
-- no second query, no second cache that can go stale differently.
--
-- SEEDED FROM REALITY, NOT FROM A PREFERENCE. A deployment whose corpus has rows was getting real
-- retrieval, and this migration must not silently take that away; one whose corpus is empty was
-- getting nothing but the bill. So the seed is 1 where `documents` is non-empty and 0 where it is
-- not. On production today that evaluates to 0.
--
-- Idempotent. Safe to apply before the rimpl that reads it: an absent row already means OFF, so the
-- only thing this migration changes for an empty-corpus deployment is that the setting becomes
-- visible and flippable rather than implicit.

insert into app_settings (key, value)
select 'rag_enabled', case when exists (select 1 from documents) then 1 else 0 end
where not exists (select 1 from app_settings where key = 'rag_enabled');

-- Report what it resolved to, so applying it is not a silent operation.
select key, value as rag_enabled,
       (select count(*) from documents) as documents_rows
from app_settings where key = 'rag_enabled';
