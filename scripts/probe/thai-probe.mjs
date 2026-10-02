#!/usr/bin/env node
// thai-probe.mjs — the other half of Gate 0.
//
// CLICS is bilingual and the physicians are Thai. Thai is where open-weight models most often
// disappoint: they read Thai adequately and then answer in English, or answer in Thai that is
// grammatical but not clinical. A JSON parse rate cannot detect either.
//
// What IS automatable, and what this script measures per reply:
//   1. Did it answer in Thai at all?           (Thai-codepoint share of the reply)
//   2. Is there a (Source, Year) citation?     — services/post-filter.js hasCitation
//   3. Does it close with a ❓ Socratic line?   — services/post-filter.js extractSocraticQuestion
// (2) and (3) are the exact checks routes/chat.js runs; when either fails, chat.js burns a SECOND
// model call to retry. A model that fails them routinely doubles latency and spend on the highest-
// volume call site in the product, so the first-pass rate below is the number that matters.
//
// What is NOT automatable: whether the Thai is clinically usable. This script therefore PRINTS every
// reply in full. A Thai-speaking clinician has to read them. That judgement is the gate.
//
// The prompts below are synthetic, textbook-level clinical questions written for this probe. They
// contain no patient identifiers and no real case material — nothing here needs de-identification,
// and nothing here should ever be replaced with a real PLE turn.
//
// Usage:
//   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… node scripts/probe/thai-probe.mjs
//     --prompts <file>    newline-separated prompts to use instead of the built-ins
//     --n <k>             use only the first k prompts (default: all)
//     --artifacts         append ARTIFACT_GUIDANCE, matching the superadmin clinical-artifacts toggle
//     --max-tokens <n>    default 4000 (chat.js RIMPL_CHAT_MAX_TOKENS default)
//     --temperature <t>   default: unset (server default), as chat.js sends
//     --quiet             suppress the full replies and print only the scorecard
//     --out <file>        write a JSON report

import { readFile } from 'node:fs/promises';

import {
  readConfig, printTarget, chatCompletion, hr, table, parseArgs, writeReport, fail,
  bold, dim, green, red, yellow, percentile, mean, distribution, ms, pct, progress, progressDone,
} from './lib.mjs';

// --- single-source imports from rimpl (never copy these) --------------------
import { RIMPL_SYSTEM_PROMPT_EXAMINER, ARTIFACT_GUIDANCE } from '../../rimpl/src/lib/prompts.js';
import { hasCitation, extractSocraticQuestion, extractReferences, thaiShare, THAI_MIN_SHARE } from '../../rimpl/src/services/post-filter.js';

// chat.js: CHAT_MAX_TOKENS = max(1500, RIMPL_CHAT_MAX_TOKENS ?? 4000)
const CHAT_MAX_TOKENS = 4000;

// Synthetic Thai clinical turns — no PII, no real case material.
const BUILTIN_PROMPTS = [
  'ผู้ป่วยชายอายุ 62 ปี มาด้วยอาการเจ็บแน่นหน้าอกขณะออกแรงมา 3 สัปดาห์ ดีขึ้นเมื่อพัก ควรนึกถึงภาวะใดบ้าง และจะประเมินความเสี่ยงก่อนส่งตรวจเพิ่มเติมอย่างไร',
  'การเลือกยาต้านการแข็งตัวของเลือดในผู้ป่วย atrial fibrillation ที่มีโรคไตเรื้อรังระยะที่ 4 ต่างจากผู้ป่วยที่การทำงานของไตปกติอย่างไร และต้องปรับขนาดยาตามค่าใด',
  'หญิงตั้งครรภ์อายุครรภ์ 28 สัปดาห์ ตรวจพบความดันโลหิต 150/95 mmHg และโปรตีนในปัสสาวะ 2+ ควรวินิจฉัยแยกโรคอย่างไร และมีเกณฑ์ใดบ้างที่บ่งชี้ภาวะรุนแรง',
  'เด็กอายุ 3 ปี มีไข้สูงมา 5 วัน ตาแดงทั้งสองข้างโดยไม่มีขี้ตา ผื่นตามลำตัว ริมฝีปากแดงแตก และต่อมน้ำเหลืองที่คอโต ควรนึกถึงภาวะใดเป็นอันดับแรก และเกณฑ์วินิจฉัยประกอบด้วยอะไรบ้าง',
  'ผู้ป่วยเบาหวานชนิดที่ 2 ที่ยังมี HbA1c 8.5% ทั้งที่ได้ metformin เต็มขนาดแล้ว และมีประวัติโรคหลอดเลือดหัวใจร่วมด้วย ควรเลือกยากลุ่มใดเป็นลำดับถัดไป และเพราะเหตุใด',
  'ผู้ป่วยสูงอายุมาด้วยอาการสับสนเฉียบพลันภายใน 1 วัน จะแยก delirium ออกจาก dementia และภาวะซึมเศร้าได้อย่างไร และควรตรวจอะไรก่อน',
];

const { flags } = parseArgs();
const cfg = readConfig({ needModel: true });

const maxTokens = Math.max(256, Number(flags['max-tokens']) || CHAT_MAX_TOKENS);
const temperature = flags.temperature !== undefined && flags.temperature !== true ? Number(flags.temperature) : undefined;
const quiet = Boolean(flags.quiet);
const useArtifacts = Boolean(flags.artifacts);

let prompts = BUILTIN_PROMPTS;
if (flags.prompts && flags.prompts !== true) {
  try {
    prompts = (await readFile(String(flags.prompts), 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    fail(`cannot read --prompts ${flags.prompts}: ${e.message}`);
  }
  if (!prompts.length) fail(`--prompts ${flags.prompts} contained no non-empty lines.`);
}
const n = Math.max(1, Math.min(prompts.length, Number(flags.n) || prompts.length));
prompts = prompts.slice(0, n);

// chat.js builds exactly this for socratic (examiner) mode.
const systemPrompt = RIMPL_SYSTEM_PROMPT_EXAMINER + (useArtifacts ? ARTIFACT_GUIDANCE : '');

printTarget(cfg, {
  prompts: `${prompts.length} Thai clinical turn(s)`,
  mode: `examiner (socratic)${useArtifacts ? ' + ARTIFACT_GUIDANCE' : ''}`,
  max_tokens: String(maxTokens),
  temperature: temperature === undefined ? 'server default (as chat.js)' : String(temperature),
});

/* --------------------------------------------------------- Thai detection */

// `thaiShare` and the 0.30 bar are single-sourced from rimpl's post-filter (the production language
// guard in chat.js uses the same metric). The probe reports the RAW share, with nothing excluded.

/* -------------------------------------------------------------------- run */

const results = [];
for (const [i, prompt] of prompts.entries()) {
  progress(`[${i + 1}/${prompts.length}] asking…`);
  const r = await chatCompletion(cfg, {
    // Single turn, no history: each prompt is an independent sample. chat.js also prepends the
    // chief complaint and any RAG hits, both of which are session state a probe has no business
    // inventing — their absence makes this the HARDER case, not an easier one.
    systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature,
  });
  const text = r.text || '';
  const socratic = extractSocraticQuestion(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  results.push({
    i: i + 1,
    prompt,
    ok: r.ok,
    error: r.error,
    reasoningOnly: r.reasoningOnly,
    ms: r.ms,
    completionTokens: r.completionTokens,
    finishReason: r.finishReason,
    stopReason: r.stopReason,
    text,
    thai: thaiShare(text),
    citation: hasCitation(text),
    refs: extractReferences(text).map((x) => x.source),
    socratic,                                             // what chat.js requires
    endsWithQuestion: lines.length > 0 && lines[lines.length - 1].startsWith('❓'),
    truncated: r.stopReason === 'max_tokens',
  });
}
progressDone();

/* ---------------------------------------------------------------- replies */

if (!quiet) {
  for (const r of results) {
    hr(`reply ${r.i}/${results.length}`);
    console.log(`  ${dim('Q:')} ${r.prompt}\n`);
    if (!r.ok) {
      console.log(`  ${red('call failed:')} ${r.error}`);
      continue;
    }
    if (r.reasoningOnly) {
      console.log(`  ${red('empty content with reasoning_content present — rimpl would show the physician a blank reply.')}`);
      continue;
    }
    console.log(r.text.split('\n').map((l) => '  ' + l).join('\n'));
    console.log(`\n  ${dim(`${Math.round(r.ms)}ms · ${r.completionTokens} out · finish_reason=${r.finishReason}` +
      (r.truncated ? ' — TRUNCATED' : ''))}`);
  }
}

/* -------------------------------------------------------------- scorecard */

// Transport failures are reported BEFORE and independently of the scorecard, and are not silenced
// by --quiet: a scorecard full of em-dashes with the reason hidden behind a flag is the worst
// possible output. If nothing came back at all, there is no Thai to judge — say so and stop, rather
// than asking a clinician to review replies that do not exist.
const failedCalls = results.filter((r) => !r.ok);
if (failedCalls.length) {
  hr('call failures');
  for (const [err, n] of distribution(failedCalls.map((r) => r.error))) {
    console.log(`  ${red('✘')} ${n}× ${err}`);
  }
  console.log(`  ${dim('Run discover.mjs — a wrong base URL, a wrong model id, or a tailnet ACL that')}`);
  console.log(`  ${dim('permits the UI port but not the inference port covers almost every case.')}`);
}
if (failedCalls.length === results.length) {
  hr('🚦 GATE 0 — Thai output');
  console.log(`  ${red('not assessable:')} every call failed, so no reply exists to judge.`);
  console.log(`  ${dim('This says nothing about the model. Fix the endpoint and re-run.')}`);
  await writeReport(flags.out, {
    probe: 'thai', at: new Date().toISOString(),
    target: { baseUrl: cfg.baseUrl, model: cfg.model },
    summary: { answered: 0, notAssessable: true, errors: Object.fromEntries(distribution(failedCalls.map((r) => r.error))) },
  });
  process.exit(1);
}

hr('per-reply checks');
table(
  ['#', 'thai', 'citation', '❓ (chat.js)', '❓ last line', 'out tok', 'ms', 'finish'],
  results.map((r) => [
    String(r.i),
    !r.ok ? red('—') : (r.thai >= THAI_MIN_SHARE ? green(`${(r.thai * 100).toFixed(0)}%`) : red(`${(r.thai * 100).toFixed(0)}%`)),
    !r.ok ? red('—') : (r.citation ? green('yes') : red('no')),
    !r.ok ? red('—') : (r.socratic ? green('yes') : red('no')),
    !r.ok ? red('—') : (r.endsWithQuestion ? green('yes') : yellow('no')),
    r.completionTokens || '—',
    r.ok ? Math.round(r.ms) : '—',
    r.finishReason ?? red(r.error ? 'error' : '—'),
  ]),
  ['r', 'r', 'l', 'l', 'l', 'r', 'r', 'l'],
);
console.log(`  ${dim('thai         = Thai codepoints ÷ (Thai + Latin letters). Latin drug/lab names are normal.')}`);
console.log(`  ${dim('citation     = post-filter.hasCitation — a "(Source, Year)" pattern anywhere in the reply.')}`);
console.log(`  ${dim('❓ (chat.js)  = post-filter.extractSocraticQuestion — the LAST line beginning with ❓,')}`);
console.log(`  ${dim('               scanning upward. This is the check chat.js actually enforces.')}`);
console.log(`  ${dim('❓ last line  = stricter: the final non-empty line begins with ❓. chat.js does not')}`);
console.log(`  ${dim('               require this, but a model that trails prose after the question reads badly.')}`);

const answered = results.filter((r) => r.ok && !r.reasoningOnly);
const cited = answered.filter((r) => r.citation).length;
const socr = answered.filter((r) => r.socratic).length;
const inThai = answered.filter((r) => r.thai >= THAI_MIN_SHARE).length;
const clean = answered.filter((r) => r.citation && r.socratic).length;

hr('first-pass format compliance');
table(
  ['check', 'pass', 'rate', 'cost of failing'],
  [
    ['answered in Thai', `${inThai}/${answered.length}`, pct(inThai, answered.length), dim('chat.js retries once (th only) → a second paid/queued call')],
    ['(Source, Year) citation', `${cited}/${answered.length}`, pct(cited, answered.length), dim('chat.js retries → a second paid/queued call')],
    ['closing ❓ (examiner)', `${socr}/${answered.length}`, pct(socr, answered.length), dim('chat.js retries → a second paid/queued call')],
    [bold('both, first pass'), bold(`${clean}/${answered.length}`), bold(pct(clean, answered.length)), dim('the share of turns that cost ONE call instead of two')],
  ],
  ['l', 'r', 'r', 'l'],
);
const retryRate = answered.length ? 1 - clean / answered.length : 0;
console.log(`\n  ${retryRate > 0.25 ? yellow('⚠') : ' '} ${Math.round(retryRate * 100)}% of turns would trigger chat.js's one-shot retry.`);
console.log(`  ${dim('chat.js retries once when the citation or the ❓ is missing (routes/chat.js:78-95).')}`);
console.log(`  ${dim('That is a correctness safety net, not a budget line — but on the highest-volume call')}`);
console.log(`  ${dim('site it roughly doubles latency and GPU occupancy for every turn that needs it.')}`);

const speeds = answered.filter((r) => r.ms > 0 && r.completionTokens > 0).map((r) => r.completionTokens / (r.ms / 1000));
if (speeds.length) {
  hr('speed');
  table(['latency p50', 'latency p95', 'tok/s p50', 'tok/s mean'],
    [[ms(percentile(answered.map((r) => r.ms), 50)), ms(percentile(answered.map((r) => r.ms), 95)),
      percentile(speeds, 50).toFixed(1), mean(speeds).toFixed(1)]],
    ['r', 'r', 'r', 'r']);
  console.log(`  ${dim('Thai tokenises poorly in most tokenizers — expect noticeably fewer characters per token')}`);
  console.log(`  ${dim('than English. Compare tok/s against the JSON probe, not against an English benchmark.')}`);
}

/* ------------------------------------------------------------ human gate */

hr('🚦 GATE 0 — Thai output');
const failures = [];
if (!answered.length) failures.push('no usable reply — every call returned empty content');
if (answered.length && inThai < answered.length) failures.push(`${answered.length - inThai} repl(ies) were not substantially in Thai`);
if (results.some((r) => r.reasoningOnly)) failures.push('the server returned reasoning_content with empty content — rimpl would render blank replies');

if (failures.length) {
  console.log(`  ${red('automated checks FAILED:')}`);
  for (const f of failures) console.log(`    ${red('·')} ${f}`);
} else {
  console.log(`  ${green('automated checks passed')} ${dim('(answered in Thai, non-empty content)')}`);
}
console.log(`\n  ${bold('The automated part is not the gate.')}`);
console.log(`  ${dim('The gate is: a Thai-speaking clinician reads the replies above and answers —')}`);
console.log(`  ${dim('  · is the Thai natural, or translated-sounding?')}`);
console.log(`  ${dim('  · is the clinical content correct, and at the level of a senior colleague?')}`);
console.log(`  ${dim('  · are the cited sources real, or plausible-looking fabrications?')}`);
console.log(`  ${dim('    (hasCitation only checks the SHAPE "(Source, Year)". A confidently invented')}`);
console.log(`  ${dim('     reference passes it. Somebody must check the sources are real.)')}`);
console.log(`  ${dim('  · does the closing ❓ genuinely push the reasoning one level deeper?')}`);
console.log(`\n  ${dim('Re-run with --quiet once a human has signed off, to keep the scorecard alone.')}`);
console.log(`\n  ${bold('next:')} node scripts/probe/throughput.mjs   ${dim('(sizing, not a gate)')}`);

await writeReport(flags.out, {
  probe: 'thai', at: new Date().toISOString(),
  target: { baseUrl: cfg.baseUrl, model: cfg.model },
  config: { maxTokens, temperature: temperature ?? null, artifacts: useArtifacts, prompts: prompts.length, thaiMinShare: THAI_MIN_SHARE },
  summary: {
    answered: answered.length, inThai, cited, socratic: socr, cleanFirstPass: clean,
    retryRate,
    automatedFailures: failures,
    humanReviewRequired: true,
  },
  // Replies ARE recorded here: they are model output to synthetic prompts, contain no patient data,
  // and a clinician often reviews them away from the terminal.
  replies: results.map((r) => ({
    i: r.i, prompt: r.prompt, ok: r.ok, error: r.error ?? null,
    ms: Math.round(r.ms), completionTokens: r.completionTokens,
    finishReason: r.finishReason ?? null, truncated: r.truncated,
    thaiShare: r.thai, citation: r.citation, refs: r.refs,
    socraticQuestion: r.socratic, endsWithQuestion: r.endsWithQuestion,
    text: r.text,
  })),
});

process.exit(failures.length ? 1 : 0);
