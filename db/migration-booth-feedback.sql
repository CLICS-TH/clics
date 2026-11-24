-- Booth feedback (ADR 0015): the anonymous post-play survey. One row per answer sheet.
--
-- The owner applies this BEFORE the backend deploy: the backend's POST /booth/feedback inserts into this table.
-- Idempotent.
--
-- The table has NO time column on purpose (ADR 0015): only the date (Asia/Bangkok), so an answer cannot be matched to
-- a play by the time it was sent. It also has no tag, no play id and no player reference. The id is a v4 uuid, which
-- carries no time.

create table if not exists public.booth_feedback (
  id uuid primary key default gen_random_uuid(),
  event_code text not null,
  case_id text,
  form text not null,
  -- The backend sets this; the default is a backstop.
  submitted_on date not null default ((now() at time zone 'Asia/Bangkok')::date),
  answers jsonb not null,
  -- rimpl's de-identified copy, never the text as typed. Null when the visitor left none.
  comment text
);

create index if not exists booth_feedback_event_date_idx on public.booth_feedback (event_code, submitted_on);

-- DENY-ALL (RLS on, no policy): only the backend's service role reads or writes booth feedback.
alter table public.booth_feedback enable row level security;

comment on table public.booth_feedback is
  'Booth Mode anonymous feedback (ADR 0015): form version, the seven answers, an optional de-identified comment, the '
  'case id when it named a case of the event, and the Bangkok date. No tag, play id, timestamp, IP or device data. '
  'Purged with the event by scripts/booth/purge-event.mjs.';
