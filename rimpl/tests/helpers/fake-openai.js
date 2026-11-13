'use strict';

// A loopback stand-in for an OpenAI-compatible model server (vLLM's surface), for the readiness tests.
// It answers each RIMPL purpose by the head of its system prompt, so every route gets a reply its parser
// accepts, and reports usage.prompt_tokens as bytes / 4 so the context row has a server count to read.
// state.mode: 'ok' | 'empty' (200, no reply text) | 'error' (500). state.delayMs delays every
// completion; state.requests counts completions.
const http = require('http');

const SCORES = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3 };

function replyFor(system) {
  if (system.startsWith('You are a PIS-7 calibration tutor')) return 'คะแนน d2 ต่างกันเพราะหลักฐานในบทสนทนาสมมุติมีน้อย (Rubric, 2024).';
  if (system.startsWith('You are PIS-7 Evaluator')) {
    return JSON.stringify({ ...SCORES, rationale: Object.fromEntries(Object.keys(SCORES).map((k) => [k, 'fictional rationale'])) });
  }
  if (system.startsWith('Analyze this physician-AI conversation')) return JSON.stringify({ c4: true, c5: true, c6: true, c7: true, on_topic: true });
  return 'ควรประเมินความรุนแรงด้วย CURB-65 ในกรณีสมมุตินี้ (BTS, 2009). ❓ ท่านจะพิจารณาปัจจัยใดเพิ่ม';
}

const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

function startFakeOpenAI({ model = 'fake-model', maxModelLen = 32768 } = {}) {
  // showContext: the context_length an Ollama-style /api/show reports (null: no such route).
  // promptTokens: a fixed usage.prompt_tokens instead of bytes / 4.
  const state = { mode: 'ok', delayMs: 0, requests: 0, maxModelLen, showContext: null, promptTokens: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const send = (status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
        res.end(data);
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, { object: 'list', data: [{ id: model, object: 'model', ...(state.maxModelLen ? { max_model_len: state.maxModelLen } : {}) }] });
      }
      if (req.method === 'POST' && req.url === '/api/show' && state.showContext) {
        return send(200, { model_info: { 'llama.context_length': state.showContext } });
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: 'not found' });
      state.requests += 1;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.mode === 'error') return send(500, { error: { message: 'fake failure' } });
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages.find((m) => m.role === 'system')?.content || '';
      const content = state.mode === 'empty' ? '' : replyFor(String(system));
      const promptTokens = state.promptTokens ?? Math.ceil(messages.reduce((n, m) => n + bytes(m.content), 0) / 4);
      send(200, {
        id: 'fake', object: 'chat.completion', model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(bytes(content) / 4), total_tokens: 0 },
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state, port, url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startFakeOpenAI };
