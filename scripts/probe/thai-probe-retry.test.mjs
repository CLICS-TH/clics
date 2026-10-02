// thai-probe.mjs runs its probe at import (network, top-level await), so its retry arithmetic is
// pinned by reading the source. The retry line must count what routes/chat.js retries on — the
// citation RULE (a citation OR the "(no specific source cited)" note), not the citation SHAPE — or
// it overstates retries for every note-only reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('./thai-probe.mjs', import.meta.url)), 'utf8');
const chat = readFileSync(fileURLToPath(new URL('../../rimpl/src/routes/chat.js', import.meta.url)), 'utf8');

test('the retry line is computed with meetsCitationRule, the predicate chat.js retries on', () => {
  assert.match(src, /import \{[^}]*\bmeetsCitationRule\b[^}]*\} from '\.\.\/\.\.\/rimpl\/src\/services\/post-filter\.js'/);
  assert.ok(src.includes('citationRule: meetsCitationRule(text),'));
  assert.ok(src.includes('const clean = answered.filter((r) => r.citationRule && r.socratic).length;'));
  assert.ok(src.includes('const retryRate = answered.length ? 1 - clean / answered.length : 0;'));
  assert.ok(chat.includes('!meetsCitationRule(text)'), 'chat.js no longer retries on meetsCitationRule — re-align this probe');
});

test('the citation SHAPE stays a separate, reported-only row', () => {
  assert.ok(src.includes('citation: hasCitation(text),'));
  assert.ok(src.includes("['(Source, Year) citation (shape)'"));
  assert.ok(src.includes("['citation rule (shape or note)'"));
});
