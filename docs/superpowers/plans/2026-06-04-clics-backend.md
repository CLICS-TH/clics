# CLICS Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete CLICS backend — database schema, RIMPL AI gateway service (port 3003), and Express API (port 3001) — producing a fully testable system before any frontend work begins.

**Architecture:** Supabase Cloud holds all data (PostgreSQL + pgvector). RIMPL (port 3003) is a stateless Node.js service that owns all Claude interactions: PII strip → RAG lookup → Claude call → post-filter → response. The Backend (port 3001) handles auth, business logic, CLE gating, and data writes; it never calls Claude directly.

**Tech Stack:** Node.js 20, Express 4, Supabase JS SDK v2, Anthropic SDK, Jest + Supertest, Zod

---

## File Structure

```
clics/
├── db/
│   ├── schema.sql                     # Full schema, RLS, pgvector function
│   └── seed-documents.js              # RAG ingestion script
├── rimpl/
│   ├── src/
│   │   ├── index.js                   # Express server bootstrap (port 3003)
│   │   ├── lib/
│   │   │   ├── supabase.js            # Supabase client (service role)
│   │   │   └── prompts.js             # All 3 system prompts (RIMPL + PIS-7 + criteria)
│   │   ├── services/
│   │   │   ├── pii-filter.js          # stripPii(), stripHistoryPii()
│   │   │   ├── rag.js                 # ragLookup() — pgvector similarity search
│   │   │   ├── claude.js              # callClaude() — Anthropic SDK wrapper
│   │   │   └── post-filter.js         # hasCitation(), extractSocraticQuestion(), extractReferences()
│   │   └── routes/
│   │       ├── chat.js                # POST /chat
│   │       ├── evaluate.js            # POST /evaluate
│   │       └── evaluate-criteria.js  # POST /evaluate-criteria
│   ├── tests/
│   │   ├── pii-filter.test.js
│   │   ├── post-filter.test.js
│   │   └── chat.test.js
│   ├── package.json
│   └── .env.example
├── backend/
│   ├── src/
│   │   ├── index.js                   # Express server bootstrap (port 3001)
│   │   ├── lib/
│   │   │   ├── supabase.js            # Supabase client (service role)
│   │   │   └── schemas.js             # Zod validation schemas
│   │   ├── middleware/
│   │   │   └── auth.js                # verifyJwt(), requireRole()
│   │   ├── services/
│   │   │   ├── cle-gate.js            # computeTier1(), compositeScore()
│   │   │   ├── rimpl-client.js        # HTTP client for RIMPL endpoints
│   │   │   └── icc.js                 # computeICC21()
│   │   └── routes/
│   │       ├── auth.js                # POST /auth/login, /logout, GET /auth/me
│   │       ├── ples.js                # PLE CRUD + message + end
│   │       ├── admin.js               # Admin routes (Role B)
│   │       ├── auditor.js             # Auditor routes (Role D)
│   │       └── superadmin.js          # Superadmin routes (Role A)
│   ├── tests/
│   │   ├── cle-gate.test.js
│   │   ├── icc.test.js
│   │   └── ples.test.js
│   ├── package.json
│   └── .env.example
```

---

## Task 1: Database Schema

**Files:**
- Create: `db/schema.sql`

- [ ] **Step 1: Write schema.sql**

```sql
-- db/schema.sql

create extension if not exists vector;

-- All users (all 4 roles)
create table public.professionals (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           text not null check (role in ('superadmin','admin','physician','auditor')),
  full_name_th   text not null,
  full_name_en   text not null,
  specialty      text,
  license_number text,
  created_at     timestamptz default now()
);

-- One row per physician session
create table public.ples (
  id               uuid primary key default gen_random_uuid(),
  physician_id     uuid not null references public.professionals(id),
  auditor_id       uuid references public.professionals(id),
  status           text not null default 'active'
                   check (status in ('active','ended','cle_pass','cle_fail_t1','cle_flag_t2','evaluated')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  turn_count       integer default 0,
  token_count      integer default 0,
  c1_pass boolean, c2_pass boolean, c3_pass boolean,
  c4_pass boolean, c5_pass boolean, c6_pass boolean,
  provider_used    text default 'claude',
  created_at       timestamptz default now()
);

-- One row per chat turn
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  ple_id            uuid not null references public.ples(id) on delete cascade,
  role              text not null check (role in ('physician','assistant')),
  content           text not null,
  references        jsonb default '[]'::jsonb,
  socratic_question text,
  token_count       integer default 0,
  created_at        timestamptz default now()
);

-- PIS-7 scored by AI
create table public.ai_evaluations (
  id               uuid primary key default gen_random_uuid(),
  ple_id           uuid not null references public.ples(id) on delete cascade,
  d1 smallint not null check (d1 between 0 and 5),
  d2 smallint not null check (d2 between 0 and 5),
  d3 smallint not null check (d3 between 0 and 5),
  d4 smallint not null check (d4 between 0 and 5),
  d5 smallint not null check (d5 between 0 and 5),
  d6 smallint not null check (d6 between 0 and 5),
  d7 smallint not null check (d7 between 0 and 5),
  composite_score  numeric not null,
  domain_rationale jsonb,
  model_version    text not null default 'CCME_LLM_v8.0',
  evaluated_at     timestamptz default now()
);

-- PIS-7 scored by Expert Auditor
create table public.audit_scores (
  id              uuid primary key default gen_random_uuid(),
  ple_id          uuid not null references public.ples(id) on delete cascade,
  auditor_id      uuid not null references public.professionals(id),
  d1 smallint not null check (d1 between 0 and 5),
  d2 smallint not null check (d2 between 0 and 5),
  d3 smallint not null check (d3 between 0 and 5),
  d4 smallint not null check (d4 between 0 and 5),
  d5 smallint not null check (d5 between 0 and 5),
  d6 smallint not null check (d6 between 0 and 5),
  d7 smallint not null check (d7 between 0 and 5),
  composite_score numeric not null,
  notes           text,
  scored_at       timestamptz default now()
);

-- RAG knowledge base (seeded via seed-documents.js)
create table public.documents (
  id        uuid primary key default gen_random_uuid(),
  title     text not null,
  source    text not null,
  content   text not null,
  embedding vector(1536),
  language  text not null check (language in ('th','en')),
  created_at timestamptz default now()
);

-- Per-PLE score history for LPDP chart
create table public.lpdp_snapshots (
  id              uuid primary key default gen_random_uuid(),
  physician_id    uuid not null references public.professionals(id),
  ple_id          uuid not null references public.ples(id),
  composite_score numeric not null,
  domain_scores   jsonb not null,
  snapshot_at     timestamptz default now()
);

-- RLS
alter table public.professionals    enable row level security;
alter table public.ples             enable row level security;
alter table public.messages         enable row level security;
alter table public.ai_evaluations   enable row level security;
alter table public.audit_scores     enable row level security;
alter table public.documents        enable row level security;
alter table public.lpdp_snapshots   enable row level security;

-- professionals policies
create policy "prof: own read"
  on public.professionals for select using (auth.uid() = id);
create policy "prof: admin read all"
  on public.professionals for select using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "prof: superadmin write"
  on public.professionals for insert with check (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- ples policies
create policy "ples: physician own"
  on public.ples for select using (physician_id = auth.uid());
create policy "ples: auditor assigned"
  on public.ples for select using (auditor_id = auth.uid());
create policy "ples: admin all"
  on public.ples for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "ples: physician insert"
  on public.ples for insert with check (physician_id = auth.uid());
create policy "ples: physician update own"
  on public.ples for update using (physician_id = auth.uid());

-- messages policies
create policy "msg: physician own ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );
create policy "msg: auditor assigned ple"
  on public.messages for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.auditor_id = auth.uid())
  );
create policy "msg: admin all"
  on public.messages for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );
create policy "msg: physician insert"
  on public.messages for insert with check (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );

-- ai_evaluations policies
create policy "ai_eval: physician own"
  on public.ai_evaluations for select using (
    exists (select 1 from public.ples pl where pl.id = ple_id and pl.physician_id = auth.uid())
  );
create policy "ai_eval: admin all"
  on public.ai_evaluations for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- audit_scores policies
create policy "audit: auditor own"
  on public.audit_scores for all using (auditor_id = auth.uid());
create policy "audit: admin all"
  on public.audit_scores for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- documents: any authenticated user can read (for RAG)
create policy "docs: authenticated read"
  on public.documents for select using (auth.role() = 'authenticated');
create policy "docs: superadmin write"
  on public.documents for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role = 'superadmin')
  );

-- lpdp policies
create policy "lpdp: physician own"
  on public.lpdp_snapshots for select using (physician_id = auth.uid());
create policy "lpdp: admin all"
  on public.lpdp_snapshots for all using (
    exists (select 1 from public.professionals p where p.id = auth.uid() and p.role in ('admin','superadmin'))
  );

-- pgvector similarity search function
create or replace function match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.75,
  match_count     int   default 3
)
returns table (id uuid, title text, source text, content text, similarity float)
language sql stable as $$
  select
    d.id, d.title, d.source, d.content,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 2: Apply schema in Supabase dashboard**

Open Supabase dashboard → SQL Editor → paste `db/schema.sql` → Run.
Expected: all tables created with no errors.

- [ ] **Step 3: Verify tables exist**

Run in Supabase SQL Editor:
```sql
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;
```
Expected output includes: `ai_evaluations`, `audit_scores`, `documents`, `lpdp_snapshots`, `messages`, `ples`, `professionals`.

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql
git commit -m "feat: add database schema with RLS and pgvector"
```

---

## Task 2: RIMPL — Project Scaffold

**Files:**
- Create: `rimpl/package.json`
- Create: `rimpl/.env.example`
- Create: `rimpl/src/lib/supabase.js`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "clics-rimpl",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@supabase/supabase-js": "^2.45.0",
    "express": "^4.19.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Write .env.example**

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ANTHROPIC_API_KEY=sk-ant-your-key
OPENAI_API_KEY=sk-your-key        # Required for RAG embeddings; leave blank to disable RAG
PORT=3003
```

- [ ] **Step 3: Write src/lib/supabase.js**

```javascript
// rimpl/src/lib/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
```

- [ ] **Step 4: Install dependencies**

```bash
cd rimpl && npm install
```
Expected: `node_modules` created, no errors.

- [ ] **Step 5: Commit**

```bash
git add rimpl/
git commit -m "feat: scaffold rimpl service"
```

---

## Task 3: RIMPL — System Prompts

**Files:**
- Create: `rimpl/src/lib/prompts.js`

- [ ] **Step 1: Write prompts.js**

```javascript
// rimpl/src/lib/prompts.js
const RIMPL_SYSTEM_PROMPT = `You are a clinical AI assistant for physicians in continuing medical education.

MANDATORY BEHAVIOURS — follow all three in every response:

1. ANTI-SYCOPHANCY
If the physician's clinical reasoning, diagnosis, or management plan contains an error, clearly and respectfully correct it with evidence. Never agree with incorrect reasoning to avoid conflict. If you are uncertain, say "ไม่ทราบ / I don't know" — never fabricate.

2. ZERO HALLUCINATION
Every clinical claim must include an inline citation formatted as (Source, Year). Example: "First-line treatment is metformin (ADA Standards of Care, 2024)". Do NOT state clinical facts you cannot cite.

3. SOCRATIC LEARNING MODE
End every response with exactly one follow-up question that challenges the physician to reason one level deeper. The question must appear on its own line prefixed with ❓. Example:
❓ Given this patient's eGFR of 45, how would you adjust the antibiotic dose and why?

Respond in the same language as the physician's message (Thai or English).`;

const PIS7_EVALUATOR_PROMPT = `You are PIS-7 Evaluator. Assess the PHYSICIAN'S reasoning behaviour (NOT the AI's responses) across 7 domains. Ignore AI turns.

DOMAINS AND WEIGHTS:
1. Clinical Question Intelligence (15%) — quality of clinical questions, gap identification
2. Reasoning Depth (20%) — differential diagnosis, risk-benefit, multiple hypotheses
3. Contextual Integration (15%) — patient factors, guidelines, real-world constraints
4. Iterative Inquiry (15%) — follow-up questions that build on AI responses
5. Critical Appraisal (15%) — questioning AI output, requesting evidence
6. Reflective Synthesis (10%) — explicit learning summaries, practice application
7. AI Literacy & Prompt Skill (10%) — clear prompts, verification, clinical ownership

SCALE: 0=Not observed, 1=Very Low, 2=Low, 3=Moderate, 4=High, 5=Very High

Return ONLY valid JSON — no explanation outside the JSON:
{
  "d1": <0-5>, "d2": <0-5>, "d3": <0-5>, "d4": <0-5>,
  "d5": <0-5>, "d6": <0-5>, "d7": <0-5>,
  "rationale": {
    "d1": "<2-3 sentence justification citing specific transcript evidence>",
    "d2": "<2-3 sentence justification>",
    "d3": "<2-3 sentence justification>",
    "d4": "<2-3 sentence justification>",
    "d5": "<2-3 sentence justification>",
    "d6": "<2-3 sentence justification>",
    "d7": "<2-3 sentence justification>"
  }
}`;

const CRITERIA_CLASSIFIER_PROMPT = `Analyze this physician-AI conversation transcript. Return ONLY valid JSON:
{
  "c4": <true if ≥1 clinical question from physician that is NOT a simple factual lookup>,
  "c5": <true if ≥2 physician follow-ups that explicitly reference or build on prior AI response content>,
  "c6": <true if ≥1 explicit learning summary from the physician, e.g. "So I've learned...", "ดังนั้นสรุปได้ว่า...", "I'll apply this by...">
}`;

module.exports = { RIMPL_SYSTEM_PROMPT, PIS7_EVALUATOR_PROMPT, CRITERIA_CLASSIFIER_PROMPT };
```

- [ ] **Step 2: Commit**

```bash
git add rimpl/src/lib/prompts.js
git commit -m "feat: add rimpl system prompts"
```

---

## Task 4: RIMPL — PII Filter

**Files:**
- Create: `rimpl/src/services/pii-filter.js`
- Create: `rimpl/tests/pii-filter.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// rimpl/tests/pii-filter.test.js
const { stripPii, stripHistoryPii } = require('../src/services/pii-filter');

describe('stripPii', () => {
  test('masks Thai HN numbers', () => {
    expect(stripPii('ผู้ป่วย HN 12345678 มาด้วย')).toBe('ผู้ป่วย [HN] มาด้วย');
  });

  test('masks HN: prefix format', () => {
    expect(stripPii('HN: 99001234 chest pain')).toBe('[HN] chest pain');
  });

  test('masks DD/MM/YYYY dates', () => {
    expect(stripPii('วันที่ 15/06/2025 นัดตรวจ')).toBe('วันที่ [DATE] นัดตรวจ');
  });

  test('masks ISO dates', () => {
    expect(stripPii('admitted 2025-06-15')).toBe('admitted [DATE]');
  });

  test('masks ward references', () => {
    expect(stripPii('transferred to ward 4B')).toBe('transferred to [WARD]');
  });

  test('leaves clinical content unchanged', () => {
    const text = 'Patient presents with chest pain and dyspnea';
    expect(stripPii(text)).toBe(text);
  });

  test('stripHistoryPii strips all messages in array', () => {
    const history = [
      { role: 'physician', content: 'HN: 12345 chest pain' },
      { role: 'assistant', content: 'Consider ACS (ACC/AHA, 2023)' },
    ];
    const result = stripHistoryPii(history);
    expect(result[0].content).toBe('[HN] chest pain');
    expect(result[1].content).toBe('Consider ACS (ACC/AHA, 2023)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd rimpl && npx jest tests/pii-filter.test.js --no-coverage
```
Expected: FAIL — "Cannot find module '../src/services/pii-filter'"

- [ ] **Step 3: Write pii-filter.js**

```javascript
// rimpl/src/services/pii-filter.js
const PATTERNS = [
  { re: /\b(?:HN:|HN)\s*:?\s*\d{5,10}\b/gi,           rep: '[HN]' },
  { re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,              rep: '[DATE]' },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g,                       rep: '[DATE]' },
  { re: /\b(?:ward|ห้อง)\s+[A-Za-z0-9]+\b/gi,          rep: '[WARD]' },
];

function stripPii(text) {
  return PATTERNS.reduce((t, { re, rep }) => t.replace(re, rep), text);
}

function stripHistoryPii(history) {
  return history.map(msg => ({ ...msg, content: stripPii(msg.content) }));
}

module.exports = { stripPii, stripHistoryPii };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd rimpl && npx jest tests/pii-filter.test.js --no-coverage
```
Expected: PASS — 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add rimpl/src/services/pii-filter.js rimpl/tests/pii-filter.test.js
git commit -m "feat: add rimpl pii filter with tests"
```

---

## Task 5: RIMPL — Post-Filter

**Files:**
- Create: `rimpl/src/services/post-filter.js`
- Create: `rimpl/tests/post-filter.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// rimpl/tests/post-filter.test.js
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../src/services/post-filter');

describe('hasCitation', () => {
  test('detects (Source, Year) pattern', () => {
    expect(hasCitation('Use metformin (ADA, 2024) first-line')).toBe(true);
  });

  test('detects Thai citation', () => {
    expect(hasCitation('แนวทาง (สมาคมโรคเบาหวาน, 2566) ระบุ')).toBe(true);
  });

  test('returns false when no citation', () => {
    expect(hasCitation('Use metformin first-line')).toBe(false);
  });
});

describe('extractSocraticQuestion', () => {
  test('extracts ❓-prefixed question', () => {
    const content = 'Metformin is first-line (ADA, 2024).\n❓ How would renal impairment change your choice?';
    expect(extractSocraticQuestion(content)).toBe('How would renal impairment change your choice?');
  });

  test('returns null when no question found', () => {
    expect(extractSocraticQuestion('Just a statement.')).toBeNull();
  });
});

describe('extractReferences', () => {
  test('extracts multiple citations', () => {
    const refs = extractReferences('See (ADA, 2024) and (WHO, 2023) for guidelines');
    expect(refs).toHaveLength(2);
    expect(refs[0].source).toBe('ADA, 2024');
    expect(refs[1].source).toBe('WHO, 2023');
  });

  test('returns empty array when no citations', () => {
    expect(extractReferences('No citations here')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd rimpl && npx jest tests/post-filter.test.js --no-coverage
```
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Write post-filter.js**

```javascript
// rimpl/src/services/post-filter.js
function hasCitation(content) {
  return /\([^)]+,\s*\d{4}[^)]*\)/.test(content);
}

function extractSocraticQuestion(content) {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('❓')) return line.replace(/^❓\s*/, '');
  }
  return null;
}

function extractReferences(content) {
  const refs = [];
  const pattern = /\(([^)]+,\s*\d{4}[^)]*)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    refs.push({ source: match[1].trim(), title: match[1].split(',')[0].trim() });
  }
  return refs;
}

module.exports = { hasCitation, extractSocraticQuestion, extractReferences };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd rimpl && npx jest tests/post-filter.test.js --no-coverage
```
Expected: PASS — 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add rimpl/src/services/post-filter.js rimpl/tests/post-filter.test.js
git commit -m "feat: add rimpl post-filter with tests"
```

---

## Task 6: RIMPL — RAG Lookup

**Files:**
- Create: `rimpl/src/services/rag.js`

- [ ] **Step 1: Write rag.js**

```javascript
// rimpl/src/services/rag.js
// Requires OPENAI_API_KEY in .env for embeddings. RAG gracefully skips if key is absent.
const { supabase } = require('../lib/supabase');

async function embedText(text) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? 'Embedding failed');
  return json.data[0].embedding; // float[] of length 1536
}

async function ragLookup(query) {
  let embedding;
  try {
    embedding = await embedText(query);
  } catch {
    return []; // fall back gracefully
  }

  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: 3,
  });

  if (error || !data) return [];
  return data; // [{id, title, source, content, similarity}]
}

module.exports = { ragLookup };
```

> **Note:** For the pilot, generate embeddings using a Supabase Edge Function named `embed` (see Task 7) that wraps OpenAI `text-embedding-3-small`. If you don't have an OpenAI key, the RAG lookup will gracefully return `[]` and the system falls back to prompt-cited sources.

- [ ] **Step 2: Commit**

```bash
git add rimpl/src/services/rag.js
git commit -m "feat: add rimpl rag lookup service"
```

---

## Task 7: RIMPL — Claude Wrapper

**Files:**
- Create: `rimpl/src/services/claude.js`

- [ ] **Step 1: Write claude.js**

```javascript
// rimpl/src/services/claude.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

async function callClaude({ systemPrompt, messages, maxTokens = 1500 }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  const text = response.content[0]?.text ?? '';
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return { text, tokenCount: inputTokens + outputTokens };
}

module.exports = { callClaude };
```

- [ ] **Step 2: Commit**

```bash
git add rimpl/src/services/claude.js
git commit -m "feat: add claude wrapper"
```

---

## Task 8: RIMPL — /chat Route

**Files:**
- Create: `rimpl/src/routes/chat.js`
- Modify: `rimpl/tests/chat.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// rimpl/tests/chat.test.js
const request = require('supertest');

// Mock external dependencies
jest.mock('../src/services/claude', () => ({
  callClaude: jest.fn().mockResolvedValue({
    text: 'Metformin is first-line (ADA, 2024).\n❓ How does renal function affect this choice?',
    tokenCount: 120,
  }),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));

const app = require('../src/index');

describe('POST /chat', () => {
  test('returns content, references, and socratic_question', async () => {
    const res = await request(app).post('/chat').send({
      ple_id: 'test-123',
      history: [],
      message: 'What is first-line for T2DM?',
      language: 'en',
    });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('Metformin');
    expect(res.body.references.length).toBeGreaterThan(0);
    expect(res.body.socratic_question).toContain('renal function');
    expect(res.body.token_count).toBe(120);
  });

  test('returns 400 when message is missing', async () => {
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd rimpl && npx jest tests/chat.test.js --no-coverage
```
Expected: FAIL — app not yet created.

- [ ] **Step 3: Write chat.js route**

```javascript
// rimpl/src/routes/chat.js
const { Router } = require('express');
const { z } = require('zod');
const { stripPii, stripHistoryPii } = require('../services/pii-filter');
const { ragLookup } = require('../services/rag');
const { callClaude } = require('../services/claude');
const { hasCitation, extractSocraticQuestion, extractReferences } = require('../services/post-filter');
const { RIMPL_SYSTEM_PROMPT } = require('../lib/prompts');

const router = Router();

const ChatSchema = z.object({
  ple_id: z.string(),
  history: z.array(z.object({ role: z.string(), content: z.string() })),
  message: z.string().min(1),
  language: z.enum(['th', 'en']).default('th'),
});

async function buildMessages(history, message, ragDocs) {
  const context = ragDocs.length
    ? `\n\nRelevant guidelines:\n${ragDocs.map(d => `[${d.source}] ${d.content}`).join('\n')}`
    : '';
  const cleanHistory = stripHistoryPii(history).map(m => ({ role: m.role === 'physician' ? 'user' : 'assistant', content: m.content }));
  return [...cleanHistory, { role: 'user', content: stripPii(message) + context }];
}

router.post('/', async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { history, message, language } = parsed.data;

  try {
    const ragDocs = await ragLookup(message);
    const messages = await buildMessages(history, message, ragDocs);

    let { text, tokenCount } = await callClaude({ systemPrompt: RIMPL_SYSTEM_PROMPT, messages });

    // Retry once if citation or socratic question missing
    if (!hasCitation(text) || !extractSocraticQuestion(text)) {
      const retryMessages = [...messages, { role: 'assistant', content: text }, {
        role: 'user',
        content: language === 'th'
          ? 'กรุณาตอบใหม่ โดยต้องมี (แหล่งอ้างอิง, ปี) และคำถาม ❓ ท้ายคำตอบ'
          : 'Please revise: include at least one (Source, Year) citation and end with an ❓ question.',
      }];
      const retry = await callClaude({ systemPrompt: RIMPL_SYSTEM_PROMPT, messages: retryMessages });
      text = retry.text;
      tokenCount += retry.tokenCount;
    }

    res.json({
      content: text,
      references: extractReferences(text),
      socratic_question: extractSocraticQuestion(text),
      token_count: tokenCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Write src/index.js (app bootstrap)**

```javascript
// rimpl/src/index.js
require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/chat', require('./routes/chat'));
app.use('/evaluate', require('./routes/evaluate'));
app.use('/evaluate-criteria', require('./routes/evaluate-criteria'));

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`RIMPL running on port ${PORT}`));
}

module.exports = app;
```

- [ ] **Step 5: Run tests**

```bash
cd rimpl && npx jest tests/chat.test.js --no-coverage
```
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add rimpl/src/routes/chat.js rimpl/src/index.js rimpl/tests/chat.test.js
git commit -m "feat: add rimpl /chat route"
```

---

## Task 9: RIMPL — /evaluate and /evaluate-criteria Routes

**Files:**
- Create: `rimpl/src/routes/evaluate.js`
- Create: `rimpl/src/routes/evaluate-criteria.js`

- [ ] **Step 1: Write evaluate.js**

```javascript
// rimpl/src/routes/evaluate.js
const { Router } = require('express');
const { z } = require('zod');
const { callClaude } = require('../services/claude');
const { PIS7_EVALUATOR_PROMPT } = require('../lib/prompts');

const router = Router();

const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

const EvalSchema = z.object({
  ple_id: z.string(),
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
});

router.post('/', async (req, res) => {
  const parsed = EvalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ple_id, transcript } = parsed.data;
  const transcriptText = transcript
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  try {
    const { text } = await callClaude({
      systemPrompt: PIS7_EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      maxTokens: 1000,
    });

    let scores;
    try {
      scores = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    } catch {
      return res.status(502).json({ error: 'Evaluator returned invalid JSON' });
    }

    // ×20 gives 0-100 range: max = 5 × 1.0 × 20 = 100
    const composite = Object.entries(WEIGHTS).reduce(
      (acc, [key, w]) => acc + (scores[key] ?? 0) * w, 0
    ) * 20;

    res.json({
      ple_id,
      d1: scores.d1, d2: scores.d2, d3: scores.d3, d4: scores.d4,
      d5: scores.d5, d6: scores.d6, d7: scores.d7,
      composite_score: Math.round(composite * 100) / 100,
      domain_rationale: scores.rationale ?? {},
      model_version: 'CCME_LLM_v8.0',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Write evaluate-criteria.js**

```javascript
// rimpl/src/routes/evaluate-criteria.js
const { Router } = require('express');
const { z } = require('zod');
const { callClaude } = require('../services/claude');
const { CRITERIA_CLASSIFIER_PROMPT } = require('../lib/prompts');

const router = Router();

const Schema = z.object({
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
});

router.post('/', async (req, res) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const transcriptText = parsed.data.transcript
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  try {
    const { text } = await callClaude({
      systemPrompt: CRITERIA_CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      maxTokens: 200,
    });

    let result;
    try {
      result = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    } catch {
      return res.status(502).json({ error: 'Classifier returned invalid JSON' });
    }

    res.json({ c4: !!result.c4, c5: !!result.c5, c6: !!result.c6 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 3: Run all RIMPL tests**

```bash
cd rimpl && npx jest --no-coverage
```
Expected: PASS — all tests green.

- [ ] **Step 4: Smoke test RIMPL health endpoint**

```bash
cd rimpl && npm run dev &
curl http://localhost:3003/health
```
Expected: `{"status":"ok"}`

- [ ] **Step 5: Commit**

```bash
git add rimpl/src/routes/evaluate.js rimpl/src/routes/evaluate-criteria.js
git commit -m "feat: add rimpl /evaluate and /evaluate-criteria routes"
```

---

## Task 10: Backend — Project Scaffold

**Files:**
- Create: `backend/package.json`
- Create: `backend/.env.example`
- Create: `backend/src/lib/supabase.js`
- Create: `backend/src/lib/schemas.js`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "clics-backend",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "express": "^4.19.0",
    "zod": "^3.23.0",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Write .env.example**

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret
RIMPL_URL=http://localhost:3003
PORT=3001
```

- [ ] **Step 3: Write src/lib/supabase.js**

```javascript
// backend/src/lib/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
```

- [ ] **Step 4: Write src/lib/schemas.js**

```javascript
// backend/src/lib/schemas.js
const { z } = require('zod');

const MessageSchema = z.object({
  message: z.string().min(1).max(5000),
  language: z.enum(['th', 'en']).default('th'),
});

const ScoreSchema = z.object({
  d1: z.number().int().min(0).max(5),
  d2: z.number().int().min(0).max(5),
  d3: z.number().int().min(0).max(5),
  d4: z.number().int().min(0).max(5),
  d5: z.number().int().min(0).max(5),
  d6: z.number().int().min(0).max(5),
  d7: z.number().int().min(0).max(5),
  notes: z.string().optional(),
});

const CreatePleSchema = z.object({
  specialty: z.string().optional(),
  chief_complaint: z.string().min(1).max(500),
});

const AssignSchema = z.object({
  auditor_id: z.string().uuid(),
});

module.exports = { MessageSchema, ScoreSchema, CreatePleSchema, AssignSchema };
```

- [ ] **Step 5: Install dependencies**

```bash
cd backend && npm install
```

- [ ] **Step 6: Commit**

```bash
git add backend/
git commit -m "feat: scaffold backend service"
```

---

## Task 11: Backend — Auth Middleware

**Files:**
- Create: `backend/src/middleware/auth.js`

- [ ] **Step 1: Write auth.js**

```javascript
// backend/src/middleware/auth.js
const { supabase } = require('../lib/supabase');

async function verifyJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = header.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });

  // Fetch role from professionals table
  const { data: prof, error: profErr } = await supabase
    .from('professionals')
    .select('role, full_name_th, full_name_en')
    .eq('id', data.user.id)
    .single();

  if (profErr || !prof) return res.status(403).json({ error: 'User not in professionals table' });

  req.user = { id: data.user.id, email: data.user.email, ...prof };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = { verifyJwt, requireRole };
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/middleware/auth.js
git commit -m "feat: add auth middleware"
```

---

## Task 12: Backend — CLE Gate Logic

**Files:**
- Create: `backend/src/services/cle-gate.js`
- Create: `backend/tests/cle-gate.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/cle-gate.test.js
const { computeTier1, compositeScore } = require('../src/services/cle-gate');

describe('computeTier1', () => {
  test('passes when all criteria met', () => {
    const result = computeTier1({ duration_seconds: 960, turn_count: 5, token_count: 900 });
    expect(result).toEqual({ c1: true, c2: true, c3: true });
  });

  test('fails c1 when duration < 900s', () => {
    const result = computeTier1({ duration_seconds: 800, turn_count: 5, token_count: 900 });
    expect(result.c1).toBe(false);
  });

  test('fails c2 when turn_count < 4', () => {
    const result = computeTier1({ duration_seconds: 960, turn_count: 3, token_count: 900 });
    expect(result.c2).toBe(false);
  });

  test('fails c3 when token_count < 800', () => {
    const result = computeTier1({ duration_seconds: 960, turn_count: 5, token_count: 700 });
    expect(result.c3).toBe(false);
  });

  test('handles missing fields as 0', () => {
    const result = computeTier1({});
    expect(result).toEqual({ c1: false, c2: false, c3: false });
  });
});

describe('compositeScore', () => {
  test('computes weighted score correctly', () => {
    // All 5s: (5*0.15 + 5*0.20 + 5*0.15 + 5*0.15 + 5*0.15 + 5*0.10 + 5*0.10) * 4 = 5 * 4 = 20... wait
    // weights sum = 1.0, so max = 5 * 1.0 * 4 = 20... that's wrong
    // Actually: Σ(score * weight) * 4
    // All 5: (5*1.0)*4 = 20? No - the proposal says 0-100 scale
    // weights: 0.15+0.20+0.15+0.15+0.15+0.10+0.10 = 1.00
    // So all 5: 5 * 1.0 * 4 = 20. That doesn't give 100.
    // Wait - I think the formula should be: Σ(score * weight) / 5 * 100
    // Or: Σ(score * weight) * 20 to get 0-100
    // Let me recalculate: if weights sum to 1 and score is 0-5
    // Max = 5 * 1.0 = 5, to get 100 we multiply by 20
    // So composite = Σ(score * weight) * 20
    const scores = { d1: 5, d2: 5, d3: 5, d4: 5, d5: 5, d6: 5, d7: 5 };
    expect(compositeScore(scores)).toBeCloseTo(100, 1);
  });

  test('computes zero for all zeros', () => {
    const scores = { d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0 };
    expect(compositeScore(scores)).toBe(0);
  });

  test('correct weighted result for mixed scores', () => {
    // d1=4(15%), d2=3(20%), others=0
    // = (4*0.15 + 3*0.20) * 20 = (0.60 + 0.60) * 20 = 1.20 * 20 = 24
    const scores = { d1: 4, d2: 3, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0 };
    expect(compositeScore(scores)).toBeCloseTo(24, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest tests/cle-gate.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Write cle-gate.js**

```javascript
// backend/src/services/cle-gate.js
const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

function computeTier1(ple) {
  return {
    c1: (ple.duration_seconds ?? 0) >= 900,
    c2: (ple.turn_count ?? 0) >= 4,
    c3: (ple.token_count ?? 0) >= 800,
  };
}

// composite = Σ(score × weight) × 20  →  range 0–100
function compositeScore(scores) {
  return Object.entries(WEIGHTS).reduce(
    (acc, [key, w]) => acc + (scores[key] ?? 0) * w, 0
  ) * 20;
}

module.exports = { computeTier1, compositeScore, WEIGHTS };
```

> **Note:** The multiplier is 20 (not 4 as in the spec draft). With weights summing to 1.0 and domain scores 0–5, the formula `Σ(score × weight) × 20` produces a 0–100 range. The spec design section says "×4" which was based on assuming max weighted sum = 25 — this is the correct formula. Update the spec accordingly.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npx jest tests/cle-gate.test.js --no-coverage
```
Expected: PASS — 8 tests passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/cle-gate.js backend/tests/cle-gate.test.js
git commit -m "feat: add cle gate logic with tests"
```

---

## Task 13: Backend — ICC Calculation

**Files:**
- Create: `backend/src/services/icc.js`
- Create: `backend/tests/icc.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/tests/icc.test.js
const { computeICC21 } = require('../src/services/icc');

describe('computeICC21', () => {
  test('returns null for fewer than 2 pairs', () => {
    expect(computeICC21([{ ai: 80, human: 75 }])).toBeNull();
  });

  test('returns ICC near 1.0 for near-identical ratings', () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ ai: 70 + i, human: 70 + i + 1 }));
    const result = computeICC21(pairs);
    expect(result.icc).toBeGreaterThan(0.95);
    expect(result.n).toBe(10);
  });

  test('returns low ICC for random-like ratings', () => {
    const pairs = [
      { ai: 90, human: 40 }, { ai: 50, human: 85 }, { ai: 70, human: 30 },
      { ai: 40, human: 90 }, { ai: 60, human: 75 },
    ];
    const result = computeICC21(pairs);
    expect(result.icc).toBeLessThan(0.5);
  });

  test('result includes lower, upper, interpretation', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ ai: 60 + i * 1.5, human: 62 + i * 1.5 }));
    const result = computeICC21(pairs);
    expect(result).toHaveProperty('lower');
    expect(result).toHaveProperty('upper');
    expect(result).toHaveProperty('interpretation');
    expect(result.lower).toBeLessThanOrEqual(result.icc);
    expect(result.upper).toBeGreaterThanOrEqual(result.icc);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest tests/icc.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Write icc.js**

```javascript
// backend/src/services/icc.js
// ICC(2,1): Two-way mixed effects, single measures
function computeICC21(pairs) {
  const n = pairs.length;
  if (n < 2) return null;

  const k = 2;
  const grandMean = pairs.reduce((a, p) => a + p.ai + p.human, 0) / (n * k);
  const rowMeans = pairs.map(p => (p.ai + p.human) / 2);
  const colMeans = [
    pairs.reduce((a, p) => a + p.ai, 0) / n,
    pairs.reduce((a, p) => a + p.human, 0) / n,
  ];

  const SSr = k * rowMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0);
  const SSc = n * colMeans.reduce((a, m) => a + (m - grandMean) ** 2, 0);
  const SStotal = pairs.reduce((a, p) => a + (p.ai - grandMean) ** 2 + (p.human - grandMean) ** 2, 0);
  const SSe = SStotal - SSr - SSc;

  const MSr = SSr / (n - 1);
  const MSc = SSc / (k - 1);
  const MSe = Math.max(SSe / ((n - 1) * (k - 1)), 0.0001); // avoid div/0

  const icc = (MSr - MSe) / (MSr + (k - 1) * MSe + k * (MSc - MSe) / n);

  // 95% CI via Fisher z-transformation approximation
  const safeIcc = Math.min(Math.max(icc, -0.999), 0.999);
  const z = 0.5 * Math.log((1 + safeIcc) / (1 - safeIcc));
  const se = 1 / Math.sqrt(n - 3);
  const lower = Math.tanh(z - 1.96 * se);
  const upper = Math.tanh(z + 1.96 * se);

  const label = icc >= 0.95 ? 'Excellent'
    : icc >= 0.85 ? 'Very Good'
    : icc >= 0.75 ? 'Good'
    : 'Below target (< 0.75)';

  return {
    icc:   Math.round(safeIcc * 1000) / 1000,
    lower: Math.round(Math.max(lower, 0) * 1000) / 1000,
    upper: Math.round(Math.min(upper, 1) * 1000) / 1000,
    n,
    interpretation: label,
  };
}

module.exports = { computeICC21 };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npx jest tests/icc.test.js --no-coverage
```
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/icc.js backend/tests/icc.test.js
git commit -m "feat: add icc(2,1) calculation with tests"
```

---

## Task 14: Backend — RIMPL Client

**Files:**
- Create: `backend/src/services/rimpl-client.js`

- [ ] **Step 1: Write rimpl-client.js**

```javascript
// backend/src/services/rimpl-client.js
const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';

async function remplChat({ ple_id, history, message, language }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ple_id, history, message, language }),
  });
  if (!res.ok) throw new Error(`RIMPL /chat error: ${res.status}`);
  return res.json(); // { content, references, socratic_question, token_count }
}

async function rimplEvaluate({ ple_id, transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ple_id, transcript }),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate error: ${res.status}`);
  return res.json();
}

async function rimplEvaluateCriteria({ transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate-criteria error: ${res.status}`);
  return res.json(); // { c4, c5, c6 }
}

module.exports = { remplChat, rimplEvaluate, rimplEvaluateCriteria };
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/rimpl-client.js
git commit -m "feat: add rimpl http client"
```

---

## Task 15: Backend — Auth Routes

**Files:**
- Create: `backend/src/routes/auth.js`

- [ ] **Step 1: Write auth.js**

```javascript
// backend/src/routes/auth.js
const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt } = require('../middleware/auth');

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return res.status(401).json({ error: error.message });

  const { data: prof } = await supabase
    .from('professionals')
    .select('role, full_name_th, full_name_en, specialty')
    .eq('id', data.user.id)
    .single();

  res.json({
    access_token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email, ...prof },
  });
});

router.post('/logout', verifyJwt, async (req, res) => {
  await supabase.auth.signOut();
  res.json({ ok: true });
});

router.get('/me', verifyJwt, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/routes/auth.js
git commit -m "feat: add auth routes"
```

---

## Task 16: Backend — PLE Routes

**Files:**
- Create: `backend/src/routes/ples.js`

- [ ] **Step 1: Write ples.js**

```javascript
// backend/src/routes/ples.js
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { MessageSchema, CreatePleSchema } = require('../lib/schemas');
const { computeTier1, compositeScore } = require('../services/cle-gate');
const { remplChat, rimplEvaluate, rimplEvaluateCriteria } = require('../services/rimpl-client');

const router = Router();
router.use(verifyJwt, requireRole('physician'));

// Create new PLE session
router.post('/', async (req, res) => {
  const parsed = CreatePleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await supabase.from('ples').insert({
    physician_id: req.user.id,
    status: 'active',
    started_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// List physician's own PLEs
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('id, status, started_at, ended_at, turn_count, token_count, c1_pass, c2_pass, c3_pass, c4_pass, c5_pass, c6_pass')
    .eq('physician_id', req.user.id)
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get single PLE with messages
router.get('/:id', async (req, res) => {
  const { data: ple, error } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (error || !ple) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase
    .from('messages').select('*').eq('ple_id', req.params.id).order('created_at');

  res.json({ ...ple, messages: messages ?? [] });
});

// Send a message turn
router.post('/:id/message', async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: ple } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const { data: history } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');

  const { message, language } = parsed.data;

  let rimplResponse;
  try {
    rimplResponse = await remplChat({ ple_id: req.params.id, history: history ?? [], message, language });
  } catch (err) {
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}` });
  }

  // Save physician message
  const physicianTokens = Math.ceil(message.length / 4);
  await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'physician',
    content: message, token_count: physicianTokens,
  });

  // Save assistant message
  await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'assistant',
    content: rimplResponse.content,
    references: rimplResponse.references,
    socratic_question: rimplResponse.socratic_question,
    token_count: rimplResponse.token_count,
  });

  // Update PLE counters
  await supabase.from('ples').update({
    turn_count: (ple.turn_count ?? 0) + 1,
    token_count: (ple.token_count ?? 0) + rimplResponse.token_count + physicianTokens,
  }).eq('id', req.params.id);

  res.json(rimplResponse);
});

// End session and run CLE quality gate
router.post('/:id/end', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const endedAt = new Date();
  const durationSeconds = Math.floor((endedAt - new Date(ple.started_at)) / 1000);

  const updatedPle = { ...ple, duration_seconds: durationSeconds, ended_at: endedAt.toISOString() };

  // Tier 1: structural checks
  const tier1 = computeTier1(updatedPle);

  if (!tier1.c1 || !tier1.c2 || !tier1.c3) {
    await supabase.from('ples').update({
      status: 'cle_fail_t1', ended_at: updatedPle.ended_at,
      duration_seconds: durationSeconds, ...tier1,
    }).eq('id', req.params.id);
    return res.json({ status: 'cle_fail_t1', criteria: { ...tier1 } });
  }

  // Tier 2: content checks via RIMPL
  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  let tier2 = { c4: false, c5: false, c6: false };
  try {
    tier2 = await rimplEvaluateCriteria({ transcript });
  } catch {
    // If RIMPL is down, flag for manual QA
  }

  const allCriteria = { ...tier1, ...tier2 };
  const tier2Pass = tier2.c4 && tier2.c5 && tier2.c6;

  if (!tier2Pass) {
    await supabase.from('ples').update({
      status: 'cle_flag_t2', ended_at: updatedPle.ended_at,
      duration_seconds: durationSeconds, ...allCriteria,
    }).eq('id', req.params.id);
    return res.json({ status: 'cle_flag_t2', criteria: allCriteria });
  }

  // All pass — update status and trigger async evaluation
  await supabase.from('ples').update({
    status: 'cle_pass', ended_at: updatedPle.ended_at,
    duration_seconds: durationSeconds, ...allCriteria,
  }).eq('id', req.params.id);

  // Fire-and-forget evaluation
  triggerEvaluation(req.params.id, transcript).catch(console.error);

  res.json({ status: 'cle_pass', criteria: allCriteria });
});

async function triggerEvaluation(pleId, transcript) {
  const result = await rimplEvaluate({ ple_id: pleId, transcript });
  const composite = compositeScore(result);

  await supabase.from('ai_evaluations').insert({
    ple_id: pleId,
    d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
    d5: result.d5, d6: result.d6, d7: result.d7,
    composite_score: composite,
    domain_rationale: result.domain_rationale,
    model_version: result.model_version,
  });

  // Get physician_id for lpdp snapshot
  const { data: ple } = await supabase.from('ples').select('physician_id').eq('id', pleId).single();

  await supabase.from('lpdp_snapshots').insert({
    physician_id: ple.physician_id, ple_id: pleId,
    composite_score: composite,
    domain_scores: { d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4, d5: result.d5, d6: result.d6, d7: result.d7 },
  });

  await supabase.from('ples').update({ status: 'evaluated' }).eq('id', pleId);
}

// Get AI evaluation result
router.get('/:id/evaluation', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('status').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'evaluated') return res.status(202).json({ status: ple.status });

  const { data: eval_ } = await supabase
    .from('ai_evaluations').select('*').eq('ple_id', req.params.id).single();
  res.json(eval_);
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/routes/ples.js
git commit -m "feat: add ple routes with cle gate and evaluation trigger"
```

---

## Task 17: Backend — Admin, Auditor, Superadmin Routes

**Files:**
- Create: `backend/src/routes/admin.js`
- Create: `backend/src/routes/auditor.js`
- Create: `backend/src/routes/superadmin.js`

- [ ] **Step 1: Write admin.js**

```javascript
// backend/src/routes/admin.js
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { AssignSchema } = require('../lib/schemas');
const { rimplEvaluate, rimplEvaluateCriteria } = require('../services/rimpl-client');
const { compositeScore } = require('../services/cle-gate');

const router = Router();
router.use(verifyJwt, requireRole('admin', 'superadmin'));

router.get('/ples', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('ples').select('*, professionals(full_name_th, full_name_en, specialty)');
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/ples/flagged', async (req, res) => {
  const { data, error } = await supabase
    .from('ples').select('*, professionals(full_name_th, full_name_en)')
    .eq('status', 'cle_flag_t2').order('ended_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/ples/:id/approve', async (req, res) => {
  const { data: ple } = await supabase.from('ples').select('*').eq('id', req.params.id).single();
  if (!ple || ple.status !== 'cle_flag_t2') return res.status(400).json({ error: 'Not a flagged PLE' });

  await supabase.from('ples').update({ status: 'cle_pass' }).eq('id', req.params.id);

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  // Trigger async evaluation
  (async () => {
    try {
      const result = await rimplEvaluate({ ple_id: req.params.id, transcript });
      const composite = compositeScore(result);
      await supabase.from('ai_evaluations').insert({
        ple_id: req.params.id,
        d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
        d5: result.d5, d6: result.d6, d7: result.d7,
        composite_score: composite, domain_rationale: result.domain_rationale,
        model_version: result.model_version,
      });
      await supabase.from('lpdp_snapshots').insert({
        physician_id: ple.physician_id, ple_id: req.params.id,
        composite_score: composite,
        domain_scores: { d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4, d5: result.d5, d6: result.d6, d7: result.d7 },
      });
      await supabase.from('ples').update({ status: 'evaluated' }).eq('id', req.params.id);
    } catch (e) { console.error('Evaluation failed:', e.message); }
  })();

  res.json({ ok: true });
});

router.post('/ples/:id/reject', async (req, res) => {
  const { error } = await supabase.from('ples')
    .update({ status: 'cle_fail_t1' }).eq('id', req.params.id).eq('status', 'cle_flag_t2');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/ples/:id/assign', async (req, res) => {
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { error } = await supabase.from('ples')
    .update({ auditor_id: parsed.data.auditor_id }).eq('id', req.params.id).eq('status', 'evaluated');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.get('/stats', async (req, res) => {
  const { data: ples } = await supabase.from('ples').select('status');
  const total = ples?.length ?? 0;
  const counts = (ples ?? []).reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  res.json({ total, ...counts });
});

module.exports = router;
```

- [ ] **Step 2: Write auditor.js**

```javascript
// backend/src/routes/auditor.js
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { ScoreSchema } = require('../lib/schemas');
const { compositeScore } = require('../services/cle-gate');
const { computeICC21 } = require('../services/icc');

const router = Router();
router.use(verifyJwt, requireRole('auditor'));

router.get('/queue', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('id, status, ended_at, turn_count, token_count')
    .eq('auditor_id', req.user.id)
    .eq('status', 'evaluated')
    .order('ended_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/ples/:id', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('id, status, turn_count, token_count, ended_at')
    .eq('id', req.params.id).eq('auditor_id', req.user.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found or not assigned' });

  const { data: messages } = await supabase
    .from('messages').select('role, content, references, socratic_question, created_at')
    .eq('ple_id', req.params.id).order('created_at');

  // Check if auditor already submitted score
  const { data: existing } = await supabase
    .from('audit_scores').select('*').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).single();

  // Only reveal AI score after auditor has submitted
  let aiEval = null;
  if (existing) {
    const { data } = await supabase
      .from('ai_evaluations').select('*').eq('ple_id', req.params.id).single();
    aiEval = data;
  }

  res.json({ ple, messages: messages ?? [], audit_score: existing ?? null, ai_evaluation: aiEval });
});

router.post('/ples/:id/score', async (req, res) => {
  const parsed = ScoreSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Prevent double-scoring
  const { data: existing } = await supabase
    .from('audit_scores').select('id').eq('ple_id', req.params.id).eq('auditor_id', req.user.id).single();
  if (existing) return res.status(409).json({ error: 'Already scored' });

  const { notes, ...scores } = parsed.data;
  const composite = compositeScore(scores);

  const { error } = await supabase.from('audit_scores').insert({
    ple_id: req.params.id, auditor_id: req.user.id,
    ...scores, composite_score: composite, notes,
  });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ composite_score: composite });
});

router.get('/icc', async (req, res) => {
  const { data } = await supabase
    .from('audit_scores').select('ple_id, composite_score')
    .eq('auditor_id', req.user.id);

  if (!data?.length) return res.json({ icc: null, n: 0 });

  const pleIds = data.map(s => s.ple_id);
  const { data: aiScores } = await supabase
    .from('ai_evaluations').select('ple_id, composite_score').in('ple_id', pleIds);

  const pairs = data.flatMap(audit => {
    const ai = aiScores?.find(a => a.ple_id === audit.ple_id);
    return ai ? [{ ai: ai.composite_score, human: audit.composite_score }] : [];
  });

  res.json(computeICC21(pairs));
});

module.exports = router;
```

- [ ] **Step 3: Write superadmin.js**

```javascript
// backend/src/routes/superadmin.js
const { Router } = require('express');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { computeICC21 } = require('../services/icc');

const router = Router();
router.use(verifyJwt, requireRole('superadmin'));

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['superadmin', 'admin', 'physician', 'auditor']),
  full_name_th: z.string().min(1),
  full_name_en: z.string().min(1),
  specialty: z.string().optional(),
  license_number: z.string().optional(),
});

router.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('professionals').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/users', async (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, ...profile } = parsed.data;
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const { error: profErr } = await supabase.from('professionals').insert({ id: authUser.user.id, ...profile });
  if (profErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    return res.status(500).json({ error: profErr.message });
  }

  res.status(201).json({ id: authUser.user.id, email, ...profile });
});

router.get('/icc', async (req, res) => {
  const { data: auditScores } = await supabase.from('audit_scores').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');
  const { data: aiScores } = await supabase.from('ai_evaluations').select('ple_id, composite_score, d1,d2,d3,d4,d5,d6,d7');

  if (!auditScores?.length) return res.json({ overall: null, per_domain: {} });

  const pairs = auditScores.flatMap(a => {
    const ai = aiScores?.find(s => s.ple_id === a.ple_id);
    return ai ? [{ ai: ai.composite_score, human: a.composite_score, auditDomains: a, aiDomains: ai }] : [];
  });

  const overall = computeICC21(pairs.map(p => ({ ai: p.ai, human: p.human })));

  const perDomain = {};
  for (const d of ['d1','d2','d3','d4','d5','d6','d7']) {
    perDomain[d] = computeICC21(pairs.map(p => ({
      ai: p.aiDomains[d],
      human: p.auditDomains[d],
    })));
  }

  res.json({ overall, per_domain: perDomain, n: pairs.length });
});

router.get('/lpdp/:physicianId', async (req, res) => {
  const { data, error } = await supabase
    .from('lpdp_snapshots').select('*, ples(ended_at)')
    .eq('physician_id', req.params.physicianId)
    .order('snapshot_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/admin.js backend/src/routes/auditor.js backend/src/routes/superadmin.js
git commit -m "feat: add admin, auditor, and superadmin routes"
```

---

## Task 18: Backend — Server Bootstrap + Integration Test

**Files:**
- Create: `backend/src/index.js`
- Create: `backend/tests/ples.test.js`

- [ ] **Step 1: Write src/index.js**

```javascript
// backend/src/index.js
require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', require('./routes/auth'));
app.use('/ples', require('./routes/ples'));
app.use('/admin', require('./routes/admin'));
app.use('/auditor', require('./routes/auditor'));
app.use('/admin', require('./routes/superadmin'));

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}

module.exports = app;
```

- [ ] **Step 2: Write smoke test for CLE gate integration**

```javascript
// backend/tests/ples.test.js
const { computeTier1, compositeScore } = require('../src/services/cle-gate');

describe('CLE gate integration', () => {
  test('15-min session with 4 turns and 800 tokens passes Tier 1', () => {
    const ple = { duration_seconds: 900, turn_count: 4, token_count: 800 };
    const t1 = computeTier1(ple);
    expect(t1.c1 && t1.c2 && t1.c3).toBe(true);
  });

  test('composite score of 3.5 avg gives 70/100', () => {
    // 3.5 * 1.0 * 20 = 70
    const s = { d1: 3.5, d2: 3.5, d3: 3.5, d4: 3.5, d5: 3.5, d6: 3.5, d7: 3.5 };
    expect(compositeScore(s)).toBeCloseTo(70, 0);
  });
});
```

- [ ] **Step 3: Run all backend tests**

```bash
cd backend && npx jest --no-coverage
```
Expected: PASS — all tests green.

- [ ] **Step 4: Smoke test backend health endpoint**

```bash
cd backend && npm run dev &
curl http://localhost:3001/health
```
Expected: `{"status":"ok"}`

- [ ] **Step 5: Write RAG seed script**

```javascript
// db/seed-documents.js
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... node db/seed-documents.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Sample documents — replace with real guideline excerpts before pilot
const DOCUMENTS = [
  {
    title: 'ADA Standards of Care 2024 — Pharmacologic Treatment',
    source: 'ADA, 2024',
    content: 'Metformin remains first-line pharmacologic treatment for type 2 diabetes unless contraindicated. For patients with established CVD or high CVD risk, an SGLT2 inhibitor or GLP-1 RA with proven CVD benefit is recommended.',
    language: 'en',
  },
  {
    title: 'WHO Essential Medicines — Antibiotics',
    source: 'WHO, 2023',
    content: 'Amoxicillin-clavulanate is recommended for community-acquired pneumonia in outpatient settings. Duration: 5-7 days for mild-moderate CAP.',
    language: 'en',
  },
  // Add more real clinical guideline excerpts here
];

async function embed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function seed() {
  for (const doc of DOCUMENTS) {
    console.log(`Embedding: ${doc.title}`);
    const embedding = await embed(doc.content);
    const { error } = await supabase.from('documents').insert({ ...doc, embedding });
    if (error) console.error(error.message);
    else console.log(`  ✓ inserted`);
  }
}

seed().catch(console.error);
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/ples.test.js db/seed-documents.js
git commit -m "feat: wire up backend server and add seed script"
```

---

## Running the Full Backend

```bash
# Terminal 1 — RIMPL
cd rimpl && cp .env.example .env   # fill in keys
npm install && npm run dev

# Terminal 2 — Backend
cd backend && cp .env.example .env  # fill in keys, set RIMPL_URL=http://localhost:3003
npm install && npm run dev

# Test health of both
curl http://localhost:3003/health   # {"status":"ok"}
curl http://localhost:3001/health   # {"status":"ok"}
```
