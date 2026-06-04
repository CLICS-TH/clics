# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CLICS** (Clinical Learning & Intelligence Credit System) is an AI-mediated platform for assessing physician clinical reasoning in Continuing Medical Education (CME/CPD). It replaces attendance-based credits with evidence of cognitive engagement captured from physician–AI dialogue sessions called **PLEs** (Professional/Clinical Learning Episodes).

This is an on-premise pilot system for a Thai medical licensing body. The pilot runs July–September 2026 with ~75 physicians completing 3 PLEs each.

---

## Planned Architecture (4-Layer, On-Premise)

```
Browser / Mobile
       │  HTTPS · JWT Auth · REST API (port 3001)
       ▼
L1  Frontend — HTML/JS (port 3000) + Next.js Audit Dashboard (port 3002)
       │  Login · PLE Editor · Dashboard · Audit Sliders · LPDP Charts
       ▼
L2  Backend — Node.js/Express (port 3001) + Supabase SDK
       │  Auth · PLE screening (C1–C6) · SBMA · Credit Engine · ICC calc · Audit trail
       ▼
L3  RIMPL Middleware — on-premise CPU
       │  Pre-filter 4 signals · De-identify PII · Anti-sycophancy + ELM
       ▼
L4  API Randomization Layer — สุ่ม provider ต่อ session
       │  hashSessionId() · Failover · Log provider_used · HTTPS/TLS 1.3 outbound
       ▼
Cloud AI (GPU) — randomized per session, no PII leaves on-premise
  ┌─────────┬──────────┬────────────────┬────────────┐
  │ Claude  │  GPT-4o  │    Gemini      │  Mistral   │
  └─────────┴──────────┴────────────────┴────────────┘
       │  JSON response → RIMPL post-filter
       ▼
Supabase (PostgreSQL · AES-256)
  Tables: professionals · ples · audit_trail · professions · lpdp_snapshots
```

**Critical data-boundary rule:** PII never leaves the on-premise RIMPL layer. Only de-identified JSON fragments reach cloud AI providers.

---

## Domain Concepts

| Term | Meaning |
|------|---------|
| **PLE / CLE** | Professional/Clinical Learning Episode — a single physician–AI dialogue session |
| **PIS-7** | 7-domain scoring rubric (0–5 per domain) used to evaluate physician reasoning quality in a PLE |
| **RIMPL** | On-premise middleware: pre-filters prompts, strips PII, injects anti-sycophancy + ELM signals |
| **SBMA** | Score Behavior Matching Algorithm — matches PLE patterns to scoring profiles |
| **ICC** | Intraclass Correlation Coefficient — primary metric for AI vs. expert-auditor agreement (target ≥ 0.75) |
| **LPDP** | Longitudinal Professional Development Profile — per-physician score trajectory chart |
| **C1–C6** | PLE screening criteria (quality gate before scoring) |
| **Credit Engine** | Converts validated PLE scores into CPD credit units |

### PIS-7 Domains (weights)
1. Clinical Question Intelligence (15%)
2. Reasoning Depth (20%)
3. Contextual Integration (15%)
4. Iterative Inquiry (15%)
5. Critical Appraisal (15%)
6. Reflective Synthesis (10%)
7. AI Literacy & Prompt Skill (10%)

---

## User Roles

| Role | Description |
|------|-------------|
| **A — Superadmin** | Full system oversight |
| **B — Admin** | Professional body admin; manages pilot cohort |
| **C — Physician** | Completes PLEs, receives credit |
| **D — Expert Auditor** | Blind-reviews PLEs for ICC calibration |

---

## Tech Stack (Planned)

- **Frontend:** HTML/JS (port 3000), Next.js (port 3002 — audit dashboard)
- **Backend:** Node.js + Express (port 3001), Supabase SDK, Anthropic SDK
- **Database:** Supabase / PostgreSQL, AES-256 at rest, row-level security
- **Auth:** JWT (HTTPS only)
- **AI Providers:** Claude (Anthropic), GPT-4o (OpenAI), Gemini (Google Vertex AI), Mistral — randomized per session via L4
- **Middleware:** RIMPL (custom, on-premise)

---

## Key Constraints

- **On-premise mandate:** All PII and audit trail data must remain on-premise. Only stripped JSON reaches cloud APIs.
- **Provider randomization:** L4 selects AI provider per session using `hashSessionId()`. One provider is used per PLE. `provider_used` is logged for audit.
- **Pseudonymization:** Physicians mapped P-001…P-075; CLEs mapped CLE-001…CLE-150. Lookup table is encrypted and access-gated.
- **Reproducibility:** All CCME LLM evaluation runs tagged with model version (`CCME_LLM_v8.0`). If model updates mid-study, re-evaluate the Tier 2 sample for drift.
- **ICC gate:** Calibration Workshop must achieve ICC ≥ 0.75 before Tier 2 audit begins.

---

## Pilot Timeline

| Month | Milestone |
|-------|-----------|
| July 2026 | Calibration Workshop — establish inter-rater ICC ≥ 0.75 |
| Aug–Sep 2026 | Pilot Study — 75 physicians × 3 PLEs = 225 PLEs |
