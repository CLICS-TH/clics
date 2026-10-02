// Clinician packet: selection, escaping, self-containment and Thai readability (contrast + size).
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectForReview, renderHtml, renderCsv, PALETTE, CONTRAST_PAIRS, esc } from './clinician-export.mjs';
import { checkReply } from './checks.mjs';
import { ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII, GOOD_TH_EXAMINER, entryFor, reportFor } from './test-fixtures.mjs';

/** WCAG 2.x relative luminance contrast ratio. */
function contrast(hexA, hexB) {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const items = [ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII];
const bankById = new Map(items.map((i) => [i.id, i]));
function withChecks(item, text) {
  const e = entryFor(item, text);
  e.checks = checkReply(item, e);
  return e;
}
const report = reportFor('local-test', 'local', 'm', [
  withChecks(ITEM_TH_EXAMINER, GOOD_TH_EXAMINER),
  withChecks(ITEM_EN_NATURAL, 'ตอบภาษาไทย <script>alert(1)</script> (KDIGO, 2022)'),   // wrong language → flagged
  withChecks(ITEM_RESCUE, 'คุณกำลังชั่งน้ำหนักอะไรอยู่?'),
  withChecks(ITEM_PII, 'Exclude SAH (Perry, 2011).'),
]);

test('every text/background pair meets WCAG AA (>= 4.5:1)', () => {
  for (const [fg, bg] of CONTRAST_PAIRS) {
    const r = contrast(PALETTE[fg], PALETTE[bg]);
    assert.ok(r >= 4.5, `${fg} on ${bg}: ${r.toFixed(2)}:1`);
  }
});

test('Thai typography: body >= 16px, line-height >= 1.6, no element below 15px', () => {
  const html = renderHtml({ report, selection: selectForReview({ report, bankById, sample: 2 }) });
  const body = html.match(/body \{[^}]*\}/)[0];
  assert.ok(Number(body.match(/font-size:\s*(\d+)px/)[1]) >= 16);
  assert.ok(Number(body.match(/line-height:\s*([\d.]+)/)[1]) >= 1.6);
  for (const m of html.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 15, `font-size ${m[1]}px is too small for Thai`);
  assert.match(html, /<html lang="th">/);
  assert.match(html, /name="viewport"/);
});

test('selection: every flagged reply, plus a seeded random sample of the rest', () => {
  const sel = selectForReview({ report, bankById, sample: 2, seed: 's' });
  assert.deepEqual(sel.flagged.map((r) => r.entry.id), [ITEM_EN_NATURAL.id]);
  assert.equal(sel.sampled.length, 2);
  assert.deepEqual(selectForReview({ report, bankById, sample: 2, seed: 's' }).sampled.map((r) => r.entry.id), sel.sampled.map((r) => r.entry.id));
  const cites = { items: [
    { id: ITEM_PII.id, citations: [{ status: 'unverified', raw: 'Perry, 2011', reason: 'x' }] },
    // A real publisher with an unidentified document — the commonest fabrication — must reach the clinician.
    { id: ITEM_TH_EXAMINER.id, citations: [{ status: 'publisher-only', raw: 'WHO Guideline on Garlic Extract for Hypertension, 2021', reason: 'x' }] },
    // ...and so must a real document with an invented topic grafted on.
    { id: ITEM_EN_NATURAL.id, citations: [{ status: 'document-unconfirmed', raw: 'KDIGO Clinical Practice Guideline for Turmeric in CKD, 2024', reason: 'x' }] },
  ] };
  const merged = { arms: [{ arm: 'arm1', label: 'local-test' }], per_item: { [ITEM_RESCUE.id]: { arm1: { flags: ['ANSWERED_FOR_PHYSICIAN'], min_scores: { safety: 1 } } } } };
  const sel2 = selectForReview({ report, bankById, cites, merged, sample: 0 });
  assert.deepEqual(sel2.flagged.map((r) => r.entry.id).sort(), [ITEM_EN_NATURAL.id, ITEM_RESCUE.id, ITEM_PII.id, ITEM_TH_EXAMINER.id].sort());
  assert.match(sel2.flagged.find((r) => r.entry.id === ITEM_TH_EXAMINER.id).reasons.join(), /citation publisher-only/);
  assert.match(sel2.flagged.find((r) => r.entry.id === ITEM_EN_NATURAL.id).reasons.join(), /citation document-unconfirmed/);
});

test('HTML: model output is escaped, and the file loads nothing from the network', () => {
  const html = renderHtml({ report, selection: selectForReview({ report, bankById, sample: 3 }) });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'reply HTML must be escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']?https?:/i, 'self-contained: no external resources');
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  assert.equal(esc(`"<&>'`), '&quot;&lt;&amp;&gt;&#39;');
});

test('CSV: UTF-8 BOM for Excel, quotes and newlines escaped, blank reviewer columns', () => {
  const csv = renderCsv({ report, selection: selectForReview({ report, bankById, sample: 0 }) });
  assert.ok(csv.startsWith('﻿'));
  const [head] = csv.slice(1).split('\r\n');
  assert.match(head, /verdict/);
  assert.match(csv, /"ตอบภาษาไทย <script>/, 'cells with special characters are quoted');
});
