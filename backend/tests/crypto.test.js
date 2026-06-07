const { encryptJson, decryptJson } = require('../src/lib/crypto');

describe('identity vault crypto (AES-256-GCM)', () => {
  test('round-trips an identity object', () => {
    const identity = { name: 'นพ. สมชาย', email: 'a@b.c', provider_subject: 'google-123' };
    expect(decryptJson(encryptJson(identity))).toEqual(identity);
  });

  test('two encryptions of the same value differ (random IV)', () => {
    expect(encryptJson({ a: 1 })).not.toBe(encryptJson({ a: 1 }));
  });

  test('tampered ciphertext is rejected by the auth tag', () => {
    const buf = Buffer.from(encryptJson({ secret: 'x' }), 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a bit in the ciphertext
    expect(() => decryptJson(buf.toString('base64'))).toThrow();
  });
});
