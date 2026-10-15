// probe/lib.mjs chatCompletion — the harness transport must return the text PRODUCTION would return.
//
// Hermetic: globalThis.fetch is stubbed; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { chatCompletion, readConfig, stripThink } from './lib.mjs';

const require = createRequire(import.meta.url);
const production = require('../../rimpl/src/lib/think-markup.js');
const transport = require('../../rimpl/src/services/providers/local-factory.js');

const SECRET = 'the physician is probably Somchai';
const cfg = (over = {}) => ({ baseUrl: 'http://probe.invalid/v1', model: 'm', apiKey: '', timeoutMs: 5000, thinkPreopened: false, ...over });

async function withServed(content, fn, { reasoning_content } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK', headers: new Headers(),
    text: async () => JSON.stringify({ model: 'm', choices: [{ message: { content, ...(reasoning_content ? { reasoning_content } : {}) }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  });
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const call = (c) => chatCompletion(c, { messages: [{ role: 'user', content: 'q' }] });

test('ONE definition: the harness strips with production\'s function, the one the transport re-exports', () => {
  assert.equal(stripThink, production.stripThink);
  assert.equal(transport.stripThink, production.stripThink);
});

test('a reply without markup is returned exactly as served', async () => {
  const r = await withServed('  Plain <b> reply  ', () => call(cfg()));
  assert.equal(r.text, '  Plain <b> reply  ');
  assert.equal(r.rawText, '  Plain <b> reply  ');
  assert.equal(r.reasoningOnly, false);
});

test('`text` is what rimpl RETURNS (markup stripped); `rawText` is the content as served', async () => {
  const served = `<think>${SECRET}</think>\n\nAnswer (KDIGO, 2022)`;
  const r = await withServed(served, () => call(cfg()));
  assert.equal(r.text, 'Answer (KDIGO, 2022)');
  assert.equal(r.rawText, served);
  assert.equal(r.thinkPreopened, false);
});

test('content that was nothing but inline reasoning is reasoningOnly, like content:null + reasoning_content', async () => {
  assert.equal((await withServed(`<think>${SECRET}`, () => call(cfg()))).reasoningOnly, true);
  assert.equal((await withServed(null, () => call(cfg()), { reasoning_content: SECRET })).reasoningOnly, true);
  assert.equal((await withServed('', () => call(cfg()))).reasoningOnly, false);   // empty is empty, not reasoning
});

test('thinkPreopened mirrors the server knob: nothing before the first </think>; never closed = reasoningOnly + reasoningUnclosed', async () => {
  const r = await withServed(`${SECRET}\n</think>\n\nAnswer.`, () => call(cfg({ thinkPreopened: true })));
  assert.equal(r.text, 'Answer.');
  assert.equal(r.reasoningUnclosed, undefined);
  const u = await withServed(`${SECRET} and never closed`, () => call(cfg({ thinkPreopened: true })));
  assert.equal(u.text, '');
  assert.equal(u.reasoningOnly, true);
  assert.equal(u.reasoningUnclosed, true);
  // Knob off, same template-opened reply: production's rule 1 still drops everything before the tag.
  assert.equal((await withServed(`${SECRET}\n</think>\n\nAnswer.`, () => call(cfg()))).text, 'Answer.');
});

test('readConfig reads LOCAL_AI_THINK_PREOPENED — the same variable rimpl\'s evaluator instance reads', () => {
  const saved = { b: process.env.LOCAL_AI_BASE_URL, m: process.env.LOCAL_AI_MODEL, p: process.env.LOCAL_AI_THINK_PREOPENED };
  try {
    process.env.LOCAL_AI_BASE_URL = 'http://probe.invalid/v1';
    process.env.LOCAL_AI_MODEL = 'm';
    delete process.env.LOCAL_AI_THINK_PREOPENED;
    assert.equal(readConfig().thinkPreopened, false);
    process.env.LOCAL_AI_THINK_PREOPENED = '1';
    assert.equal(readConfig().thinkPreopened, true);
  } finally {
    for (const [k, v] of [['LOCAL_AI_BASE_URL', saved.b], ['LOCAL_AI_MODEL', saved.m], ['LOCAL_AI_THINK_PREOPENED', saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('readConfig({ prefix }) reads the named rimpl instance\'s variables — LOCAL_TUTOR_AI_* for the tutor', () => {
  const KEYS = ['LOCAL_TUTOR_AI_BASE_URL', 'LOCAL_TUTOR_AI_MODEL', 'LOCAL_TUTOR_AI_API_KEY', 'LOCAL_TUTOR_AI_THINK_PREOPENED',
    'LOCAL_TUTOR_AI_THINKING_STYLE', 'LOCAL_AI_THINKING_STYLE'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    process.env.LOCAL_TUTOR_AI_BASE_URL = 'http://tutor.invalid/v1/';
    process.env.LOCAL_TUTOR_AI_MODEL = 'qwen-tutor';
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'Chat_Template_Kwargs';
    const c = readConfig({ prefix: 'LOCAL_TUTOR_AI_' });
    assert.deepEqual([c.prefix, c.baseUrl, c.model, c.thinkingStyle, c.thinkPreopened], ['LOCAL_TUTOR_AI_', 'http://tutor.invalid/v1', 'qwen-tutor', 'chat_template_kwargs', false]);
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'qwen';
    assert.equal(readConfig({ prefix: 'LOCAL_TUTOR_AI_' }).thinkingStyle, null, 'not a style: null, so a caller that needs one can refuse');
    delete process.env.LOCAL_TUTOR_AI_THINKING_STYLE;
    assert.equal(readConfig({ prefix: 'LOCAL_TUTOR_AI_' }).thinkingStyle, 'none');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
