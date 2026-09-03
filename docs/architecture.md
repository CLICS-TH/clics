# Architecture (4-Layer, On-Premise)

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
  Tables: professionals · councils · ples · audit_scores · lpdp_snapshots
```

**Critical data-boundary rule:** PII never leaves the on-premise RIMPL layer. Only de-identified JSON fragments reach cloud AI providers. (The physician's structured `patient_ref` is the one PII field passed *into* RIMPL — on-prem, exclusively so RIMPL can scrub it from the narrative; it is never forwarded to the cloud.)

## Planned vs. as-built

The diagram above is the **target design**. As of the pilot build, L3/L4 run as a **Claude-only pipeline**: PII de-identification is regex-based (not the full pseudonymization lookup), and multi-provider randomization (`hashSessionId`, GPT-4o / Gemini / Mistral, failover, the "4 pre-filter signals", and ELM) is **not yet implemented**. The anti-sycophancy / citation / Socratic behaviours **are** implemented (RIMPL system prompt). Full enumeration with file:line evidence: [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md).

## Request flow (chat)

1. Physician sends a message → `POST /ples/:id/message` (backend, physician-gated).
2. Backend forwards to RIMPL `POST /chat` over the internal network (`x-internal-token` auth).
3. RIMPL strips PII, prepends the anti-sycophancy/citation/Socratic system prompt, does a RAG lookup, calls Claude, and retries once if the reply lacks a citation or Socratic question.
4. Response (content + refs + `socratic_question` + token_count) returns to the backend, which persists the message pair and updates turn/token counters.

Backend↔RIMPL fail modes: `/message` **fails closed** (502 if RIMPL is down); `/end` Tier-2 check **fails open** (flags the session for manual QA).
