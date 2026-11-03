import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noise } from './sandbox-noise.mjs';

const play = (case_id, group, composite) => ({ case_id, group, composite });

test('path sigma is the RMS run-to-run difference over root 2, and persona sigma the pooled within-run SD', () => {
  const run1 = { plays: [play('a', 'best', 40), play('a', 'weakest', 30), play('a', 'strong', 40), play('a', 'strong', 44)] };
  const run2 = { plays: [play('a', 'best', 46), play('a', 'weakest', 22), play('a', 'strong', 50), play('a', 'strong', 50), play('a', 'best', null)] };
  const n = noise([run1, run2]);
  assert.deepEqual(n.path, { sigma: 5, pairs: 2, median_abs_diff: 6, max_abs_diff: 8 });
  assert.deepEqual(n.persona, { sigma: 2, df: 2 });
});
