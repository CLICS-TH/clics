// Clinical tier rules that the gate for #383 found broken in five-step cases. Each rule reads the English text of
// every bank, variant and option, so it holds wherever the same state or option recurs. Thai parity is the safety
// review's job (AUTHORING.md).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../src/booth-cases');
// The staged five-step version until the cutover (#386) moves it to the event folder.
const fiveStep = (id) => [`staging/NFCME-2026/${id}.json`, `NFCME-2026/${id}.json`]
  .map((f) => path.join(DIR, f)).filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).find((k) => Object.keys(k.banks).length === 5);

const banks = (k) => Object.entries(k.banks).flatMap(([step, level]) => (level.variants ? [[step, level]]
  : Object.entries(level).map(([tier, bank]) => [`${step}.${tier}`, bank])));
const stems = (bank) => bank.variants.map((v) => v.question.en).join(' ');
const text = (o) => `${o.label.en} | ${o.line.en}`;
const at = (name, o) => `${name} ${o.id} (${o.tier}): ${text(o)}`;

describe('organophosphate', () => {
  const k = fiveStep('organophosphate');
  const FAILING = /drowsier|tires|floods|SpO2 8\d%/i;
  const AIRWAY = /intubat|ventilat|\bICU\b/i;

  test('a bank whose stem shows impending respiratory failure tiers best only options that protect the airway', () => {
    const bad = banks(k).filter(([, b]) => FAILING.test(stems(b)))
      .flatMap(([name, b]) => b.options.filter((o) => o.tier === 'best' && !AIRWAY.test(text(o))).map((o) => at(name, o)));
    expect(bad).toEqual([]);
  });

  test('the same option in two such banks has one tier', () => {
    const tiers = new Map();
    for (const [name, b] of banks(k).filter(([, x]) => FAILING.test(stems(x)))) {
      for (const o of b.options) tiers.set(o.label.en, [...(tiers.get(o.label.en) ?? []), `${name} ${o.tier}`]);
    }
    const split = [...tiers].filter(([, seen]) => new Set(seen.map((s) => s.split(' ')[1])).size > 1);
    expect(split).toEqual([]);
  });

  test('every option that ventilates him also arranges ICU care', () => {
    const bad = banks(k).flatMap(([name, b]) => b.options
      .filter((o) => /intubat|ventilate\b/i.test(o.label.en) && !/\bICU\b/.test(text(o))).map((o) => at(name, o)));
    expect(bad).toEqual([]);
  });

  test('while he still needs atropine, step 5 offers ICU-capable care as best and rewards no keeping him here', () => {
    const step5 = banks(k).filter(([name, b]) => name.startsWith('step5') && /atropine/i.test(stems(b)));
    expect(step5.length).toBeGreaterThan(0);
    const bad = step5.flatMap(([name, b]) => [
      ...(b.options.some((o) => o.tier === 'best' && AIRWAY.test(text(o))) ? [] : [`${name}: no best option arranges ICU-capable care`]),
      ...b.options.filter((o) => o.tier !== 'weaker' && /keep (him )?here|stay here/i.test(text(o))).map((o) => at(name, o)),
    ]);
    expect(bad).toEqual([]);
  });
});

test('melioidosis-farmer: with abscesses, no option above weaker ends the IV phase early or switches to oral', () => {
  const k = fiveStep('melioidosis-farmer');
  const deep = banks(k).filter(([, b]) => /abscess/i.test(stems(b)));
  expect(deep.length).toBeGreaterThan(0);
  const bad = deep.flatMap(([name, b]) => b.options
    .filter((o) => o.tier !== 'weaker' && /\b(14 days|2 weeks|two weeks|oral)\b/i.test(text(o))).map((o) => at(name, o)));
  expect(bad).toEqual([]);
});
