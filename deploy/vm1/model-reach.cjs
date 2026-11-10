// Can rimpl, from where it runs on vm1, reach both on-prem models? Run INSIDE the running rimpl container,
// so it uses exactly rimpl's env and network (deploy/vm1/README.md, "On-prem model block"):
//
//   docker exec -i "$(docker ps -q --filter label=com.docker.compose.project=clics \
//     --filter label=com.docker.compose.service=rimpl)" node - < model-reach.cjs
//
// For the evaluator (LOCAL_AI_*) and the tutor (LOCAL_TUTOR_AI_*): GET <base>/models, then one
// POST <base>/chat/completions. Prints statuses, the model id, finish_reason and lengths. Never prints a
// key, a base URL, a host or a server's error text: a failed request is named by its error code only.
// Routes nothing and writes nothing. Exit 0 when both endpoints answer 200 on both calls, list their
// model and return a non-empty reply; 1 otherwise.
'use strict';

const MODELS_TIMEOUT_MS = Number(process.env.REACH_MODELS_TIMEOUT_MS || 15000);
const CHAT_TIMEOUT_MS = Number(process.env.REACH_CHAT_TIMEOUT_MS || 180000);
const MAX_TOKENS = Number(process.env.REACH_MAX_TOKENS || 1024);

const ENDPOINTS = [['evaluator', 'LOCAL_AI_'], ['tutor', 'LOCAL_TUTOR_AI_']];

const log = (s) => console.log(`[reach] ${s}`);
const failure = (e) => (e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code || e?.name || 'error');

async function request(url, { apiKey, body, timeoutMs }) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch { /* a non-JSON body is reported as its status alone */ }
  return { status: res.status, json };
}

async function reach(label, prefix) {
  const baseUrl = String(process.env[`${prefix}BASE_URL`] || '').trim().replace(/\/+$/, '');
  const model = String(process.env[`${prefix}MODEL`] || '').trim();
  const apiKey = String(process.env[`${prefix}API_KEY`] || '').trim();
  if (!baseUrl || !model) {
    log(`${label}: NOT DECLARED (${prefix}BASE_URL or ${prefix}MODEL has no value)`);
    return false;
  }
  log(`${label} (${prefix}*): model ${model}`);
  let ok = true;
  try {
    const r = await request(`${baseUrl}/models`, { apiKey, timeoutMs: MODELS_TIMEOUT_MS });
    const listed = Array.isArray(r.json?.data) && r.json.data.some((m) => m?.id === model);
    log(`${label} GET /models: ${r.status}, model listed: ${listed ? 'yes' : 'NO'}`);
    ok = r.status === 200 && listed;
  } catch (e) {
    log(`${label} GET /models: FAILED (${failure(e)})`);
    ok = false;
  }
  try {
    const started = Date.now();
    const r = await request(`${baseUrl}/chat/completions`, {
      apiKey,
      timeoutMs: CHAT_TIMEOUT_MS,
      body: { model, messages: [{ role: 'user', content: 'Reply with one word: ready' }], max_tokens: MAX_TOKENS, temperature: 0 },
    });
    const choice = r.json?.choices?.[0];
    const content = String(choice?.message?.content ?? '').trim();
    const reasoning = String(choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '');
    log(`${label} POST /chat/completions: ${r.status}, finish_reason ${choice?.finish_reason ?? 'none'}, content ${content ? `${content.length} chars` : 'EMPTY'}, reasoning ${reasoning.length} chars, ${Date.now() - started} ms`);
    ok = ok && r.status === 200 && content.length > 0;
  } catch (e) {
    log(`${label} POST /chat/completions: FAILED (${failure(e)})`);
    ok = false;
  }
  return ok;
}

(async () => {
  const results = [];
  for (const [label, prefix] of ENDPOINTS) results.push(await reach(label, prefix));
  const pass = results.every(Boolean);
  log(pass ? 'PASS: both on-prem endpoints answered' : 'FAIL: see the lines above');
  process.exit(pass ? 0 : 1);
})();
