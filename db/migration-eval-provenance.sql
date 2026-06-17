-- db/migration-eval-provenance.sql
-- Phase 4 — Evaluator provenance (CLICS_Proposal §10.2): record the locked prompt + rubric version
-- alongside the existing model_version, so the reliability/stability check can detect silent drift.
-- Additive + idempotent.

begin;
alter table public.ai_evaluations add column if not exists prompt_version text;
alter table public.ai_evaluations add column if not exists rubric_version text;
commit;
