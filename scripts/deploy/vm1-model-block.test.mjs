// #424: vm1 declares the on-prem model block. rimpl.env.example must name every LOCAL_AI_* and
// LOCAL_TUTOR_AI_* variable rimpl reads, each [vm1] and valueless, and deploy/vm1/model-reach.cjs must
// report both endpoints' status without printing a key or an address. The preflight's refusals are in
// vm1-remote.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = readFileSync(path.join(ROOT, 'deploy', 'vm1', 'rimpl.env.example'), 'utf8');
const FACTORY = readFileSync(path.join(ROOT, 'rimpl', 'src', 'services', 'providers', 'local-factory.js'), 'utf8');
const REACH = path.join(ROOT, 'deploy', 'vm1', 'model-reach.cjs');

// Every `${envPrefix}NAME` the transport reads, so a knob added there fails here until the example names it.
const SUFFIXES = [...new Set([...FACTORY.matchAll(/\$\{envPrefix\}([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))];
const INSTANCES = { LOCAL_AI_: { embeddings: true }, LOCAL_TUTOR_AI_: { embeddings: false } };

test('rimpl.env.example names every on-prem variable rimpl reads, each [vm1] with no value', () => {
  assert.ok(SUFFIXES.includes('BASE_URL') && SUFFIXES.includes('THINKING_STYLE'), `read the factory: ${SUFFIXES}`);
  const lines = EXAMPLE.split('\n');
  for (const [prefix, { embeddings }] of Object.entries(INSTANCES)) {
    for (const suffix of SUFFIXES) {
      const name = `${prefix}${suffix}`;
      if (suffix.startsWith('EMBED_') && !embeddings) continue;
      if (suffix === 'HTTP_PROXY') {
        assert.match(EXAMPLE, new RegExp(`\\[drop\\][\\s\\S]*${name}`), `${name} is listed as [drop]`);
        assert.ok(!lines.includes(`${name}=`), `${name} is never assigned on vm1`);
        continue;
      }
      const at = lines.findIndex((l) => l.startsWith(`${name}=`));
      assert.ok(at >= 0, `rimpl.env.example names ${name}`);
      assert.equal(lines[at], `${name}=`, `${name} has no value`);
      const marker = lines.slice(0, at).reverse().find((l) => /^# \[[a-z0-9]+\]/.test(l));
      assert.match(marker, /^# \[vm1\]/, `${name} is marked [vm1] (changes on vm1)`);
    }
  }
  assert.match(EXAMPLE, /\[vm1\] changes on vm1/);
});

// A stub OpenAI-compatible server per endpoint. `mode` picks what it answers.
function stubServer(mode, { model, key }) {
  const server = createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: `bad key at ${req.headers.host}` });
    if (req.url === '/v1/models') return send(200, { data: [{ id: mode === 'unlisted' ? 'other' : model }] });
    if (req.url === '/v1/chat/completions') {
      if (mode === 'error') return send(500, { error: `upstream ${req.headers.host} failed` });
      const content = mode === 'empty' ? '' : 'ready';
      return send(200, { choices: [{ finish_reason: mode === 'empty' ? 'length' : 'stop', message: { content, reasoning_content: 'thinking' } }] });
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runReach(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REACH], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function scenario({ evaluator = 'ok', tutor = 'ok', tutorDeclared = true, wrongKey = false } = {}) {
  const ev = await stubServer(evaluator, { model: 'eval-model', key: 'sk-EVAL-1a2b' });
  const tu = await stubServer(tutor, { model: 'tutor-model', key: 'sk-TUTOR-3c4d' });
  const evPort = ev.address().port;
  const tuPort = tu.address().port;
  const tutorPort = tutor === 'down' ? (tu.close(), tuPort) : tuPort;
  const env = {
    LOCAL_AI_BASE_URL: `http://127.0.0.1:${evPort}/v1/`,
    LOCAL_AI_MODEL: 'eval-model',
    LOCAL_AI_API_KEY: wrongKey ? 'sk-WRONG-9z' : 'sk-EVAL-1a2b',
    ...(tutorDeclared ? { LOCAL_TUTOR_AI_BASE_URL: `http://127.0.0.1:${tutorPort}/v1`, LOCAL_TUTOR_AI_MODEL: 'tutor-model', LOCAL_TUTOR_AI_API_KEY: 'sk-TUTOR-3c4d' } : {}),
  };
  try {
    const r = await runReach(env);
    for (const leak of ['sk-EVAL-1a2b', 'sk-TUTOR-3c4d', 'sk-WRONG-9z', '127.0.0.1', `:${evPort}`, `:${tutorPort}`]) {
      assert.ok(!r.out.includes(leak), `printed ${leak}:\n${r.out}`);
    }
    return r;
  } finally {
    ev.close();
    if (tutor !== 'down') tu.close();
  }
}

test('model-reach: both endpoints answer, exit 0, statuses and finish reasons printed', async () => {
  const r = await scenario();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /evaluator \(LOCAL_AI_\*\): model eval-model/);
  assert.match(r.out, /evaluator GET \/models: 200, model listed: yes/);
  assert.match(r.out, /evaluator POST \/chat\/completions: 200, finish_reason stop, content 5 chars, reasoning 8 chars/);
  assert.match(r.out, /tutor GET \/models: 200, model listed: yes/);
  assert.match(r.out, /tutor POST \/chat\/completions: 200, finish_reason stop/);
  assert.match(r.out, /PASS: both on-prem endpoints answered/);
});

test('model-reach fails, without leaking, on every way an endpoint is not ready', async () => {
  const cases = [
    [{ tutorDeclared: false }, /tutor: NOT DECLARED \(LOCAL_TUTOR_AI_BASE_URL or LOCAL_TUTOR_AI_MODEL has no value\)/],
    [{ tutor: 'down' }, /tutor GET \/models: FAILED \(ECONNREFUSED\)[\s\S]*tutor POST \/chat\/completions: FAILED \(ECONNREFUSED\)/],
    [{ wrongKey: true }, /evaluator GET \/models: 401, model listed: NO[\s\S]*evaluator POST \/chat\/completions: 401/],
    [{ evaluator: 'unlisted' }, /evaluator GET \/models: 200, model listed: NO/],
    [{ evaluator: 'empty' }, /evaluator POST \/chat\/completions: 200, finish_reason length, content EMPTY/],
    [{ tutor: 'error' }, /tutor POST \/chat\/completions: 500, finish_reason none/],
  ];
  for (const [opts, want] of cases) {
    const r = await scenario(opts);
    assert.equal(r.code, 1, `${JSON.stringify(opts)}:\n${r.out}`);
    assert.match(r.out, want);
    assert.match(r.out, /FAIL: see the lines above/);
    assert.ok(!/upstream|bad key/.test(r.out), `never prints a server's error text:\n${r.out}`);
  }
});
