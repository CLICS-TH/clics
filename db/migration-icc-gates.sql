-- Migration: the two agreement thresholds a candidate evaluator must clear, as data.
--
-- They default to 0.75 in code, so the system behaves identically whether or not this is applied.
-- Seeding them anyway makes them DISCOVERABLE and adjustable: a threshold that exists only as a
-- literal is one nobody can review, and this pair is the number the whole evaluator-swap decision
-- turns on.
--
-- SCREENING is candidate-vs-incumbent. Runnable today, before a single human rater exists, and its
-- only job is to reject a candidate cheaply before anyone spends effort on it. Two models can agree
-- closely and both be wrong the same way, so it can never accept one.
--
-- DECISIVE is candidate-vs-human. The human raters are the reference standard, and nothing may be
-- frozen against a number that never touched a human judgement.
--
-- Idempotent, and safe to apply at any time.

insert into public.app_settings (key, value) values
  ('icc_gate_screening', 0.75),
  ('icc_gate_decisive',  0.75)
on conflict (key) do nothing;
