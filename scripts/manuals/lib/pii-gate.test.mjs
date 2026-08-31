/*
 * The gate's own tests. Every CLEAN case here is a string that must be publishable, and every DIRTY
 * case is one that must stop a build — a gate that has never refused anything is not yet a gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, ascii } from './pii-gate.mjs';

const rules = (t) => [...new Set(scanText(t).map((f) => f.rule))].sort();

// ---- clean: the manual's actual subject matter must not trip it ------------------------------
test('pilot pseudonyms and ordinary UI chrome pass', () => {
  assert.deepEqual(rules('P-014 · CLE-102 · คะแนน PIS-7 82/100 · 12 รอบสนทนา'), []);
  assert.deepEqual(rules('เข้าสู่ระบบ / Login · อีเมล / Email · รหัสผ่าน / Password'), []);
  assert.deepEqual(rules('ชื่อ-นามสกุล: P-014'), [], 'a pseudonym in a name field is what SHOULD be there');
});

test('clinical prose is not a name', () => {
  assert.deepEqual(rules('ผู้ป่วยหญิงอายุ 78 ปี มีภาวะหัวใจล้มเหลวเรื้อรังร่วมกับโรคไตวาย'), []);
});

test('long numbers that are not identifiers pass', () => {
  assert.deepEqual(rules('24000 tokens · 1280px · 2026-08-29'), []);
  assert.deepEqual(rules('รหัสอ้างอิง 123456789012345'), [], '15 digits is not a national ID');
});

// ---- dirty: each of these must refuse the frame -----------------------------------------------
test('a 13-digit national ID is caught, separators or not', () => {
  assert.ok(rules('เลขประจำตัวประชาชน 1234567890123').includes('national-id'));
  assert.ok(rules('เลขประจำตัวประชาชน 1-2345-67890-12-3').includes('national-id'));
});

test('Thai numerals do not smuggle an ID past the digit rule', () => {
  assert.equal(ascii('๑๒๓๔๕๖๗๘๙๐๑๒๓'), '1234567890123');
  assert.ok(rules('เลขประจำตัวประชาชน ๑๒๓๔๕๖๗๘๙๐๑๒๓').includes('national-id'),
    'a Thai-numeral ID renders identically to a reader and must be caught identically');
});

test('an email address is caught', () => {
  assert.ok(rules('ติดต่อ somchai.p@hospital.ac.th').includes('email'));
});

test('a labelled licence value is caught', () => {
  assert.ok(rules('ใบอนุญาต / Licence: ว.12345').includes('licence'));
});

test('an honorific followed by a name is caught', () => {
  assert.ok(rules('นพ.สมชาย ตรวจประเมินแล้ว').includes('named-person'));
  assert.ok(rules('ศาสตราจารย์ประเสริฐศักดิ์').includes('named-person'));
});

test('a real name in a name field is caught, unlike a pseudonym', () => {
  assert.ok(rules('ชื่อ-นามสกุล: สมชาย').includes('named-person'));
});

// ---- the gate must agree with the boundary it borrows from -----------------------------------
test("anything rimpl's PII filter would redact also refuses the frame", () => {
  // The readability fixtures deliberately contain a full Thai name, so they double as an adversary.
  const hostile = 'ศาสตราจารย์เกียรติคุณ นายแพทย์ประเสริฐศักดิ์ วงศ์เจริญรุ่งเรืองพิพัฒน์';
  assert.ok(scanText(hostile).length > 0, 'the audit fixtures must not be publishable as-is');
});

test('findings carry a rule, the matched text, and a reason', () => {
  const f = scanText('เลขประจำตัวประชาชน 1234567890123')[0];
  assert.ok(f.rule && f.match && f.why);
});

// ---- the AGE/DATE carve-out, pinned so it cannot be widened or narrowed by accident ------------
test('a date and an age do NOT refuse a frame — every product screenshot contains them', () => {
  assert.deepEqual(rules('บทเรียนล่าสุด 29 ส.ค. 2026 · ผู้ป่วยหญิงอายุ 78 ปี'), [],
    'refusing these would refuse every usable frame, and a gate that refuses everything gets disabled');
});

test('but a name or a phone number in the same sentence still refuses it', () => {
  assert.ok(rules('29 ส.ค. 2026 · นพ.สมชาย · 081-234-5678').some((r) => r.startsWith('pii-filter:') || r === 'named-person'));
  assert.ok(rules('ติดต่อ 081-234-5678').includes('pii-filter:PHONE'));
  assert.ok(rules('HN 12345 ของผู้ป่วย').includes('pii-filter:HN'));
});

// ---- the two false positives that would have made this gate unusable --------------------------
test('a licence LABEL is not itself a licence value', () => {
  assert.deepEqual(rules('ใบอนุญาต / Licence number'), [],
    'the label\'s own words reported "number" as a licence before this was fixed');
  assert.ok(rules('ใบอนุญาต / Licence: ว.12345').includes('licence'), 'a real value must still be caught');
});

test("rimpl's over-eager NAME pass reports for review but does not refuse a frame", () => {
  const t = 'Longitudinal Personal Development Profile — เส้นทางคะแนน PIS-7 ของคุณตลอดการเรียนรู้';
  assert.deepEqual(rules(t), [], 'ordinary Thai UI copy must not refuse a screenshot');
  assert.ok(scanText(t).review.length > 0, 'but it is still surfaced for a human to read');
});

test('a name behind an honorific is still fatal, NAME demotion notwithstanding', () => {
  assert.ok(rules('ศาสตราจารย์เกียรติคุณ นายแพทย์ประเสริฐศักดิ์').includes('named-person'));
});
