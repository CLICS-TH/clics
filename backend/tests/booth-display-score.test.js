const fs = require('fs');
const path = require('path');
const { DISPLAY_SCALE, TIER_SCALE, displayScore, tierScore, shownScore } = require('../src/booth-cases/display-score');
const { isAdmitted, tierPaths, tableScore } = require('../src/booth-cases/tree-schema');

describe('booth display score, display-v2 (ADR 0013): now only the fallback for a five-step row with no tier path', () => {
  test('a five-step raw composite maps 26 → 0, 61 → 100, linear between, whole and clamped', () => {
    expect(displayScore(26, 5)).toBe(0);
    expect(displayScore(61, 5)).toBe(100);
    expect(displayScore(43.5, 5)).toBe(50);
    expect(displayScore(44, 5)).toBe(51);
    expect(displayScore(10, 5)).toBe(0);
    expect(displayScore(90, 5)).toBe(100);
    for (let r = 0; r <= 100; r += 1) expect(Number.isInteger(displayScore(r, 5))).toBe(true);
  });

  test('the map never reorders two scores, so the board order is the raw order', () => {
    for (let a = 0; a < 100; a += 1) expect(displayScore(a + 1, 5)).toBeGreaterThanOrEqual(displayScore(a, 5));
    for (let a = DISPLAY_SCALE.floor; a < DISPLAY_SCALE.ceiling; a += 1) {
      expect(displayScore(a + 1, 5)).toBeGreaterThan(displayScore(a, 5));
    }
  });

  test('a three-step event shows the raw score unchanged', () => {
    expect(displayScore(72.4, 3)).toBe(72.4);
  });

});

describe('booth shown score, tiers-v1 (ADR 0016)', () => {
  test('best 20, reasonable 10, weaker 0 a step: all best is 100, all weaker 0', () => {
    expect(TIER_SCALE).toMatchObject({ version: 'tiers-v1', steps: 5, points: { B: 20, R: 10, W: 0 } });
    expect(tierScore('BBBBB')).toBe(100);
    expect(tierScore('WWWWW')).toBe(0);
    expect(tierScore('BRWRB')).toBe(60);
    const scores = tierPaths(5).map((p) => tierScore(p));
    expect(scores).toHaveLength(243);
    expect(new Set(scores)).toEqual(new Set([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]));
  });

  test.each([[null], [undefined], [''], ['BBBB'], ['BBBBBB'], ['BBBBX'], ['bbbbb'], [12345]])('%p is no tier score', (p) => {
    expect(tierScore(p)).toBeNull();
  });

  test('a five-step play shows its tier score whatever its raw composite; one with no tier path falls back to display-v2', () => {
    expect(shownScore(30, 'BBBBB', 5)).toEqual({ score: 100, tiered: true });
    expect(shownScore(61, 'WWWWW', 5)).toEqual({ score: 0, tiered: true });
    expect(shownScore(61, null, 5)).toEqual({ score: displayScore(61, 5), tiered: false });
  });

  test('a three-step play shows its raw composite and ranks with the others on it', () => {
    expect(shownScore(72.4, 'BBB', 3)).toEqual({ score: 72.4, tiered: true });
  });

  test('on every admitted NFCME-2026 five-step case, all best shows 100 and no path shows more', () => {
    const dir = path.join(__dirname, '../src/booth-cases/NFCME-2026');
    const cases = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter((k) => k.banks && k.banks.step5 && isAdmitted(k));
    expect(cases.length).toBeGreaterThan(0);
    for (const k of cases) {
      const paths = Object.keys(k.path_score_table.paths);
      expect(tableScore(k, 'BBBBB').composite).toBeGreaterThan(0);
      expect(Math.max(...paths.map((p) => shownScore(tableScore(k, p).composite, p, 5).score))).toBe(100);
      expect(shownScore(tableScore(k, 'BBBBB').composite, 'BBBBB', 5).score).toBe(100);
    }
  });
});
