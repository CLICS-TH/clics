# CLICS — Clinical Learning Intelligence Credit System
## Design Specification · 2026-06-04

---

## 1. Purpose

CLICS is an on-premise web platform where Thai physicians consult an AI assistant about real patient cases to earn CPD credit. Each conversation is evaluated against 6 quality criteria to determine if it qualifies as a Clinical Learning Episode (CLE). Valid CLEs are scored by an AI evaluator using the PIS-7 rubric (0–100). A sample is independently scored by a human Expert Auditor. The system measures AI-vs-human agreement (ICC) to validate the scoring instrument.

**Language:** Bilingual Thai + English. UI labels in Thai; AI responds in whichever language the physician writes.

---

## 2. Architecture

```
Browser (Thai/EN bilingual)
        │
        ├── port 3000  Physician Interface   HTML/JS + Vanilla JS
        └── port 3002  Audit Dashboard       Next.js 14 (App Router)
                │
                │  HTTPS · JWT (Supabase Auth)
                ▼
        port 3001  Backend   Node.js / Express
                │  Auth · CLE gating · PIS-7 trigger · Data layer
                │
                │  HTTP (internal — no PII passes this point to cloud)
                ▼
        port 3003  RIMPL Service   Node.js (on-premise, separate process)
                │  Pre-filter → Claude API → Post-filter
                │  Anti-sycophancy · Zero-hallucination · Socratic mode
                │  RAG lookup (pgvector) → reference injection
                │
                │  HTTPS / TLS 1.3 (de-identified JSON only)
                ▼
        api.anthropic.com  Claude (claude-sonnet-4-6)

        Supabase Cloud (PostgreSQL + pgvector + Auth)
```

**Critical constraint:** PII never leaves the on-premise RIMPL layer. Only de-identified JSON fragments reach Claude.

---

## 3. Tech Stack

| Layer | Runtime | Key libraries |
|-------|---------|---------------|
| Physician UI | HTML/JS | Vanilla JS, marked.js |
| Audit Dashboard | Next.js 14 | React, shadcn/ui, Recharts |
| Backend | Node.js + Express | Supabase JS SDK, jose (JWT), zod |
| RIMPL | Node.js + Express | Anthropic SDK, Supabase JS SDK |
| Database | Supabase Cloud | PostgreSQL, pgvector |

---

## 4. User Roles

| Role | Description | Primary App |
|------|-------------|-------------|
| A — Superadmin | Full system oversight, user management, ICC dashboard | Audit Dashboard |
| B — Admin | Manage pilot cohort, QA flagged sessions, stats | Audit Dashboard |
| C — Physician | PLE sessions, view PIS-7 feedback and CPD credit | Physician Interface |
| D — Expert Auditor | Blind-score assigned CLEs via slider UI | Audit Dashboard |

---

## 5. Data Model

```sql
-- All users (all 4 roles)
professionals
  id            uuid  FK → auth.users
  role          'superadmin' | 'admin' | 'physician' | 'auditor'
  full_name_th  text
  full_name_en  text
  specialty     text
  license_number text

-- One row per physician session
ples
  id             uuid
  physician_id   uuid  FK → professionals
  status         'active' | 'ended' | 'cle_pass' | 'cle_fail_t1'
                 | 'cle_flag_t2' | 'evaluated'
  started_at     timestamptz
  ended_at       timestamptz
  duration_seconds integer
  turn_count     integer
  token_count    integer
  c1_pass … c6_pass  boolean   -- 6 CLE criteria results
  provider_used  text          -- 'claude' (phase 1)

-- One row per chat turn
messages
  id               uuid
  ple_id           uuid  FK → ples
  role             'physician' | 'assistant'
  content          text
  references       jsonb   -- [{title, source, url?}]
  socratic_question text   -- present on assistant messages
  token_count      integer
  created_at       timestamptz

-- PIS-7 scored by AI
ai_evaluations
  id               uuid
  ple_id           uuid  FK → ples
  d1 … d7          smallint (0–5)
  composite_score  numeric   -- weighted sum × 4, range 0–100
  domain_rationale jsonb     -- per-domain explanation text
  model_version    text      -- 'CCME_LLM_v8.0'
  evaluated_at     timestamptz

-- PIS-7 scored by Expert Auditor
audit_scores
  id          uuid
  ple_id      uuid  FK → ples
  auditor_id  uuid  FK → professionals
  d1 … d7     smallint (0–5)
  composite_score numeric
  notes       text
  scored_at   timestamptz

-- RAG knowledge base (seeded via a one-time ingestion script for the pilot)
documents
  id        uuid
  title     text
  source    text   -- e.g. 'WHO 2023', 'Thai Clinical Guidelines'
  content   text
  embedding vector(1536)   -- pgvector
  language  'th' | 'en'

-- Per-PLE score history for LPDP chart
lpdp_snapshots
  id              uuid  PK
  physician_id    uuid  FK → professionals
  ple_id          uuid  FK → ples
  composite_score numeric
  domain_scores   jsonb
  snapshot_at     timestamptz
```

**Row-level security:**
- Physicians: own `ples` and `messages` only
- Auditors: assigned `ples` only — `physician_id` not exposed (blinded)
- Admins: their cohort
- Superadmin: all rows

---

## 6. RIMPL Service (port 3003)

Stateless. Owns all AI interaction. Three endpoints plus health check.

### `POST /chat`

```
Request:  { ple_id, history: [{role, content}], message: string, language: 'th'|'en' }

Pipeline:
  1. PII strip      mask [ชื่อผู้ป่วย] [HN] [DATE] before any outbound call
  2. RAG lookup     embed message → pgvector similarity search
                    score > 0.75: attach top-3 doc excerpts as context
                    score ≤ 0.75: fall back to prompt-cited sources
  3. Build prompt   system prompt with 3 RIMPL behaviours:
       Anti-sycophancy:   "If the physician's reasoning is clinically incorrect,
                           say so clearly with evidence. Never agree to avoid
                           conflict. State 'ไม่ทราบ / I don't know' if uncertain."
       Zero-hallucination: "Every clinical claim requires an inline citation
                            formatted (Source, Year). Do not state claims you
                            cannot cite."
       Socratic mode:     "End every response with exactly one follow-up question
                           that challenges the physician to reason one level deeper."
  4. Claude call    claude-sonnet-4-6, max_tokens 1500
  5. Post-filter    verify ≥1 citation present; extract socratic_question
                    (last sentence ending '?'); if either missing, retry once
                    with stricter prompt

Response: { content, references: [{title, source}], socratic_question, token_count }
```

### `POST /evaluate`

```
Request:  { ple_id, transcript: [{role, content}] }

Pipeline:
  — Send full transcript with PIS-7 evaluator system prompt
  — Request structured JSON: { d1..d7: 0-5, rationale: {d1..d7: string} }
  — composite_score = Σ(score × weight) × 4   →   0–100
  — Tag model_version: 'CCME_LLM_v8.0'

Response: { d1..d7, composite_score, domain_rationale, model_version }
```

### `POST /evaluate-criteria`

```
Request:  { transcript: [{role, content}] }

Lightweight Claude call to classify C4–C6:
  C4: does transcript contain ≥1 clinical question (not purely factual)?
  C5: are ≥2 physician follow-ups building on prior AI responses?
  C6: does physician provide ≥1 explicit learning summary?

Response: { c4: bool, c5: bool, c6: bool }
```

### `GET /health`

Returns `{ status: 'ok' }`.

---

## 7. Backend API (port 3001)

All routes require `Authorization: Bearer <jwt>`. Role guards noted.

### Auth
```
POST /auth/login       Supabase sign-in → return JWT + role
POST /auth/logout
GET  /auth/me          current user profile + role
```

### PLE Sessions (Role C)
```
POST /ples                  create session → ple_id
GET  /ples                  physician's own sessions + status
GET  /ples/:id              session detail + messages
POST /ples/:id/message      send physician turn → RIMPL → save pair → return
POST /ples/:id/end          end session → trigger CLE quality gate
GET  /ples/:id/evaluation   fetch AI PIS-7 result
```

### CLE Quality Gate (internal, triggered by `POST /ples/:id/end`)
```
C1  duration_seconds ≥ 900 (15 min)         computed from DB
C2  turn_count ≥ 4                           computed from DB
C3  token_count ≥ 800                        computed from DB
C4–C6                                        RIMPL /evaluate-criteria

Tier 1 fail  → status: cle_fail_t1   physician sees which criteria failed
Tier 2 flag  → status: cle_flag_t2   enters Admin QA queue
All pass     → status: cle_pass      fire-and-forget HTTP POST to RIMPL /evaluate
                                        (no await; backend returns 200 to client immediately)
               on complete → backend callback saves ai_evaluations row,
                             sets status: evaluated, writes lpdp_snapshot
```

### Admin (Role B)
```
GET  /admin/ples                   all PLEs in cohort + filters
GET  /admin/ples/flagged           Tier 2 QA queue
POST /admin/ples/:id/approve       pass flagged session → trigger evaluation
POST /admin/ples/:id/reject        reject flagged session
POST /admin/ples/:id/assign        assign evaluated CLE to an auditor
                                   body: { auditor_id }
GET  /admin/stats                  pilot overview stats
```

### Auditor (Role D)
```
GET  /auditor/queue           assigned CLEs (blinded)
GET  /auditor/ples/:id        transcript; AI score hidden until submission
POST /auditor/ples/:id/score  submit d1–d7 + notes
GET  /auditor/icc             ICC stats for dual-scored CLEs
```

### Superadmin (Role A)
```
GET  /admin/users             all professionals
POST /admin/users             create user + assign role
GET  /admin/icc               full ICC dashboard data
GET  /admin/lpdp/:id          physician LPDP trajectory
```

---

## 8. Frontend

### App 1 — Physician Interface (port 3000, HTML/JS)

| Route | Description |
|-------|-------------|
| `/login` | Bilingual login form |
| `/dashboard` | PLE cards with status badges + "เริ่ม PLE ใหม่" button |
| `/ples/new` | Case setup: specialty + chief complaint |
| `/ples/:id` | Chat view: session bar (timer · turns · tokens), message thread, AI refs (📎), Socratic question (❓ italic), End button |
| `/ples/:id/result` | CLE gate result + PIS-7 radar chart + composite score + CPD credit badge |
| `/profile/lpdp` | Line chart of composite scores across CLEs |

### App 2 — Audit Dashboard (port 3002, Next.js 14)

| Route | Role | Description |
|-------|------|-------------|
| `/auditor/queue` | D | Assigned CLEs list (pseudonymised) |
| `/auditor/ples/:id` | D | Transcript + 7 domain sliders + notes + submit; AI score revealed after submission |
| `/admin/ples` | B | All PLEs with status filters |
| `/admin/flagged` | B | Tier 2 QA queue — approve / reject |
| `/admin/stats` | B | Pass rate, avg score, ICC current value |
| `/admin/users` | A | User table + create/edit/role-assign |
| `/admin/icc` | A | ICC estimate + 95% CI, Bland-Altman plot, per-domain bar chart, score histograms |
| `/admin/lpdp/:id` | A | Per-physician score trajectory |

---

## 9. End-to-End Flow

```
1. Physician starts session
   POST /ples → ple (status: active)

2. Conversation loop (per turn)
   Physician types → POST /ples/:id/message
   Backend → RIMPL /chat
     PII strip → RAG lookup → Claude → post-filter
     → { content, references, socratic_question }
   Both messages saved; frontend renders refs + Socratic question

3. Physician ends session
   POST /ples/:id/end

4. CLE quality gate (auto)
   C1–C3 computed from DB
   C4–C6 via RIMPL /evaluate-criteria
   → fail T1: cle_fail_t1
   → flag T2: cle_flag_t2 (Admin QA)
   → all pass: cle_pass → trigger evaluation

5. AI evaluation (async)
   RIMPL /evaluate → d1–d7 + composite 0–100
   Saved to ai_evaluations (CCME_LLM_v8.0)
   ple status → 'evaluated'; lpdp_snapshot created
   Physician sees PIS-7 result + CPD credit

6. Auditor scoring (Role D, blinded)
   Admin assigns CLE to auditor queue
   Auditor reads transcript → submits d1–d7 via sliders
   audit_scores row created

7. ICC calculation (dashboard)
   AI score vs Auditor score per dual-scored CLE
   ICC(2,1) + 95% CI displayed
   Bland-Altman + per-domain breakdown
   Target: ICC ≥ 0.75
```

---

## 10. PIS-7 Scoring Reference

| # | Domain | Weight | Score 0–5 anchors (summary) |
|---|--------|--------|-----------------------------|
| 1 | Clinical Question Intelligence | 15% | 0 = no question; 5 = expert multi-constraint question |
| 2 | Reasoning Depth | 20% | 0 = absent; 5 = full differential with risk-benefit analysis |
| 3 | Contextual Integration | 15% | 0 = generic; 5 = patient + local + systemic factors integrated |
| 4 | Iterative Inquiry | 15% | 0 = no follow-up; 5 = progressive deepening across all turns |
| 5 | Critical Appraisal | 15% | 0 = accepts all AI output; 5 = challenges, requests evidence |
| 6 | Reflective Synthesis | 10% | 0 = no summary; 5 = explicit learning with practice application |
| 7 | AI Literacy & Prompt Skill | 10% | 0 = passive; 5 = clear prompts + verification + clinical ownership |

Composite = Σ(domain_score × weight) × 4 → range 0–100.

---

## 11. ICC Success Criterion

- Primary: ICC(2,1) AI vs Expert Auditor ≥ 0.75 (lower 95% CI bound)
- ICC 0.75–0.85 = Good · 0.85–0.95 = Very Good · >0.95 = Excellent
- If ICC < 0.75 after calibration: flag domain(s) with lowest agreement for rubric review
