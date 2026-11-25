const fs = require('fs');
const path = require('path');
const { DISPLAY_SCALE, displayScore } = require('../src/booth-cases/display-score');
const { isAdmitted, tableScore } = require('../src/booth-cases/tree-schema');

describe('booth display score (ADR 0013)', () => {
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

  test('display-v2 anchors are the admitted NFCME-2026 five-step range: every path lands in 0–100 and both ends are reached', () => {
    const dir = path.join(__dirname, '../src/booth-cases/NFCME-2026');
    const raws = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter((k) => k.banks && k.banks.step5 && isAdmitted(k))
      .flatMap((k) => Object.keys(k.path_score_table.paths).map((p) => tableScore(k, p).composite));
    expect(raws.length).toBeGreaterThan(0);
    expect(Math.min(...raws)).toBe(DISPLAY_SCALE.floor);
    expect(Math.max(...raws)).toBe(DISPLAY_SCALE.ceiling);
  });
});
