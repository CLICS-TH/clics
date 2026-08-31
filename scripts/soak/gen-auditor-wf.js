// Generate the auditor workflow script with BLIND transcripts embedded (workflow scripts can't read fs).
const fs = require('fs');
const t = JSON.parse(fs.readFileSync('/tmp/soak-transcripts.json', 'utf8'));
const blind = t.map((p, i) => ({
  ple_id: p.ple_id,
  ref: `PLE-${String(i + 1).padStart(2, '0')}`,
  chief_complaint: p.chief_complaint,
  transcript: p.messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n'),
})); // NOTE: no _ai — auditors score blind

const script = `export const meta = {
  name: 'clics-auditor-soak',
  description: 'Three expert auditors independently blind-score the evaluated PLEs (PIS-7) for ICC',
  phases: [{ title: 'Blind scoring' }],
};

// Blind transcripts (no AI scores). Auditors score independently on the PIS-7 rubric.
const TRANSCRIPTS = ${JSON.stringify(blind)};

const RUBRIC = \`PIS-7 rubric — score EACH domain 0–5 (integer). Anchors: 0 absent · 1 minimal · 2 below expectation · 3 competent · 4 strong · 5 exceptional.
 d1 Clinical Question Intelligence (15%): specificity & clinical relevance of the questions the physician asks.
 d2 Reasoning Depth (20%): depth of clinical reasoning — differential breadth, justification, probabilistic thinking.
 d3 Contextual Integration (15%): use of the patient's context (age, comorbidities, risk) in the reasoning.
 d4 Iterative Inquiry (15%): how meaningfully each turn builds on the previous AI response (vs. restarting).
 d5 Critical Appraisal (15%): challenging/appraising the AI output, evidence, and uncertainty rather than accepting it.
 d6 Reflective Synthesis (10%): explicit consolidation of learning / takeaways / how it will change practice.
 d7 AI Literacy & Prompt Skill (10%): effectiveness of prompting and use of the AI as a reasoning partner.\`;

const AUDITORS = [
  { email: 'soakaud1@example.com', stance: 'BALANCED and calibrated: anchor strictly to the rubric; 3 = competent, 5 only for genuinely exceptional reasoning.' },
  { email: 'soakaud2@example.com', stance: 'STRICT and demanding: you are a senior examiner who reserves 4–5 for clearly outstanding work and is unafraid to give low scores for shallow reasoning.' },
  { email: 'soakaud3@example.com', stance: 'SLIGHTLY LENIENT: you reward visible engagement, effort, and good intent, tending to round up when borderline — but still discriminate weak from strong.' },
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          ple_id: { type: 'string' },
          d1: { type: 'integer', minimum: 0, maximum: 5 },
          d2: { type: 'integer', minimum: 0, maximum: 5 },
          d3: { type: 'integer', minimum: 0, maximum: 5 },
          d4: { type: 'integer', minimum: 0, maximum: 5 },
          d5: { type: 'integer', minimum: 0, maximum: 5 },
          d6: { type: 'integer', minimum: 0, maximum: 5 },
          d7: { type: 'integer', minimum: 0, maximum: 5 },
          notes: { type: 'string' },
        },
        required: ['ple_id', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'notes'],
      },
    },
  },
  required: ['scores'],
};

function buildPrompt(stance) {
  const cases = TRANSCRIPTS.map(p =>
    \`### \${p.ref}  (ple_id: \${p.ple_id})\\nChief complaint: \${p.chief_complaint}\\n\\nTRANSCRIPT:\\n\${p.transcript}\`
  ).join('\\n\\n---\\n\\n');
  return \`You are an expert physician serving as a blind CLICS auditor. You are scoring physician–AI clinical-reasoning sessions (PLEs) on the PIS-7 rubric. You do NOT see any AI-generated score — your judgement is independent.

YOUR RATER STANCE: \${stance}

\${RUBRIC}

Score ALL \${TRANSCRIPTS.length} PLEs below. For each, return its exact ple_id and integer d1–d7 plus a one-sentence justification in notes. Be discriminating: the set spans weak-to-excellent reasoning, so your scores should vary across PLEs. Return ONLY the structured object.

\${cases}\`;
}

phase('Blind scoring');
const results = await parallel(AUDITORS.map(a => () =>
  agent(buildPrompt(a.stance), { label: \`audit:\${a.email.split('@')[0]}\`, phase: 'Blind scoring', schema: SCHEMA })
    .then(r => ({ auditor: a.email, stance: a.stance, scores: r.scores }))
    .catch(() => null)
));
return results.filter(Boolean);
`;

fs.writeFileSync('/tmp/soak-auditor-wf.js', script);
console.log(`Wrote /tmp/soak-auditor-wf.js (${blind.length} blind PLEs embedded, ${(script.length/1024).toFixed(1)}KB)`);
