// The question bank is pre-registered evidence: its composition and validity are tested, so a
// casual edit cannot quietly change what the quality gates measure.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBank, validateItem, composition, selectItems, ADVERSARIAL_TYPES } from './bank.mjs';
import { buildChatRequest } from './request.mjs';
import { isThaiMessage } from './rimpl.mjs';
import { ITEM_TH_EXAMINER } from './test-fixtures.mjs';

const bank = await loadBank();
const comp = composition(bank.items);

test('bank loads, every item valid, ids unique, ~80 items', () => {
  assert.ok(comp.total >= 75 && comp.total <= 90, `expected ~80 items, got ${comp.total}`);
  assert.equal(new Set(bank.items.map((i) => i.id)).size, bank.items.length);
  assert.match(bank.sha, /^bank-[0-9a-f]{12}$/);
});

test('language mix: ~60% Thai, ~15% code-mixed, ~25% English (±5 points)', () => {
  const share = (k) => (comp.language[k] ?? 0) / comp.total;
  assert.ok(Math.abs(share('th') - 0.60) <= 0.05, `th ${share('th')}`);
  assert.ok(Math.abs(share('mixed') - 0.15) <= 0.05, `mixed ${share('mixed')}`);
  assert.ok(Math.abs(share('en') - 0.25) <= 0.05, `en ${share('en')}`);
});

test('>= 20 adversarial items, covering every required behaviour', () => {
  const adv = bank.items.filter((i) => i.adversarial);
  assert.ok(adv.length >= 20, `only ${adv.length} adversarial items`);
  for (const t of ['wrong_premise', 'sycophancy_pushback', 'unsafe_dosing', 'pregnancy_dosing', 'paediatric_dosing',
    'out_of_scope', 'fabricate_reference', 'pii_echo', 'language_switch_en', 'language_switch_th']) {
    assert.ok(adv.some((i) => i.adversarial.type === t), `no ${t} item`);
  }
  assert.ok(adv.every((i) => ADVERSARIAL_TYPES.includes(i.adversarial.type)));
});

test('modes, turns and specialties are spread', () => {
  assert.ok(comp.mode.natural >= 20 && comp.mode.examiner >= 20 && comp.mode.rescue >= 4, JSON.stringify(comp.mode));
  assert.ok(comp.multiTurn >= 10, `multi-turn items: ${comp.multiTurn}`);
  assert.ok(Object.keys(comp.specialty).length >= 12, 'specialties should be spread');
});

test('language-switch items end in the language they test', () => {
  for (const it of bank.items.filter((i) => i.adversarial?.type?.startsWith('language_switch'))) {
    const want = it.adversarial.type === 'language_switch_en' ? 'en' : 'th';
    assert.equal(buildChatRequest(it).language, want, it.id);
    assert.ok(it.turns.length >= 3, `${it.id} needs a history in the other language`);
  }
});

test('th/mixed items are exactly the ones production\'s language guard polices (isThaiMessage)', () => {
  for (const it of bank.items) {
    assert.equal(isThaiMessage(it.turns.at(-1).content), it.language !== 'en', `${it.id} (${it.language})`);
  }
});

test('every bank item builds a request; pii items mask at least one identifier', () => {
  for (const it of bank.items) {
    const r = buildChatRequest(it);
    assert.ok(r.messages.length === it.turns.length, it.id);
    if (it.identifiers?.length) assert.ok(r.identifiersSent.length < it.identifiers.length, `${it.id}: the filter masked nothing`);
  }
});

test('validateItem rejects malformed items', () => {
  assert.deepEqual(validateItem(ITEM_TH_EXAMINER), []);
  const bad = (patch) => validateItem({ ...ITEM_TH_EXAMINER, ...patch });
  assert.ok(bad({ mode: 'chatty' }).length);
  assert.ok(bad({ turns: [{ role: 'assistant', content: 'x' }] }).length, 'must start and end with the physician');
  assert.ok(bad({ language: 'en' }).length, 'Thai text labelled English');
  assert.ok(bad({ key_facts: [] }).length);
  assert.ok(bad({ adversarial: { type: 'pii_echo', expected_behaviour: 'x' } }).length, 'pii_echo needs identifiers');
  assert.ok(bad({ must_not_patterns: ['('] }).length, 'invalid regex');
  assert.ok(bad({ mode: 'rescue' }).length, 'rescue needs >= 4 physician turns of history');
});

test('selectItems: --ids exact (unknown id is an error), --limit first n', () => {
  assert.equal(selectItems(bank.items, { limit: 3 }).length, 3);
  assert.deepEqual(selectItems(bank.items, { ids: ['th-cardio-stemi'] }).map((i) => i.id), ['th-cardio-stemi']);
  assert.throws(() => selectItems(bank.items, { ids: ['no-such-item'] }), /unknown item/);
});
