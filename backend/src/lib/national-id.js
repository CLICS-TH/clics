// Thai national ID (เลขประจำตัวประชาชน) — validation and normalisation only.
//
// This module deliberately does NOT store, log, or transmit anything. It answers one question —
// "is this string a well-formed Thai national ID?" — so a typo is rejected in the browser round-trip
// instead of consuming an administrator's time and, worse, being written to a table where it then
// has to be found and removed.
//
// The number is 13 digits with a mod-11 check digit, so a single mistyped or transposed digit is
// caught here with certainty. That is the whole value of checking it: it is an integrity check, not
// an identity check. A well-formed number proves nothing about whose number it is.

// Accept the forms people actually type: spaces and hyphens are how the number is printed on the
// card (1-2345-67890-12-3), so rejecting them would be rejecting the correct answer.
function normalise(raw) {
  return String(raw ?? '').replace(/[\s-]/g, '');
}

// Weights 13..2 over the first twelve digits; the thirteenth is the check digit.
function isValid(raw) {
  const id = normalise(raw);
  if (!/^\d{13}$/.test(id)) return false;
  // A leading 0 is not issued, and 0000000000000 / 1111111111111 style placeholders pass the
  // checksum on some variants — reject the degenerate all-same-digit case explicitly.
  if (id[0] === '0') return false;
  if (/^(\d)\1{12}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return ((11 - (sum % 11)) % 10) === Number(id[12]);
}

// Last four digits, for a human to confirm they are looking at the right record without the full
// number being on screen. Anything shorter is useless for confirmation; anything longer starts
// being the identifier itself.
function last4(raw) {
  const id = normalise(raw);
  return /^\d{13}$/.test(id) ? id.slice(-4) : null;
}

module.exports = { normalise, isValid, last4 };
