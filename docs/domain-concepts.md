# Domain Concepts

| Term | Meaning |
|------|---------|
| **CLE** | Clinical Learning Episode — a single physician–AI dialogue session (the protocol's unit of analysis) |
| **PIS-7** | 7-domain scoring rubric (0–5 per domain) used to evaluate physician reasoning quality in a CLE |
| **RIMPL** | On-premise middleware: pre-filters prompts, strips PII, injects anti-sycophancy + ELM signals |
| **SBMA** | Score Behavior Matching Algorithm — matches CLE patterns to scoring profiles |
| **ICC** | Intraclass Correlation Coefficient — primary metric for AI vs. expert-auditor agreement (target ≥ 0.75) |
| **LPDP** | Longitudinal Professional Development Profile — per-physician score trajectory chart |
| **C1–C6** | CLE screening criteria (quality gate before scoring) |
| **Credit Engine** | Converts validated CLE scores into CPD credit units |

## PIS-7 Domains (weights)

1. Clinical Question Intelligence (15%)
2. Reasoning Depth (20%)
3. Contextual Integration (15%)
4. Iterative Inquiry (15%)
5. Critical Appraisal (15%)
6. Reflective Synthesis (10%)
7. AI Literacy & Prompt Skill (10%)

Composite = Σ(domain × weight) × 20 → 0–100 (`backend/src/services/cle-gate.js`).

## CLE screening criteria (C1–C6)

- **Tier 1 (structural, auto-reject):** C1 duration ≥ 15 min · C2 turns ≥ 4 · C3 tokens ≥ 800 (`computeTier1`).
- **Tier 2 (content, manual QA on fail):** C4 clinical question present · C5 ≥ 2 deep follow-ups · C6 explicit learning summary (delegated to RIMPL `/evaluate-criteria`).

> Note: **SBMA** and the **Credit Engine** are domain concepts in the spec but are **not yet implemented** in code. ICC and PIS-7 composite scoring **are** implemented.
