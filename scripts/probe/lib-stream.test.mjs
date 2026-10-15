// probe/lib.mjs chatCompletionStream — the TTFT probe. Two clocks, measured separately: the first
// sign of REASONING and the first VISIBLE reply text, as rimpl's transport would see them.
//
// Hermetic: a mock OpenAI-compatible server on 127.0.0.1 (kernel-assigned port) streams scripted
// chunks with real delays. Nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { chatCompletionStream, chatCompletion } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const content = (t) => line({ model: 'tutor-x', choices: [{ delta: { content: t } }] });
const reasoning = (t, field = 'reasoning_content') => line({ choices: [{ delta: { [field]: t } }] });
const finish = (usage = { prompt_tokens: 11, completion_tokens: 7 }) =>
  [line({ choices: [{ delta: {}, finish_reason: 'stop' }], usage, system_fingerprint: 'vllm-0.0.0-test' }), 'data: [DONE]\n\n'];

/** Start a server that answers each POST with `script` — an array of [delayMs, chunk] — and records the
 *  request bodies. Returns { cfg, bodies, close }. */
async function serve(script, { status = 200, contentType = 'text/event-stream', json } = {}) {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw || '{}'));
    if (json) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); return; }
    res.writeHead(status, { 'content-type': contentType });
    if (status !== 200) { res.end('{"error":"nope"}'); return; }
    for (const [delay, chunk] of script) {
      if (delay) await sleep(delay);
      res.write(chunk);
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const cfg = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'tutor-x', apiKey: '', timeoutMs: 5000, thinkPreopened: false, thinkingStyle: 'none' };
  return { cfg, bodies, close: () => new Promise((r) => server.close(r)) };
}

const ask = { systemPrompt: 'S', messages: [{ role: 'user', content: 'q' }], maxTokens: 256 };

test('reasoning first, then content: two clocks, in order, each at its own chunk', async () => {
  const s = await serve([
    [0, ': keep-alive\n\n'],
    [60, reasoning('Let me weigh ')],
    [20, reasoning('the options.')],
    [120, content('Start amoxicillin')],
    [20, content(' (BTS, 2019).')],
    [0, finish().join('')],
  ]);
  try {
    const r = await chatCompletionStream(s.cfg, ask);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.streamed, true);
    assert.equal(r.text, 'Start amoxicillin (BTS, 2019).');
    assert.equal(r.reasoning, 'Let me weigh the options.');
    assert.ok(r.ttft_reasoning_ms >= 50, `reasoning clock ${r.ttft_reasoning_ms}`);
    assert.ok(r.ttft_content_ms >= r.ttft_reasoning_ms + 100, `content ${r.ttft_content_ms} vs reasoning ${r.ttft_reasoning_ms}`);
    assert.ok(r.total_ms >= r.ttft_content_ms);
    assert.equal(r.ms, r.total_ms);
    assert.deepEqual(r.usage, { prompt_tokens: 11, completion_tokens: 7 });
    assert.deepEqual([r.promptTokens, r.completionTokens, r.finishReason, r.stopReason], [11, 7, 'stop', 'end_turn']);
    assert.equal(r.model, 'tutor-x');
    assert.equal(r.raw.system_fingerprint, 'vllm-0.0.0-test');
    // The request is the one rimpl's streamed transport sends.
    assert.deepEqual(s.bodies[0], {
      model: 'tutor-x', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }],
      max_tokens: 256, stream: true, stream_options: { include_usage: true },
    });
  } finally { await s.close(); }
});

test('no reasoning at all (thinking off): the reasoning clock stays null', async () => {
  const s = await serve([[40, content('Hi')], [0, content('.')], [0, finish().join('')]]);
  try {
    const r = await chatCompletionStream(s.cfg, ask);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.ttft_reasoning_ms, null);
    assert.ok(r.ttft_content_ms >= 30);
    assert.equal(r.reasoning, '');
    assert.equal(r.text, 'Hi.');
  } finally { await s.close(); }
});

test('`reasoning` (Ollama / gateways) counts like reasoning_content', async () => {
  const s = await serve([[30, reasoning('hmm', 'reasoning')], [60, content('Answer.')], [0, finish().join('')]]);
  try {
    const r = await chatCompletionStream(s.cfg, ask);
    assert.equal(r.reasoning, 'hmm');
    assert.ok(r.ttft_reasoning_ms != null && r.ttft_content_ms > r.ttft_reasoning_ms);
  } finally { await s.close(); }
});

test('inline <think> markup (no reasoning parser): withheld from the content clock, starts the reasoning clock', async () => {
  const s = await serve([
    [30, content('<thi')], [0, content('nk>weighing it')], [80, content('</think>\n\n')], [40, content('Answer (X, 2020).')],
    [0, finish().join('')],
  ]);
  try {
    const r = await chatCompletionStream(s.cfg, ask);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, 'Answer (X, 2020).', 'what rimpl would return: production stripThink');
    assert.match(r.rawText, /<think>weighing it<\/think>/);
    assert.ok(r.ttft_reasoning_ms >= 20);
    assert.ok(r.ttft_content_ms >= r.ttft_reasoning_ms + 100, 'the leading whitespace after </think> is not "content" either');
  } finally { await s.close(); }
});

test('a pre-opened block (thinkPreopened): reasoning from the first piece, content only after </think>', async () => {
  const s = await serve([[30, content('still thinking')], [70, content('</think>Answer.')], [0, finish().join('')]]);
  try {
    const r = await chatCompletionStream({ ...s.cfg, thinkPreopened: true }, ask);
    assert.equal(r.text, 'Answer.');
    assert.ok(r.ttft_reasoning_ms >= 20 && r.ttft_reasoning_ms < r.ttft_content_ms);
  } finally { await s.close(); }
  // Never closed: nothing visible (content clock null), reasoning-only — production would throw reasoning_only.
  const u = await serve([[10, content('thinking until max_tokens')], [0, finish().join('')]]);
  try {
    const r = await chatCompletionStream({ ...u.cfg, thinkPreopened: true }, ask);
    assert.deepEqual([r.ok, r.text, r.reasoningOnly, r.reasoningUnclosed, r.ttft_content_ms], [true, '', true, true, null]);
    assert.ok(r.ttft_reasoning_ms != null);
  } finally { await u.close(); }
});

test('thinking control: sent as rimpl sends it — only when asked AND a style is configured', async () => {
  const s = await serve([[0, content('ok')], [0, finish().join('')]]);
  try {
    await chatCompletionStream({ ...s.cfg, thinkingStyle: 'chat_template_kwargs' }, { ...ask, thinking: true });
    assert.deepEqual(s.bodies.at(-1).chat_template_kwargs, { enable_thinking: true });
    await chatCompletionStream({ ...s.cfg, thinkingStyle: 'ollama' }, { ...ask, thinking: false });
    assert.equal(s.bodies.at(-1).think, false);
    await chatCompletionStream({ ...s.cfg, thinkingStyle: 'none' }, { ...ask, thinking: true });
    assert.equal('chat_template_kwargs' in s.bodies.at(-1) || 'think' in s.bodies.at(-1), false);
    await chatCompletionStream({ ...s.cfg, thinkingStyle: 'chat_template_kwargs' }, ask);
    assert.equal('chat_template_kwargs' in s.bodies.at(-1), false, 'not asked: nothing sent');
  } finally { await s.close(); }
});

test('the non-streamed chatCompletion sends thinking the same way (one definition)', async () => {
  const s = await serve([], { json: { model: 'tutor-x', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
  try {
    await chatCompletion({ ...s.cfg, thinkingStyle: 'chat_template_kwargs' }, { ...ask, thinking: false });
    assert.deepEqual(s.bodies.at(-1).chat_template_kwargs, { enable_thinking: false });
    await chatCompletion(s.cfg, ask);
    assert.deepEqual(Object.keys(s.bodies.at(-1)).sort(), ['max_tokens', 'messages', 'model', 'stream'], 'the pre-existing body, exactly');
  } finally { await s.close(); }
});

test('a server that ignores `stream` and answers one JSON completion: both clocks at its arrival', async () => {
  const s = await serve([], { json: { model: 'tutor-x', choices: [{ message: { content: 'Whole reply.', reasoning_content: 'r' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } } });
  try {
    const r = await chatCompletionStream(s.cfg, ask);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.streamed, false);
    assert.equal(r.text, 'Whole reply.');
    assert.equal(r.reasoning, 'r');
    assert.ok(r.ttft_content_ms != null && r.ttft_reasoning_ms != null);
    assert.deepEqual(r.usage, { prompt_tokens: 2, completion_tokens: 3 });
  } finally { await s.close(); }
});

test('failures are reported, never thrown: HTTP error, mid-stream error, cut-off body, unreachable', async () => {
  const bad = await serve([], { status: 503 });
  try {
    const r = await chatCompletionStream(bad.cfg, ask);
    assert.deepEqual([r.ok, r.status], [false, 503]);
    assert.match(r.error, /HTTP 503/);
  } finally { await bad.close(); }

  const mid = await serve([[0, content('partial')], [10, line({ error: { message: 'engine died' } })]]);
  try {
    const r = await chatCompletionStream(mid.cfg, ask);
    assert.equal(r.ok, false);
    assert.match(r.error, /engine died/);
    assert.equal(r.text, '', 'a failed call returns no text');
    assert.equal(r.rawText, 'partial');
    assert.ok(r.ttft_content_ms != null, 'the clock still says when text first showed');
  } finally { await mid.close(); }

  const cut = await serve([[0, content('half an answer')]]);
  try {
    const r = await chatCompletionStream(cut.cfg, ask);
    assert.equal(r.ok, false);
    assert.match(r.error, /ended before the server finished/);
  } finally { await cut.close(); }

  const gone = await serve([]);
  const cfg = gone.cfg;
  await gone.close();
  const r = await chatCompletionStream({ ...cfg, timeoutMs: 2000 }, ask);
  assert.equal(r.ok, false);
  assert.equal(r.ttft_content_ms, null);
  assert.equal(r.ttft_reasoning_ms, null);
});
