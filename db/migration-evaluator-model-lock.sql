-- Migration: the Primary Evaluator Model Lock, as a record rather than a blank form.
--
-- Scores already carry a configuration fingerprint — provider, model, decoding parameters as SENT,
-- and a declared weights checksum. What was missing is the DECLARATION: the parts a running system
-- cannot read for itself. A weights checksum is not obtainable over an inference API; neither is the
-- container image, the library set, or the quantization the operator chose. Those have to be stated
-- by a person with filesystem access, and until they are, the lock is an assertion rather than a
-- checkable fact.
--
-- A TABLE, NOT MORE SETTINGS KEYS. The change-control rule contemplates re-declaring after a
-- critical safety or security change, on condition that scoring stops and the data either side is
-- separated. That is a history, and settings keys have none: a re-declaration would overwrite the
-- record of what was frozen the first time, which is precisely the evidence the rule exists to
-- preserve. One row per declaration, append-only in practice.
--
-- app_settings.evaluator_locked_at stays the flag the provider-switch endpoint consults. This table
-- is the record BEHIND that flag, not a replacement for it.
--
-- Idempotent. Apply to prod Supabase BEFORE deploying the backend that writes it.

create table if not exists public.evaluator_model_lock (
  id                       uuid primary key default gen_random_uuid(),
  locked_at                timestamptz not null default now(),
  locked_by                uuid references public.professionals(id),

  -- What the system could have told us, recorded anyway so the row stands alone as evidence.
  provider                 text,
  model_version            text,

  -- What only a person with access to the box can state.
  weights_sha256           text not null,
  inference_engine         text not null,
  quantization             text,
  system_prompt_version    text not null,
  evaluator_prompt_version text not null,
  rubric_version           text not null,
  decoding                 jsonb,          -- temperature / top_p / max tokens / seed
  environment              jsonb,          -- container, OS, library versions

  -- The evidence that the declaration was ALLOWED: the decisive agreement verdict at the moment of
  -- locking. Without it, "was this frozen against a number that had cleared the bar?" is answerable
  -- only by reconstructing the corpus as it stood that day, which nobody will do.
  gate                     jsonb,
  note                     text
);

comment on table public.evaluator_model_lock is
  'One row per Primary Evaluator declaration. Append-only in practice: a re-declaration after a '
  'critical safety/security change adds a row, so the earlier frozen configuration stays on the '
  'record and data either side of the change can be separated.';

comment on column public.evaluator_model_lock.weights_sha256 is
  'Declared, not measured — a weights checksum is not readable over an inference API. Copied to '
  'app_settings.evaluator_weights_sha256 at declaration time and stamped onto every score from then '
  'on, so a score produced before the lock says so on its face.';

comment on column public.evaluator_model_lock.gate is
  'The decisive candidate-vs-human verdict at the moment of locking: threshold, estimate, interval '
  'and pair count. The proof that the freeze was permitted, kept beside the thing it permitted.';

create index if not exists evaluator_model_lock_locked_at_idx
  on public.evaluator_model_lock (locked_at desc);

-- Service-role only, like the other study-integrity tables: the backend bypasses RLS, and no client
-- role has any business reading or writing a lock record directly.
alter table public.evaluator_model_lock enable row level security;
drop policy if exists evaluator_model_lock_no_access on public.evaluator_model_lock;
create policy evaluator_model_lock_no_access on public.evaluator_model_lock for all using (false);
