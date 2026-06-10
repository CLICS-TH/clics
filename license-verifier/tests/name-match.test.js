// Unit tests for the TMC scraper's name-matching logic — the code that decides
// verified vs name_mismatch and therefore drives the AUDITOR HARD GATE. A bug here
// wrongly blocks (or wrongly admits) a real licensed auditor, so it is tested in
// isolation from the live browser scrape. Pure functions; no Playwright launch.
//
// Run (zero extra deps — Node's built-in runner):  cd license-verifier && npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName, namesMatch, splitName } = require('../src/scrape.js');

test('normalizeName strips Thai + English honorifics, punctuation, and case', () => {
  assert.equal(normalizeName('นพ. สมชาย ใจดี'), 'สมชาย ใจดี');           // Thai honorific
  assert.equal(normalizeName('Dr. Somchai Jaidee'), 'somchai jaidee');     // English honorific + case
  assert.equal(normalizeName('Assoc. Prof. Dr. Somchai Jaidee'), 'somchai jaidee'); // stacked honorifics
  assert.equal(normalizeName('Somchai  Jai-dee'), 'somchai jai dee');      // dash → space, ws collapse
  assert.equal(normalizeName('ผศ. พญ. สุดา รักดี'), 'สุดา รักดี');          // stacked Thai honorifics
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
});

test('namesMatch: exact and order-independent matches', () => {
  assert.equal(namesMatch('Somchai Jaidee', 'Somchai Jaidee'), true);
  assert.equal(namesMatch('Somchai Jaidee', 'Jaidee Somchai'), true);     // surname-first rendering
  assert.equal(namesMatch('สมชาย ใจดี', 'นพ. สมชาย ใจดี'), true);          // honorific on one side
});

test('namesMatch: tolerates an extra middle token / honorific remnant', () => {
  assert.equal(namesMatch('Somchai Jaidee', 'Somchai N. Jaidee'), true);  // supplied covered by scraped
  assert.equal(namesMatch('Dr. Somchai Jaidee', 'Somchai Jaidee'), true);
});

test('namesMatch: shared-majority threshold (>= 60% of the smaller token set)', () => {
  // neither side fully covers the other, but 2/3 tokens shared → match
  assert.equal(namesMatch('Somchai Jaidee Extra', 'Somchai Jaidee Other'), true);
  // only 1/4 shared → below threshold → no match
  assert.equal(namesMatch('Somchai Jaidee Aa Bb', 'Somchai Cc Dd Ee'), false);
});

test('namesMatch: genuine mismatches and empties are false', () => {
  assert.equal(namesMatch('Somchai Jaidee', 'Anan Prasert'), false);
  assert.equal(namesMatch('', 'Somchai Jaidee'), false);
  assert.equal(namesMatch('Somchai Jaidee', ''), false);
  assert.equal(namesMatch(null, null), false);
});

test('namesMatch: a covering subset matches (documented coverage behavior)', () => {
  // A first-name-only supplied value is COVERED by the fuller scraped name → matches.
  // Documented here so a future change to coverage semantics is a conscious decision.
  assert.equal(namesMatch('Somchai', 'Somchai Jaidee'), true);
});

test('splitName: name = first token, surname = remainder; honorifics stripped', () => {
  assert.deepEqual(splitName({ full_name_en: 'Dr. Somchai Jaidee' }), { name: 'Somchai', surname: 'Jaidee' });
  assert.deepEqual(splitName({ full_name_en: 'Somchai Jai Dee' }), { name: 'Somchai', surname: 'Jai Dee' });
  assert.deepEqual(splitName({ full_name_en: 'Somchai' }), { name: 'Somchai', surname: '' });
});

test('splitName: prefers English, falls back to Thai', () => {
  assert.deepEqual(splitName({ full_name_en: 'John Smith', full_name_th: 'ใจ ดี' }), { name: 'John', surname: 'Smith' });
  assert.deepEqual(splitName({ full_name_en: '', full_name_th: 'สมชาย ใจดี' }), { name: 'สมชาย', surname: 'ใจดี' });
  assert.deepEqual(splitName({}), { name: '', surname: '' });
});
