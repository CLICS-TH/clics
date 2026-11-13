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

describe('dka-young-adult', () => {
  const k = fiveStep('dka-young-adult');
  const num = (q, re) => (q.match(re) ? Number(q.match(re)[1]) : null);
  // Per variant, since the kiosk shows one variant: Thai DM CPG 2566 p.145 resolves DKA at glucose 250 mg/dL or below
  // plus two of pH 7.3+, HCO3 15+, anion gap 12-; WHO SEARO IMAI 2021 p.3.4-95 stops IV insulin only once she eats and
  // drinks, below 216 mg/dL.
  const NOT_TAKING = /\b(not|no|cannot|can't|unable|npo|nil by mouth)\b[^.;]*\b(eat|drink)/i;
  const state = (v) => {
    const q = v.question.en;
    const glucose = num(q, /glucose(?: is)? (\d+)\s*mg\/dL/i);
    const pH = num(q, /pH (\d\.\d+)/);
    const hco3 = num(q, /HCO3 (\d+)/);
    const gap = num(q, /anion gap (\d+)/i);
    const met = [pH !== null && pH >= 7.3, hco3 !== null && hco3 >= 15, gap !== null && gap <= 12].filter(Boolean).length;
    const resolved = glucose !== null && glucose <= 250 && met >= 2;
    const eatsAndDrinks = /\beat(s|ing)?\b/i.test(q) && /\bdrink(s|ing)?\b/i.test(q) && !NOT_TAKING.test(q);
    return { glucose, resolved, offDrip: resolved && glucose < 216 && eatsAndDrinks };
  };
  const OFF_DRIP = /basal-bolus|premixed|subcutaneous|\bSC\b|glargine|insulin pen|insulin injections|stop[^.;|]{0,20}(drip|IV insulin)/i;

  test('an option that stops the drip or starts subcutaneous insulin sits only where every variant meets both stop rules', () => {
    const offered = banks(k).filter(([, b]) => b.options.some((o) => OFF_DRIP.test(text(o))));
    expect(offered.length).toBeGreaterThan(0);
    const bad = offered.flatMap(([name, b]) => b.variants.filter((v) => !state(v).offDrip).map((v) => `${name} ${v.id}: ${v.question.en}`));
    expect(bad).toEqual([]);
  });

  test('under a variant still in ketoacidosis at glucose 250 mg/dL or below, every best option lowers the insulin rate', () => {
    const low = banks(k).filter(([, b]) => b.variants.some((v) => !state(v).resolved && state(v).glucose !== null && state(v).glucose <= 250));
    expect(low.length).toBeGreaterThan(0);
    const bad = low.flatMap(([name, b]) => b.options
      .filter((o) => o.tier === 'best' && (/same insulin rate|0\.1 units\/kg\/h/i.test(text(o)) || !/0\.0[2-5]|halve|cut insulin/i.test(text(o))))
      .map((o) => at(name, o)));
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
