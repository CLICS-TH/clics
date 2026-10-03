// physician-ui is a no-build static site with no test runner, so its refusal handling is pinned at the
// source level here (as tests/reply-report.test.js does for the report button). COPY PENDING (#136):
// this checks the CONTRACT (one shared placeholder, the `ai_refused` branch, no Retry), not the wording.
const fs = require('fs');
const path = require('path');
const { AI_REFUSED_MESSAGE } = require('../src/lib/rimpl-refusal');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const quoted = (src) => (src.match(/const AI_REFUSED_MSG = '([^']+)';/) || [])[1];

test('ple-chat.js: a dedicated branch, a system notice with NO action bar (no Retry), the text restored to rephrase', () => {
  const src = read('physician-ui', 'public', 'js', 'ple-chat.js');
  expect(src).toMatch(/res\?\.code === 'ai_refused'/);
  expect(src).toMatch(/renderMessage\('assistant', AI_REFUSED_MSG, \[\], null, \{ system: true \}\)/);
  // The system branch returns before addActions(), which is where Retry lives.
  const start = src.indexOf('if (opts.system) {');
  const sys = src.slice(start, src.indexOf("if (role === 'physician') {", start));
  expect(sys).toMatch(/msg-system/);
  expect(sys).toMatch(/return div;/);
  expect(sys).not.toMatch(/addActions/);
  // The branch itself offers no Retry and gives the text back to rephrase.
  const branch = src.slice(src.indexOf("res?.code === 'ai_refused'"), src.indexOf('} else {', src.indexOf("res?.code === 'ai_refused'")));
  expect(branch).not.toMatch(/error: true/);
  expect(branch).toMatch(/document\.getElementById\('input'\)\.value = message/);
});

test('guest-chat.js maps ai_refused to the same text instead of the server string', () => {
  const src = read('physician-ui', 'public', 'js', 'guest-chat.js');
  expect(src).toMatch(/res\.body\?\.code === 'ai_refused'\s*\n?\s*\? AI_REFUSED_MSG/);
});

test('one placeholder everywhere: both UIs and the backend 422 carry the same bilingual text', () => {
  expect(quoted(read('physician-ui', 'public', 'js', 'ple-chat.js'))).toBe(AI_REFUSED_MESSAGE);
  expect(quoted(read('physician-ui', 'public', 'js', 'guest-chat.js'))).toBe(AI_REFUSED_MESSAGE);
});
