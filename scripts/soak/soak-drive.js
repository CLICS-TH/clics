// CLICS 1-week soak — deterministic physician driver (real E2E through backend -> RIMPL -> Claude).
//
// Why a Node script and not subagents: each physician needs token + PLE-id state held across
// many sequential HTTP calls. Subagent Bash shell-state does NOT persist between calls, which
// made the first soak lose PLE ids and spawn 18 orphaned sessions. One process fixes that.
//
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-drive.js
//
// Models a realistic pilot cohort: 10 physicians of varying clinical reasoning skill, each with a
// per-management token budget. Reasoning quality + budget together produce a natural CLE spread
// (weak -> tier-1 fail; average -> tier-2 flag; good/top -> evaluated). Writes /tmp/soak-results.json.

const fs = require('fs');
const BASE = process.env.SOAK_BASE || 'https://backend-production-c12e4.up.railway.app';
const PW = 'SoakPass#2026';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, { token, body } = {}, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    let res, json = null;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      try { json = await res.json(); } catch {}
    } catch (e) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      return { status: 0, body: { error: e.message } };
    }
    // RIMPL/upstream transient -> retry
    if ((res.status === 502 || res.status === 503 || res.status === 429) && attempt < retries) {
      await sleep(2000 * (attempt + 1)); continue;
    }
    return { status: res.status, body: json };
  }
}
const physTokens = msg => Math.ceil(msg.length / 4); // mirrors backend's estimate

// ---- Clinical cases (chief complaint + the scaffolding the message builders reference) ----
const CASES = {
  chestpain: {
    chief: 'Acute substernal chest pain in a 58-year-old man with hypertension and a 30-pack-year smoking history; onset 2 hours ago at rest, now 7/10 with diaphoresis.',
    short: 'an older man with sudden chest pain',
    keyDx: 'acute coronary syndrome',
    cantmiss: 'ACS, aortic dissection, and pulmonary embolism',
    score: 'HEART score',
    workup: 'a 12-lead ECG within 10 minutes, high-sensitivity troponin at 0 and 1–3 h, and a chest x-ray',
    redflags: 'diaphoresis, pain radiating to the jaw or left arm, and exertional onset',
    rx: 'aspirin 162–325 mg chewed, sublingual nitroglycerin if not hypotensive and no inferior STEMI, and anticoagulation once ACS is confirmed',
  },
  dyspnea: {
    chief: 'Progressive exertional dyspnea over 3 days in a 67-year-old woman with type 2 diabetes and CKD stage 3; now breathless at rest with bilateral leg swelling.',
    short: 'a woman with worsening breathlessness',
    keyDx: 'acute decompensated heart failure',
    cantmiss: 'heart failure, pulmonary embolism, ACS, and pneumonia',
    score: 'Wells score for PE',
    workup: 'an ECG, BNP, troponin, chest x-ray, and a focused bedside lung/cardiac ultrasound',
    redflags: 'orthopnoea, paroxysmal nocturnal dyspnoea, hypoxia, and unilateral leg swelling',
    rx: 'oxygen to target sats, IV loop diuretic titrated to response, and nitrates if hypertensive and congested',
  },
  fevercough: {
    chief: 'Fever and productive cough for 4 days in a 72-year-old man with COPD; now confused and febrile at 38.9°C with a respiratory rate of 28.',
    short: 'an elderly COPD patient with fever and cough',
    keyDx: 'community-acquired pneumonia with sepsis',
    cantmiss: 'severe pneumonia/sepsis, COPD exacerbation, and PE',
    score: 'CURB-65',
    workup: 'a chest x-ray, blood and sputum cultures before antibiotics, a venous lactate, and a full set of vitals with sats',
    redflags: 'new confusion, RR ≥ 30, hypotension, and hypoxia',
    rx: 'early empiric antibiotics per local CAP guidance within 1 hour, balanced IV fluids guided by lactate, and oxygen',
  },
  abdo: {
    chief: 'Acute right-lower-quadrant abdominal pain for 12 hours in a 24-year-old woman; the pain migrated from the umbilicus and she now has anorexia and a low-grade fever.',
    short: 'a young woman with RLQ pain',
    keyDx: 'acute appendicitis',
    cantmiss: 'appendicitis, ectopic pregnancy, and ovarian torsion',
    score: 'Alvarado score',
    workup: 'a urine/serum beta-hCG first, urinalysis, FBC/CRP, and a pelvic ultrasound (CT if inconclusive)',
    redflags: 'migratory pain, rebound/guarding, a positive beta-hCG, and peritonism',
    rx: 'analgesia, IV fluids, surgical referral, and antibiotics once appendicitis is the working diagnosis',
  },
  headache: {
    chief: "Sudden severe occipital headache peaking within seconds in a 45-year-old woman — 'the worst headache of my life' — with neck stiffness and one episode of vomiting.",
    short: 'a woman with a thunderclap headache',
    keyDx: 'subarachnoid haemorrhage',
    cantmiss: 'subarachnoid haemorrhage, meningitis, and cerebral venous sinus thrombosis',
    score: 'Ottawa SAH rule',
    workup: 'an urgent non-contrast CT head (within 6 h is highly sensitive), and an LP for xanthochromia if CT is negative and suspicion persists',
    redflags: 'thunderclap onset, neck stiffness, focal deficit, and reduced consciousness',
    rx: 'neurosurgical/stroke referral, blood-pressure control, analgesia and antiemetics, and nimodipine once SAH is confirmed',
  },
};

// ---- Reasoning quality by tier: weak = vague/short; top = expert probabilistic reasoning ----
// Follow-ups deliberately reference the AI's prior answer ("you mentioned…/building on…") to satisfy
// tier-2 C5 (≥2 follow-ups that build on prior AI content). The closing learning summary that
// satisfies C6 is appended separately, only for physicians flagged reflect:true.
const SCRIPT = {
  weak: c => [
    `My patient has ${c.short}. What should I do?`,
    `What medicine should I give?`,
  ],
  average: c => [
    `A patient presents with ${c.chief} I think it might be ${c.keyDx}. What history and tests should I get?`,
    `You mentioned a few things to check — vitals are stable and I'll arrange ${c.workup}. The first results look unremarkable so far. Building on what you said, what now?`,
    `Following up on the differential you raised: could it be something other than ${c.keyDx}? What else should I keep on the list?`,
    `Based on your last answer, what treatment should I start while I wait?`,
  ],
  good: c => [
    `I'm evaluating ${c.chief} My leading diagnosis is ${c.keyDx}, but I'm actively screening for the can't-miss causes: ${c.cantmiss}. I'm looking for the red flags — ${c.redflags} — and I'll use the ${c.score} to risk-stratify. Does that framing miss anything important?`,
    `Building on the red flags you highlighted, I'm arranging ${c.workup}. Walk me through how each result should move my pre-test probability for each can't-miss diagnosis, rather than just confirming my favourite.`,
    `You said the equivocal case is where this gets hard — suppose the first-line result comes back borderline. How should serial testing and the ${c.score} guide whether I admit, observe, or safely discharge?`,
    `Given the working diagnosis of ${c.keyDx} we settled on, what's the evidence-based initial management — ${c.rx} — and what complications should I anticipate and monitor for in the first 24 hours?`,
    `Following your point about safe discharge: what explicit safety-netting and follow-up should I document, and what specific findings would make me escalate or bring them back?`,
  ],
  top: c => [
    `I'm working up ${c.chief} I want to reason this explicitly. My pre-test differential, in rough probability order, is ${c.keyDx} first, then the other can't-miss causes (${c.cantmiss}). I'm anchoring my history and exam on the high-risk red flags — ${c.redflags} — precisely because missing them is catastrophic even if individually less likely. Before I order anything: is my prioritisation defensible, and am I anchoring too hard on the most likely diagnosis at the expense of the most dangerous one?`,
    `Building on your point about prioritisation, my disposition will be driven by the ${c.score} plus shared decision-making, and I'm arranging ${c.workup}. For each can't-miss diagnosis, tell me which single result would most efficiently raise or lower its likelihood, so I order the highest-yield test first rather than shotgunning — and avoid the downstream harms of over-testing low-risk patients.`,
    `You raised the equivocal result — assume my decisive test lands in that grey zone. Talk me through a Bayesian approach: how do serial values, the time course, and the ${c.score} change my post-test probability, and at what threshold of residual risk is it actually safe to discharge versus observe versus admit? I want a number I can defend to a colleague.`,
    `For the working diagnosis of ${c.keyDx}, building on the management you outlined, give me concrete first steps — ${c.rx} — including what to do if the patient deteriorates. Which early complication is most likely to kill this specific patient, and how do I monitor for and pre-empt it?`,
    `Now challenge me on what you've told me: argue the case that I'm wrong and it's actually one of the other can't-miss diagnoses. What single piece of data might I be under-weighting, and what's my cognitive bias here?`,
    `Following that challenge: how do I communicate residual risk honestly to the patient, what explicit safety-netting and time-bound follow-up do I document, and what objective criteria trigger an immediate return or escalation?`,
  ],
};

// Explicit physician learning summary (satisfies tier-2 C6). Only appended for reflect:true physicians.
const SUMMARY = {
  average: c => `So to summarize what I've learned: I should keep ${c.keyDx} high on my list but not anchor on it, and work through the can't-miss causes more systematically. I'll apply this by running an explicit red-flag screen before I commit to a diagnosis next time.`,
  good: c => `So to summarize what I've learned: my approach to ${c.short} should lead with the ${c.score} for risk stratification, explicitly work through ${c.cantmiss}, and use ${c.workup} to update my probabilities rather than confirm a hunch. I'll apply this by documenting my red-flag screen and serial-testing plan and by setting clear disposition thresholds. This clarified my reasoning.`,
  top: c => `So to summarize and consolidate my learning: the key insight is to manage ${c.short} by the *most dangerous* diagnosis first, not the most likely — lead with the ${c.score}, screen relentlessly for ${c.redflags}, and treat ${c.workup} as Bayesian probability-updaters with explicit post-test thresholds for disposition. I'll apply this by building a personal checklist for ${c.cantmiss}, pre-committing to serial-testing and safety-netting criteria, and auditing my own anchoring bias. The most valuable correction was reframing the equivocal result as a probability question rather than a binary, and I'll teach that approach to my juniors.`,
};

const ACTIVE_SECONDS = { // per-PLE active engagement; weak deliberately below the 900s tier-1 gate
  weak:    (n, k) => 600 + n * 25 + k * 40,
  average: (n, k) => 960 + n * 35 + k * 60,
  good:    (n, k) => 1260 + n * 45 + k * 70,
  top:     (n, k) => 1610 + n * 55 + k * 90,
};

// budget = effective AI-token allowance, graduated by how actively the admin "managed"/coached the
// physician (the pilot's 10k/person is the unmanaged floor — see the budget finding in the report).
// reflect = the physician writes an explicit learning summary (tier-2 C6). Passers get 2 PLEs for a
// real longitudinal (LPDP) trend; non-passers get 1.
const PHYS = [
  { n: '01', tier: 'weak',    budget: 10000, reflect: false, cases: ['chestpain'] },
  { n: '02', tier: 'weak',    budget: 10000, reflect: false, cases: ['dyspnea'] },
  { n: '03', tier: 'average', budget: 18000, reflect: false, cases: ['fevercough'] },
  { n: '04', tier: 'average', budget: 18000, reflect: false, cases: ['abdo'] },
  { n: '05', tier: 'average', budget: 28000, reflect: true,  cases: ['headache'] },        // reflective average -> low-end evaluated
  { n: '06', tier: 'good',    budget: 60000, reflect: true,  cases: ['chestpain', 'fevercough'] },
  { n: '07', tier: 'good',    budget: 60000, reflect: true,  cases: ['dyspnea', 'abdo'] },
  { n: '08', tier: 'good',    budget: 60000, reflect: true,  cases: ['fevercough', 'headache'] },
  { n: '09', tier: 'top',     budget: 72000, reflect: true,  cases: ['abdo', 'headache'] },
  { n: '10', tier: 'top',     budget: 72000, reflect: true,  cases: ['chestpain', 'dyspnea'] },
];

async function drivePhysician(p) {
  const email = `soakdoc${p.n}@example.com`;
  const login = await api('POST', '/auth/login', { body: { email, password: PW } });
  const token = login.body?.access_token;
  if (!token) return { email, tier: p.tier, error: `login failed: ${JSON.stringify(login.body)}` };
  const me = await api('GET', '/auth/me', { token });
  const pseudonym = me.body?.user?.pseudonym ?? null;

  let spent = 0, cross10kAt = null;
  const ples = [];
  for (let k = 0; k < p.cases.length; k++) {
    const c = CASES[p.cases[k]];
    const created = await api('POST', '/ples', { token, body: { chief_complaint: c.chief } });
    const pleId = created.body?.id;
    if (!pleId) { ples.push({ case: p.cases[k], error: `create failed: ${JSON.stringify(created.body)}` }); continue; }

    const turns = SCRIPT[p.tier](c).slice();
    if (p.reflect && SUMMARY[p.tier]) turns.push(SUMMARY[p.tier](c)); // closing learning summary (C6)
    let sent = 0, pleTokens = 0;
    for (const msg of turns) {
      if (spent >= p.budget) break;                 // per-management budget cap
      const r = await api('POST', `/ples/${pleId}/message`, { token, body: { message: msg, language: 'en' } });
      if (r.status !== 200) { ples.push({ id: pleId, case: p.cases[k], error: `msg ${sent + 1}: ${r.status} ${JSON.stringify(r.body)}` }); break; }
      const aTok = r.body?.token_count ?? 0;
      const pTok = physTokens(msg);
      spent += aTok + pTok; pleTokens += aTok + pTok; sent++;
      if (cross10kAt === null && spent >= 10000) cross10kAt = { ple: k + 1, turn: sent };
      await sleep(250);
    }

    const active = ACTIVE_SECONDS[p.tier](Number(p.n), k);
    const ended = await api('POST', `/ples/${pleId}/end`, { token, body: { active_seconds: active } });
    ples.push({
      id: pleId, case: p.cases[k], turns: sent, ple_tokens: pleTokens,
      active_seconds: active, end_status: ended.body?.status ?? null,
      criteria: ended.body?.criteria ?? null,
    });
  }
  return { email, tier: p.tier, pseudonym, budget: p.budget, spent, cross10kAt, ples };
}

// concurrency pool (independent sessions, safe in parallel; cap to be gentle on RIMPL/Claude)
async function pool(items, size, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  console.log(`Driving ${PHYS.length} physicians (pool=4) against ${BASE} ...`);
  const t0 = Date.now();
  const results = await pool(PHYS, 4, drivePhysician);
  const secs = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync('/tmp/soak-results.json', JSON.stringify(results, null, 2));
  console.log(`\nDone in ${secs}s. Per-physician outcome:`);
  for (const r of results) {
    if (r.error) { console.log(`  ${r.email} (${r.tier}): ERROR ${r.error}`); continue; }
    const statuses = r.ples.map(x => x.end_status ?? x.error ?? '?').join(', ');
    console.log(`  ${String(r.pseudonym ?? r.email).padEnd(8)} ${r.tier.padEnd(8)} spent=${String(r.spent).padEnd(6)} budget=${r.budget}  [${statuses}]${r.cross10kAt ? `  (hit 10k at PLE${r.cross10kAt.ple} turn${r.cross10kAt.turn})` : ''}`);
  }
  console.log('\nWrote /tmp/soak-results.json');
  process.exit(0);
})().catch(e => { console.error('DRIVE FAILED:', e.message); process.exit(1); });
