// node --test scripts/manuals/lib/parse.test.mjs
//
// The parser is the one place a content mistake can become a silently wrong manual: a malformed
// callout that renders as a paragraph, a chip that loses its verbatim label, a translated file that
// quietly drops a section. Each of those is asserted here, and each assertion names the failure it
// prevents rather than the function it calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSections, parseSpans, parseManual, extractLabels } from './parse.mjs';

const only = (src) => parseSections(src).blocks ?? parseSections(src)[0].blocks;

test('a UI label keeps its exact text, slash and spacing', () => {
  // The house rule is that a reader matches the chip against what is on screen. Trimming, casing or
  // collapsing the spaces around the slash would break that silently.
  const [span] = parseSpans('[[  จบและส่ง / End  ]]').filter((s) => s.t === 'chip');
  assert.equal(span.v, 'จบและส่ง / End');
});

test('a neutral chip is distinguishable from a primary one', () => {
  // A secondary control tinted as the primary action teaches the wrong button.
  const spans = parseSpans('[[ส่งคะแนน / Submit]] or [[~ ยกเลิก / Cancel]]');
  assert.deepEqual(spans.filter((s) => s.t.startsWith('chip')).map((s) => s.t),
    ['chip', 'chip-neutral']);
});

test('bold inside a chip does not split the chip', () => {
  const spans = parseSpans('[[a ** b]]');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].t, 'chip');
});

test('extractLabels finds every label, neutral marker stripped', () => {
  assert.deepEqual(extractLabels('x [[A / a]] y [[~ B / b]]'), ['A / a', 'B / b']);
});

test('a numbered list stays a step sequence, a bulleted one does not', () => {
  // The distinction is what tells a reader "do these in order". Collapsing both to one list type is
  // the kind of loss that looks fine in review and misleads in use.
  assert.equal(only('## s | t\n\n1. one\n2. two')[0].t, 'steps');
  assert.equal(only('## s | t\n\n- one\n- two')[0].t, 'ul');
});

test('an unclosed callout fails the build instead of swallowing the rest of the section', () => {
  assert.throws(() => parseSections('## s | t\n\n::: warn head\nbody\n\nmore prose'),
    /never closed/);
});

test('an unknown directive is rejected rather than dropped', () => {
  // A renderer implements three kinds. Accepting a fourth would render it as nothing at all.
  assert.throws(() => parseSections('## s | t\n\n::: danger x\ny\n:::'), /unknown directive/);
});

test('a table without a separator row is rejected', () => {
  assert.throws(() => parseSections('## s | t\n\n| a | b |\n| 1 | 2 |'), /separator row/);
});

test('a non-kebab section id is rejected', () => {
  // Ids are the anchor, the deep link and the cross-language join key.
  assert.throws(() => parseSections('## Section One | t\n\nx'), /kebab-case/);
});

test('content before the first heading is rejected', () => {
  assert.throws(() => parseSections('stray prose\n\n## s | t'), /before the first/);
});

test('a table cell may contain an escaped pipe', () => {
  const [b] = only('## s | t\n\n| a | b |\n|---|---|\n| x \\| y | z |');
  assert.deepEqual(b.rows[0], ['x | y', 'z']);
});

test('a translation that drops a section fails the build', () => {
  assert.throws(
    () => parseManual({ th: '## a | ก\n\nx\n\n## b | ข\n\ny', en: '## a | A\n\nx', name: 'physician' }),
    /missing from .en.md: b/);
});

test('a translation that reorders sections fails the build', () => {
  // Same ids, different order — the toggle would land the reader in a different section.
  assert.throws(
    () => parseManual({ th: '## a | ก\n\nx\n\n## b | ข\n\ny', en: '## b | B\n\ny\n\n## a | A\n\nx', name: 'physician' }),
    /different order/);
});

test('a matching pair parses to the same ids in the same order', () => {
  const m = parseManual({ th: '## a | ก\n\nx\n\n## b | ข\n\ny', en: '## a | A\n\nx\n\n## b | B\n\ny' });
  assert.deepEqual(m.th.map((s) => s.id), m.en.map((s) => s.id));
  assert.equal(m.en[1].title, 'B');
});

test('a section title may contain a pipe', () => {
  assert.equal(parseSections('## a | ผล | Results')[0].title, 'ผล | Results');
});

test('a multi-line authoring comment does not leak into the manual', () => {
  // The body lines of a block comment do not start with `<!--`, so a naive skip would render the
  // authoring notes as prose.
  const s = parseSections('<!--\n  note to authors\n  more notes\n-->\n\n## a | ก\n\nreal prose');
  assert.equal(s.length, 1);
  assert.equal(s[0].blocks.length, 1);
  assert.equal(s[0].blocks[0].spans[0].v, 'real prose');
});

test('an unclosed comment fails rather than swallowing the file', () => {
  assert.throws(() => parseSections('<!-- oops\n\n## a | ก\n\nprose'), /never closed/);
});
