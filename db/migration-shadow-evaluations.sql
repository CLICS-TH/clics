-- Migration: shadow evaluations — score every CLE twice, serve once.
--
-- WHY. CME credit is gated on AI↔human agreement (ICC ≥ 0.75), and CLICS_Proposal §10.2 requires a
-- LOCKED model+prompt+rubric for the pilot's duration. So the PIS-7 evaluator cannot simply be
-- pointed at the on-prem model to "see how it does" — that would split one study cohort across two
-- scoring systems and confound the primary outcome.
--
-- It also cannot be decided in advance: as of 2026-08-24 only NINE CLEs carry both an AI evaluation
-- and a human auditor score, and scripts/calibration/README.md already warns that at n≈30 pairs the
-- 95% CI is ~0.40–0.83. There is no corpus to judge a new evaluator with.
--
-- Shadow mode resolves both at once. The served score stays on the locked model and lands in
-- ai_evaluations exactly as today; a second, candidate evaluation runs fire-and-forget and lands
-- HERE, never shown to anyone. By the end of the pilot the same transcripts carry paired score sets
-- plus the human scores, which is what makes a real head-to-head ICC possible in November.
--
-- Safe to re-run. Additive: touches no existing table.

create table if not exists public.shadow_evaluations (
  id               uuid primary key default gen_random_uuid(),
  cle_id           uuid not null references public.cles(id) on delete cascade,

  -- Which system produced this candidate score. §10.2 provenance: recorded per row, never inferred
  -- from config at read time, because config changes and history must not.
  provider         text not null,
  -- NOT NULL and part of the identity below: `provider` is the TRANSPORT ('local'), not the
  -- candidate. Trialling a second candidate model on the same transport must accumulate a second
  -- paired set, not silently overwrite the first one's data.
  model_version    text not null,
  prompt_version   text,
  rubric_version   text,

  -- NULLABLE on purpose. A shadow run that failed to produce valid JSON is not missing data — it is
  -- the single most important measurement Gate 4 can take. "The candidate model could not hold the
  -- scoring contract 8% of the time" is a disqualifying result, and nulling it out would hide it.
  d1 smallint check (d1 between 0 and 5),
  d2 smallint check (d2 between 0 and 5),
  d3 smallint check (d3 between 0 and 5),
  d4 smallint check (d4 between 0 and 5),
  d5 smallint check (d5 between 0 and 5),
  d6 smallint check (d6 between 0 and 5),
  d7 smallint check (d7 between 0 and 5),
  composite_score  numeric,
  domain_rationale jsonb,

  -- Diagnostics for the failure analysis: 'max_tokens' = truncated (needs a bigger ceiling),
  -- 'end_turn' = the model finished without ever emitting JSON (a compliance problem instead).
  stop_reason      text,
  error            text,
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer,
  evaluated_at     timestamptz default now(),

  -- One row per (CLE, candidate): a re-run of the SAME candidate replaces its earlier attempt, so
  -- the paired corpus stays 1:1 with ai_evaluations and cannot double-count a CLE in the ICC, while
  -- a DIFFERENT candidate gets its own row.
  unique (cle_id, provider, model_version),

  -- Backstop against a half-written row. The writer builds a full explicit column set on every path
  -- precisely so an upsert REPLACES rather than merges, but a partial payload would silently leave a
  -- previous attempt's scores beside a new error (or vice versa) — laundering the candidate's
  -- failure rate in the flattering direction on the one dataset a model-swap decision rests on.
  -- Scored xor failed, never both, never neither.
  constraint shadow_scored_xor_failed check ((error is null) = (d1 is not null)),
  constraint shadow_domains_all_or_none check (num_nonnulls(d1, d2, d3, d4, d5, d6, d7) in (0, 7))
);

create index if not exists shadow_evaluations_cle_idx      on public.shadow_evaluations(cle_id);
create index if not exists shadow_evaluations_provider_idx on public.shadow_evaluations(provider);

-- DENY-ALL (RLS on, no policies) — mirrors cle_pii_map.
--
-- This is a blinding control, not just hygiene. Auditors score CLEs blind; a second AI score visible
-- anywhere in the product would anchor them and corrupt the very ICC this table exists to measure.
-- Physicians must not see it either — it is not their credit-bearing score. Only the service role
-- (RIMPL writing, and the offline calibration harness reading) bypasses RLS.
alter table public.shadow_evaluations enable row level security;

comment on table public.shadow_evaluations is
  'Candidate PIS-7 scores from a non-serving model, recorded for calibration only. NEVER shown to auditors (blinding) or physicians (not their score). See docs/LOCAL-MODEL-ROADMAP.md Phase 5.';
