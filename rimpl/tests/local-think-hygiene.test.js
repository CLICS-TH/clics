// Reasoning hygiene and thinking control on the local transport (providers/local-factory.js), for
// BOTH instances: `local` (the evaluator) and `local-tutor`.
//
// HERMETIC: global.fetch is mocked; nothing touches the network.
//
// What is load-bearing here:
//   * a reasoning model served without a reasoning parser puts its chain-of-thought INSIDE `content`
//     as <think>…</think>. It must never be returned (stored, scored) and, when streamed, never be
//     SHOWN — while a reply with no tag stays byte-identical to before;
//   * streamed: a tag split across chunks is still caught, and what is emitted equals what is
//     returned (except the one case a stream cannot recall — a closing tag with no opening one);
//   * onReasoning() is told reasoning arrived — once, with no content;
//   * `thinking` is sent ONLY when the caller passed it AND the server style is configured: the
//     default request is byte-identical to before the field existed.

const {
  stripThink, createThinkFilter, thinkingEnabled, THINKING_STYLES, flagOn, closesThink,
} = require('../src/services/providers/local-factory');
const markup = require('../src/lib/think-markup');

const ENV = [
  'LOCAL_AI_BASE_URL', 'LOCAL_AI_MODEL', 'LOCAL_AI_TIMEOUT_MS', 'LOCAL_AI_THINKING_STYLE', 'LOCAL_AI_HTTP_PROXY',
  'LOCAL_AI_THINK_PREOPENED', 'LOCAL_MAX_RETRIES', 'LOCAL_RETRY_BASE_MS',
  'LOCAL_TUTOR_AI_BASE_URL', 'LOCAL_TUTOR_AI_MODEL', 'LOCAL_TUTOR_AI_TIMEOUT_MS', 'LOCAL_TUTOR_AI_THINKING_STYLE',
  'LOCAL_TUTOR_AI_HTTP_PROXY', 'LOCAL_TUTOR_AI_THINK_PREOPENED', 'LOCAL_TUTOR_MAX_RETRIES', 'LOCAL_TUTOR_RETRY_BASE_MS',
];
let savedEnv, realFetch, fetchMock, warnSpy;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.LOCAL_AI_BASE_URL = 'http://evaluator.tailnet:8000/v1';
  process.env.LOCAL_AI_MODEL = 'deepseek-evaluator';
  process.env.LOCAL_TUTOR_AI_BASE_URL = 'http://tutor.tailnet:9000/v1';
  process.env.LOCAL_TUTOR_AI_MODEL = 'qwen-tutor';
  for (const p of ['LOCAL_', 'LOCAL_TUTOR_']) { process.env[`${p}MAX_RETRIES`] = '2'; process.env[`${p}RETRY_BASE_MS`] = '1'; }
  realFetch = global.fetch;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  warnSpy.mockRestore();
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  jest.resetModules();
});

function load(which) {
  jest.resetModules();
  return require(`../src/services/providers/${which}`);
}
const json = (content, over = {}) => ({
  ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => ({ model: 'm', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 }, ...over }),
  text: async () => '',
});
function sse(chunks, { failAfter = false } = {}) {
  const enc = new TextEncoder();
  return {
    ok: true, status: 200, headers: new Map(),
    body: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield enc.encode(c); if (failAfter) throw Object.assign(new Error('terminated'), { name: 'TypeError' }); } },
  };
}
const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const content = (t) => line({ choices: [{ delta: { content: t } }] });
const reasoning = (t) => line({ choices: [{ delta: { reasoning_content: t } }] });
const done = [line({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } }), 'data: [DONE]\n\n'];
const args = (over = {}) => ({ systemPrompt: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'chat', ...over });
const SECRET = 'the physician is probably Somchai';

// ---------------------------------------------------------------------------
describe('stripThink — the rule for every returned reply', () => {
  test.each([
    ['no markup is returned UNCHANGED (byte-identical)', 'สวัสดีครับ  \n คุณหมอ < 5 > 3', 'สวัสดีครับ  \n คุณหมอ < 5 > 3'],
    ['a leading block and the whitespace after it', `<think>${SECRET}</think>\n\nAnswer.`, 'Answer.'],
    ['whitespace BEFORE a leading block is kept', `  <think>${SECRET}</think>\nAnswer.`, '  Answer.'],
    ['a block in the middle', `Before. <think>${SECRET}</think> After.`, 'Before. After.'],
    ['several blocks', `<think>a</think>One. <think>b</think>Two.`, 'One. Two.'],
    ['an unterminated block (cut off mid-thought) drops everything after it', `Answer so far. <think>${SECRET}`, 'Answer so far. '],
    ['a reply that is ALL reasoning comes back empty', `<think>${SECRET}`, ''],
    ['an orphan </think> (the template opened the block in the prompt): everything up to it is reasoning', `${SECRET}\n</think>\n\nAnswer.`, 'Answer.'],
    ['a stray </think> after a complete block is removed', `<think>a</think>One.</think> Two.`, 'One.Two.'],
    ['tags are matched case-insensitively', `<THINK>${SECRET}</Think>Answer.`, 'Answer.'],
    ['a nested open inside a block ends at the first close', `<think>a<think>b</think>Answer.`, 'Answer.'],
  ])('%s', (_label, input, expected) => {
    expect(stripThink(input)).toBe(expected);
  });

  test('non-strings pass through untouched', () => {
    expect(stripThink('')).toBe('');
    expect(stripThink(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('createThinkFilter — what a stream may show', () => {
  function run(raw, splits, { preopened = false } = {}) {
    const out = [];
    let thinks = 0;
    const orphans = [];
    const f = createThinkFilter({ emit: (t) => out.push(t), onThink: () => { thinks++; }, onOrphanClose: (o) => orphans.push(o), preopened });
    let at = 0;
    for (const s of [...splits, raw.length]) { f.push(raw.slice(at, s)); at = s; }
    f.end();
    return { text: out.join(''), out, thinks, orphans, orphan: f.sawOrphanClose(), leak: f.sawOrphanLeak() };
  }
  // Every case except the orphan close, which a stream cannot recall (see below).
  const CASES = [
    'Plain reply, no markup at all — a < b and c > d.',
    `<think>${SECRET}</think>\n\nAnswer.`,
    `  <think>${SECRET}</think>\nAnswer.`,
    `Before. <think>${SECRET}</think> After.`,
    `<think>a</think>One. <think>b</think>Two.`,
    `Answer so far. <think>${SECRET}`,
    `<think>${SECRET}`,
    `<think>a</think>One.</think> Two.`,
    `<THINK>${SECRET}</Think>Answer.`,
    'ends with a partial tag <thi',
    'ends with a partial close </thi',
  ];

  test.each(CASES)('every 2-way split of %j emits exactly stripThink(whole), and no reasoning', (raw) => {
    for (let i = 0; i <= raw.length; i++) {
      const r = run(raw, [i]);
      expect(r.text).toBe(stripThink(raw));
      expect(r.text).not.toContain('Somchai');
      expect(r.text).not.toMatch(/<\/?think/i);
    }
  });

  test.each(CASES)('character-by-character %j emits exactly stripThink(whole)', (raw) => {
    const r = run(raw, Array.from({ length: raw.length }, (_, i) => i));
    expect(r.text).toBe(stripThink(raw));
  });

  test('a plain reply is never delayed by more than a partial-tag tail', () => {
    const r = run('Hello there, doctor.', [5, 11]);
    expect(r.out).toEqual(['Hello', ' there', ', doctor.']);
    expect(r.thinks).toBe(0);
  });

  test('onThink fires on each opened block; nothing is passed to it', () => {
    expect(run('<think>a</think>One. <think>b</think>Two.', [3, 20]).thinks).toBe(2);
  });

  test('the orphan close, knob OFF: only pieces ALREADY emitted leak — they are FLAGGED; the rest of that piece is dropped', () => {
    const raw = `${SECRET}\n</think>\n\nAnswer.`;
    const r = run(raw, [10]);
    expect(r.orphan).toBe(true);
    expect(r.leak).toBe(true);
    expect(r.orphans).toEqual([{ leaked: true }]);
    expect(r.text).toBe(`${SECRET.slice(0, 10)}Answer.`);   // what a stream could not take back: the first piece only
    expect(stripThink(raw)).toBe('Answer.');                 // what is returned and stored
  });

  test('the orphan close inside the FIRST piece leaks nothing, and emits exactly stripThink(whole)', () => {
    const raw = `${SECRET}\n</think>\n\nAnswer.`;
    const r = run(raw, []);
    expect(r).toMatchObject({ orphan: true, leak: false, text: 'Answer.' });
    expect(r.orphans).toEqual([{ leaked: false }]);
  });
});

// ---------------------------------------------------------------------------
// THINK_PREOPENED: the chat template opens the block in the prompt (DeepSeek-R1, Qwen3 Thinking-2507
// without --reasoning-parser), so the reply is `…reasoning…</think>answer`. With the knob ON nothing
// is shown or returned before the first </think>; with it OFF the behaviour is exactly as above.
describe('THINK_PREOPENED — the rule and the filter', () => {
  function run(raw, splits) {
    const out = [];
    let thinks = 0;
    const f = createThinkFilter({ emit: (t) => out.push(t), onThink: () => { thinks++; }, preopened: true });
    let at = 0;
    for (const s of [...splits, raw.length]) { f.push(raw.slice(at, s)); at = s; }
    f.end();
    return { text: out.join(''), thinks, orphan: f.sawOrphanClose(), leak: f.sawOrphanLeak() };
  }
  const PRE = [
    `${SECRET}\n</think>\n\nAnswer.`,
    `${SECRET}</think>Answer with a < sign.`,
    `${SECRET}</think>One.<think>more ${SECRET}</think>Two.`,
    `${SECRET}</think>One.</think>Two.`,
    `</think>Answer straight away.`,
  ];

  test.each(PRE)('every 2-way split of %j emits NOTHING before the close, and exactly stripThink(whole, preopened)', (raw) => {
    const expected = stripThink(raw, { preopened: true });
    expect(expected).not.toContain('Somchai');
    for (let i = 0; i <= raw.length; i++) {
      const r = run(raw, [i]);
      expect(r.text).toBe(expected);
      expect(r).toMatchObject({ orphan: false, leak: false });   // the first </think> is the expected one, not an orphan
    }
    expect(run(raw, Array.from({ length: raw.length }, (_, i) => i)).text).toBe(expected);
  });

  test('a stream with ONLY reasoning before </think>: no delta at all until the tag, then the answer', () => {
    const out = [];
    const f = createThinkFilter({ emit: (t) => out.push(t), preopened: true });
    for (const p of ['the physician ', 'is probably ', 'Somchai\n']) { f.push(p); expect(out).toEqual([]); }
    f.push('</think>\n\nAnswer.');
    f.end();
    expect(out).toEqual(['Answer.']);
  });

  test('no close tag at all: the whole reply is reasoning — nothing emitted, stripThink returns empty', () => {
    const raw = `${SECRET} and a final answer that never left the block`;
    expect(run(raw, [7]).text).toBe('');
    expect(stripThink(raw, { preopened: true })).toBe('');
    expect(closesThink(raw)).toBe(false);
    expect(closesThink(`${SECRET}</think>x`)).toBe(true);
  });

  test('onThink fires on the first piece — reasoning is arriving from byte one', () => {
    expect(run(`${SECRET}</think>Answer.`, [3, 9]).thinks).toBe(1);
  });

  test('knob OFF on the same inputs is unchanged: the rule-1 result, orphan detected', () => {
    expect(stripThink(`${SECRET}\n</think>\n\nAnswer.`)).toBe('Answer.');
    expect(stripThink('Plain reply.')).toBe('Plain reply.');
    expect(stripThink('Plain reply.', { preopened: true })).toBe('');   // why the knob must match the server
  });

  test('flagOn: lenient on purpose — a typo for "on" must not quietly mean "show the reasoning"', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'on']) expect(flagOn(v)).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off', 'no', '2']) expect(flagOn(v)).toBe(false);
  });

  test('ONE definition: the transport re-exports lib/think-markup.js, it does not copy it', () => {
    expect(stripThink).toBe(markup.stripThink);
    expect(createThinkFilter).toBe(markup.createThinkFilter);
  });
});

// ---------------------------------------------------------------------------
describe.each(['local', 'local-tutor'])('%s: returned replies are stripped', (which) => {
  test('non-streamed: a <think> block in content never reaches the result; a warning names no content', async () => {
    fetchMock.mockResolvedValue(json(`<think>${SECRET}</think>\n\n{"d1": 3}`));
    const r = await load(which).call(args({ purpose: which === 'local' ? 'evaluate' : 'chat' }));
    expect(r.text).toBe('{"d1": 3}');
    expect(JSON.stringify(r)).not.toContain('Somchai');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(new RegExp(`^\\[${which}-ai\\] the reply carried inline <think> markup`));
    expect(warnSpy.mock.calls[0][0]).not.toContain('Somchai');
  });

  test('non-streamed: a reply without markup is returned exactly as served, and nothing is logged', async () => {
    fetchMock.mockResolvedValue(json('  plain\n reply <b>  '));
    expect((await load(which).call(args())).text).toBe('  plain\n reply <b>  ');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('the warning is said once per instance, not once per reply', async () => {
    fetchMock.mockImplementation(async () => json('<think>x</think>y'));
    const p = load(which);
    for (let i = 0; i < 3; i++) await p.call(args());
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('streamed: a tag split across chunks is withheld, deltas never carry reasoning, the result is stripped', async () => {
    fetchMock.mockResolvedValueOnce(sse([content('<th'), content(`ink>${SECRET} — still </thi`), content('nking</thi'), content('nk>\n\nสวัส'), content('ดีครับ'), ...done]));
    const pieces = [];
    const r = await load(which).call(args({ onDelta: (t) => pieces.push(t) }));
    expect(pieces.join('')).toBe('สวัสดีครับ');
    for (const p of pieces) expect(p).not.toMatch(/Somchai|think/i);
    expect(r).toMatchObject({ text: 'สวัสดีครับ', inputTokens: 9, outputTokens: 4 });
  });

  test('streamed: the server ignored `stream` and answered JSON — the one piece goes through the same filter', async () => {
    fetchMock.mockResolvedValueOnce(json(`<think>${SECRET}</think>Whole reply.`));
    const pieces = [];
    const r = await load(which).call(args({ onDelta: (t) => pieces.push(t) }));
    expect(pieces).toEqual(['Whole reply.']);
    expect(r.text).toBe('Whole reply.');
  });

  test('streamed orphan close (knob OFF): stored text drops the reasoning; ONE warning names the knob; onReasoning fires', async () => {
    fetchMock.mockResolvedValueOnce(sse([content('reasoning text\n'), content('</think>\n\nAnswer.'), ...done]));
    const onReasoning = jest.fn();
    const pieces = [];
    const r = await load(which).call(args({ onDelta: (t) => pieces.push(t), onReasoning }));
    expect(r.text).toBe('Answer.');
    expect(pieces).toEqual(['reasoning text\n', 'Answer.']);   // the first piece is the leak the warning is about
    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const knob = which === 'local' ? 'LOCAL_AI_THINK_PREOPENED=1' : 'LOCAL_TUTOR_AI_THINK_PREOPENED=1';
    expect(warnSpy.mock.calls[0][0]).toContain(knob);
    expect(warnSpy.mock.calls[0][0]).toMatch(/ALREADY been shown/);
    expect(warnSpy.mock.calls[0][0]).not.toContain('reasoning text');
  });

  test('THINK_PREOPENED=1, streamed: nothing is shown before </think>, onReasoning fires before any text', async () => {
    process.env[`${which === 'local' ? 'LOCAL_AI_' : 'LOCAL_TUTOR_AI_'}THINK_PREOPENED`] = '1';
    fetchMock.mockResolvedValueOnce(sse([content('the physician '), content('is probably Somchai\n</thi'), content('nk>\n\nAnswer.'), ...done]));
    const order = [];
    const r = await load(which).call(args({ onDelta: (t) => order.push(t), onReasoning: () => order.push('reasoning') }));
    expect(order).toEqual(['reasoning', 'Answer.']);
    expect(r.text).toBe('Answer.');
    expect(warnSpy.mock.calls.map(([m]) => m).join('\n')).not.toMatch(/ALREADY been shown/);
  });

  test.each([['streamed', true], ['non-streamed', false]])('THINK_PREOPENED=1, %s, no close tag at all: an ERROR (empty_reply, reasoning only, not retried) — never the text, never a blank reply', async (_l, streamed) => {
    process.env[`${which === 'local' ? 'LOCAL_AI_' : 'LOCAL_TUTOR_AI_'}THINK_PREOPENED`] = '1';
    const body = `${SECRET}; still thinking when max_tokens hit`;
    fetchMock.mockResolvedValue(streamed
      ? sse([content(body.slice(0, 12)), content(body.slice(12)), line({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 40 } }), 'data: [DONE]\n\n'])
      : json(body, { choices: [{ message: { content: body }, finish_reason: 'length' }] }));
    const pieces = [];
    const err = await load(which).call(args(streamed ? { onDelta: (t) => pieces.push(t) } : {})).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: 'empty_reply', status: 503, reasoningOnly: true, noRetry: true });
    expect(err.message).toMatch(/THINK_PREOPENED=1/);
    expect(err.message).not.toContain('Somchai');
    expect(pieces).toEqual([]);                 // the physician saw nothing
    expect(fetchMock).toHaveBeenCalledTimes(1); // and the shared box was not asked three more times
  });

  test('THINK_PREOPENED=1 and an EMPTY content: the provider returns "" (services/ai.js makes that empty_reply), no reasoning-only error', async () => {
    process.env[`${which === 'local' ? 'LOCAL_AI_' : 'LOCAL_TUTOR_AI_'}THINK_PREOPENED`] = '1';
    fetchMock.mockResolvedValue(json(''));
    expect((await load(which).call(args())).text).toBe('');
  });

  test('streamed: a failure after NOTHING BUT reasoning is retried — no reply text had been shown', async () => {
    fetchMock
      .mockResolvedValueOnce(sse([reasoning('planning'), content('<think>more planning'), content(' still')], { failAfter: true }))
      .mockResolvedValueOnce(sse([content('Final.'), ...done]));
    const pieces = [];
    const onReasoning = jest.fn();
    const r = await load(which).call(args({ onDelta: (t) => pieces.push(t), onReasoning }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pieces).toEqual(['Final.']);
    expect(r.text).toBe('Final.');
    expect(onReasoning).toHaveBeenCalledTimes(1);   // once per call, across both attempts
  });
});

// ---------------------------------------------------------------------------
describe('onReasoning — told that reasoning arrived, never what it was', () => {
  test('fires ONCE on the first reasoning_content delta, with no arguments, before any text', async () => {
    const order = [];
    fetchMock.mockResolvedValueOnce(sse([reasoning('a'), reasoning('b'), line({ choices: [{ delta: { reasoning: 'c' } }] }), content('Hi.'), ...done]));
    const onReasoning = jest.fn(() => order.push('reasoning'));
    await load('local-tutor').call(args({ onDelta: (t) => order.push(t), onReasoning }));
    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(onReasoning.mock.calls[0]).toEqual([]);
    expect(order).toEqual(['reasoning', 'Hi.']);
  });

  test('fires for inline <think> markup too — the same arrival, by the other route', async () => {
    fetchMock.mockResolvedValueOnce(sse([content('<think>x</think>'), content('<think>y</think>Hi.'), ...done]));
    const onReasoning = jest.fn();
    await load('local-tutor').call(args({ onDelta: () => {}, onReasoning }));
    expect(onReasoning).toHaveBeenCalledTimes(1);
  });

  test('a reply with no reasoning never calls it; omitting it is fine', async () => {
    fetchMock.mockResolvedValueOnce(sse([content('Hi.'), ...done]));
    const onReasoning = jest.fn();
    await load('local-tutor').call(args({ onDelta: () => {}, onReasoning }));
    expect(onReasoning).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(sse([reasoning('a'), content('Hi.'), ...done]));
    await expect(load('local-tutor').call(args({ onDelta: () => {} }))).resolves.toMatchObject({ text: 'Hi.' });
  });
});

// ---------------------------------------------------------------------------
describe('thinking control — sent only when asked for AND the server style is configured', () => {
  const sent = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
  const ok = () => fetchMock.mockResolvedValue(json('ok'));

  test('the style vocabulary', () => {
    expect(THINKING_STYLES).toEqual(['none', 'chat_template_kwargs', 'ollama']);
    expect(thinkingEnabled(true)).toBe(true);
    expect(thinkingEnabled(false)).toBe(false);
    expect(thinkingEnabled({ enabled: false, budget: 100 })).toBe(false);
    for (const v of [undefined, null, 'yes', 1, {}, { budget: 100 }]) expect(thinkingEnabled(v)).toBeNull();
  });

  test.each(['local', 'local-tutor'])('%s default (style unset = none): nothing is ever sent, even with thinking passed', async (which) => {
    ok();
    const p = load(which);
    await p.call(args({ thinking: true }));
    const body = sent();
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);   // the pre-existing request, exactly
  });

  test('chat_template_kwargs (vLLM / SGLang): { chat_template_kwargs: { enable_thinking } }; budget is not sent', async () => {
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'chat_template_kwargs';
    ok();
    const p = load('local-tutor');
    await p.call(args({ thinking: false }));
    expect(sent().chat_template_kwargs).toEqual({ enable_thinking: false });
    await p.call(args({ thinking: { enabled: true, budget: 512 } }));
    expect(sent().chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(JSON.stringify(sent())).not.toContain('512');
    expect(sent()).not.toHaveProperty('think');
  });

  test('ollama: { think }', async () => {
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'Ollama';   // case-insensitive
    ok();
    await load('local-tutor').call(args({ thinking: true }));
    expect(sent().think).toBe(true);
    expect(sent()).not.toHaveProperty('chat_template_kwargs');
  });

  test('a style is configured but the caller did not pass thinking: nothing is sent', async () => {
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'chat_template_kwargs';
    ok();
    await load('local-tutor').call(args());
    expect(sent()).not.toHaveProperty('chat_template_kwargs');
  });

  test('the style is per instance: the tutor style does not reach the evaluator, and vice versa', async () => {
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'chat_template_kwargs';
    ok();
    await load('local').call(args({ thinking: false }));
    expect(sent()).not.toHaveProperty('chat_template_kwargs');
    process.env.LOCAL_AI_THINKING_STYLE = 'ollama';
    await load('local').call(args({ thinking: false }));
    expect(sent().think).toBe(false);
  });

  test('an unknown style sends nothing and warns ONCE, naming the variable', async () => {
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'qwen';
    ok();
    const p = load('local-tutor');
    await p.call(args({ thinking: true }));
    await p.call(args({ thinking: true }));
    expect(Object.keys(sent()).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/LOCAL_TUTOR_AI_THINKING_STYLE="qwen" is not one of/);
  });
});

// ---------------------------------------------------------------------------
describe('THINK_PREOPENED is per instance', () => {
  test("the evaluator's knob does not reach the tutor, and vice versa", async () => {
    process.env.LOCAL_AI_THINK_PREOPENED = '1';
    fetchMock.mockImplementation(async () => json('Plain answer, no markup.'));
    expect((await load('local-tutor').call(args())).text).toBe('Plain answer, no markup.');
    await expect(load('local').call(args())).rejects.toMatchObject({ code: 'empty_reply', reasoningOnly: true });
    delete process.env.LOCAL_AI_THINK_PREOPENED;
    process.env.LOCAL_TUTOR_AI_THINK_PREOPENED = '1';
    expect((await load('local').call(args())).text).toBe('Plain answer, no markup.');
    await expect(load('local-tutor').call(args())).rejects.toMatchObject({ code: 'empty_reply', reasoningOnly: true });
  });

  test('an empty_reply error is not a DOWN provider despite its 503: the chat fail-over would not move it to another vendor', () => {
    jest.resetModules();
    const { isProviderDown } = require('../src/services/ai');
    expect(isProviderDown(Object.assign(new Error('x'), { status: 503, code: 'empty_reply', reasoningOnly: true, noRetry: true }))).toBe(false);
    expect(isProviderDown(Object.assign(new Error('x'), { status: 502 }))).toBe(true);   // an ordinary 5xx still is
  });
});

// ---------------------------------------------------------------------------
// supportsThinking() — what services/ai.js providerSupportsThinking asks before routes/chat.js applies
// the fast/deep router's tier. It must mean exactly "a `thinking` request changes the body".
describe('supportsThinking — true iff this instance would send a thinking field', () => {
  const sent = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body);

  test.each(['local', 'local-tutor'])('%s: unset / none / unknown -> false; a real style -> true', (which) => {
    const prefix = which === 'local' ? 'LOCAL_AI_' : 'LOCAL_TUTOR_AI_';
    expect(load(which).supportsThinking()).toBe(false);
    for (const [raw, want] of [['none', false], ['qwen', false], ['chat_template_kwargs', true], [' Ollama ', true]]) {
      process.env[`${prefix}THINKING_STYLE`] = raw;
      expect(load(which).supportsThinking()).toBe(want);
    }
  });

  test('per instance, and read per call (no restart needed to change it)', () => {
    const tutor = load('local-tutor');
    const evaluator = require('../src/services/providers/local');
    process.env.LOCAL_TUTOR_AI_THINKING_STYLE = 'chat_template_kwargs';
    expect(tutor.supportsThinking()).toBe(true);
    expect(evaluator.supportsThinking()).toBe(false);
    delete process.env.LOCAL_TUTOR_AI_THINKING_STYLE;
    expect(tutor.supportsThinking()).toBe(false);
  });

  test('true agrees with the body: whenever it says yes, `thinking` reaches the server; whenever no, nothing does', async () => {
    fetchMock.mockResolvedValue(json('ok'));
    for (const raw of [undefined, 'none', 'bogus', 'chat_template_kwargs', 'ollama']) {
      if (raw === undefined) delete process.env.LOCAL_TUTOR_AI_THINKING_STYLE; else process.env.LOCAL_TUTOR_AI_THINKING_STYLE = raw;
      const p = load('local-tutor');
      await p.call(args({ thinking: true }));
      const carries = 'chat_template_kwargs' in sent() || 'think' in sent();
      expect(carries).toBe(p.supportsThinking());
    }
  });

  test('ONE definition: the transport re-exports lib/thinking-control.js (the harness imports the same file)', () => {
    const control = require('../src/lib/thinking-control');
    const factory = require('../src/services/providers/local-factory');
    expect(factory.thinkingEnabled).toBe(control.thinkingEnabled);
    expect(factory.THINKING_STYLES).toBe(control.THINKING_STYLES);
    expect(control.thinkingFields('chat_template_kwargs', true)).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(control.thinkingFields('ollama', false)).toEqual({ think: false });
    expect(control.thinkingFields('none', true)).toEqual({});
    expect(control.thinkingFields('chat_template_kwargs', null)).toEqual({});
    expect(control.parseThinkingStyle(undefined)).toBe('none');
    expect(control.parseThinkingStyle('nope')).toBeNull();
  });
});
