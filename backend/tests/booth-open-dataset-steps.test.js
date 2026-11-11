// The open booth dataset publishes only the step keys in scripts/booth/open-dataset-step-keys.json, and its build
// refuses a play with any other key (#388). This holds that list to what stepRecords actually writes.
const { stepRecords, REPLY_FIELDS } = require('../src/services/booth-dialogue');
const ALLOWED = require('../../scripts/booth/open-dataset-step-keys.json');

const reply = { strength: 'ดี', weigh: 'ควรคิดถึงภาวะช็อก', safety: '' };
const walked = {
  tierPath: 'BRW',
  asks: [
    { variant: 'v1', bridge: '', options: ['a', 'b', 'c'] },
    { variant: 'v2', bridge: 'ต่อไป', options: ['d', 'e', 'f'] },
    { variant: 'v1', bridge: 'สุดท้าย', options: ['g', 'h', 'i'] },
  ],
  answers: [
    { choice: 'a' },
    { text: 'raw typed text', tier: 'R', deidentified: 'typed text' },
    { text: 'unkept typed text', tier: 'W' },
  ],
  replies: [reply, reply, { strength: '', weigh: '', safety: '' }],
};

test('every key stepRecords writes, tapped and typed, is in the open dataset\'s allow-list, and the list holds no other', () => {
  const records = stepRecords(walked);
  const stepKeys = new Set(records.flatMap((r) => Object.keys(r)));
  const replyKeys = new Set(records.flatMap((r) => Object.keys(r.reply)));
  expect([...stepKeys].sort()).toEqual(Object.keys(ALLOWED.step).sort());
  expect([...replyKeys].sort()).toEqual(Object.keys(ALLOWED.reply).sort());
  expect([...REPLY_FIELDS].sort()).toEqual(Object.keys(ALLOWED.reply).sort());
});

test('a step record never carries the raw typed text', () => {
  expect(JSON.stringify(stepRecords(walked))).not.toMatch(/raw typed text|unkept typed text/);
});
