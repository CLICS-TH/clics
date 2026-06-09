// Invite tokens: high-entropy raw token, only the sha256 hash is ever stored, lookups hash-match.
const { newInviteToken, hashToken } = require('../src/lib/invite-token');

test('hashToken is deterministic 64-hex sha256', () => {
  const h = hashToken('abc');
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(hashToken('abc')).toBe(h);
});

test('newInviteToken: raw is high-entropy and never equals its stored hash', () => {
  const { raw, hash } = newInviteToken();
  expect(raw.length).toBeGreaterThanOrEqual(40);   // 32 bytes base64url ≈ 43 chars
  expect(hash).toBe(hashToken(raw));
  expect(raw).not.toBe(hash);
});

test('tokens are unique across calls', () => {
  const a = newInviteToken(), b = newInviteToken();
  expect(a.raw).not.toBe(b.raw);
  expect(a.hash).not.toBe(b.hash);
});
