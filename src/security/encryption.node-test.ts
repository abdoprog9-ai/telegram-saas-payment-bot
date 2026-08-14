import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encryptToken, decryptToken, maskToken, generateWebhookSecret } from './encryption.js';

describe('Phase 1 Security & Crypto Verification (AES-256-GCM)', () => {
  process.env.APP_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('1. should successfully encrypt and decrypt Telegram Bot Token', () => {
    const rawToken = '7123456789:AAFlM_abcdef123456789_XYZ-testSecret';
    const encrypted = encryptToken(rawToken);

    assert.ok(encrypted.encryptedText, 'Encrypted text must be present');
    assert.ok(encrypted.iv, 'IV must be present');
    assert.ok(encrypted.authTag, 'Auth tag must be present');
    assert.notEqual(encrypted.encryptedText, rawToken, 'Ciphertext must not match raw token');

    const decrypted = decryptToken(encrypted);
    assert.equal(decrypted, rawToken, 'Decrypted token must exactly match raw token');
  });

  it('2. should use random unique IVs for each encryption', () => {
    const rawToken = '7123456789:AAFlM_abcdef123456789_XYZ-testSecret';
    const enc1 = encryptToken(rawToken);
    const enc2 = encryptToken(rawToken);

    assert.notEqual(enc1.iv, enc2.iv, 'IVs must be randomized for each call');
    assert.notEqual(enc1.encryptedText, enc2.encryptedText, 'Ciphertext must differ due to unique IV');
    assert.equal(decryptToken(enc1), rawToken);
    assert.equal(decryptToken(enc2), rawToken);
  });

  it('3. should reject tampered ciphertext and prevent forged tokens', () => {
    const rawToken = '7123456789:AAFlM_abcdef123456789_XYZ-testSecret';
    const encrypted = encryptToken(rawToken);

    // Keep hex length even by replacing the last 2 hex chars with different valid hex chars
    const lastTwo = encrypted.encryptedText.slice(-2);
    const replacement = lastTwo === 'aa' ? 'bb' : 'aa';
    const tamperedCipher = encrypted.encryptedText.slice(0, -2) + replacement;

    assert.throws(
      () => {
        decryptToken({
          ...encrypted,
          encryptedText: tamperedCipher,
        });
      },
      /Unsupported state or unable to authenticate data|bad auth tag/,
      'Tampered ciphertext must fail authentication tag check'
    );
  });

  it('4. should correctly mask tokens for display and logs', () => {
    const token = '123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ';
    const masked = maskToken(token);

    assert.equal(masked, '123456...xyZ');
    assert.equal(masked.includes('ABCDefGhIJKlmNoPQRsTUV'), false);
  });

  it('5. should generate cryptographically strong 64-char webhook secret tokens', () => {
    const secret1 = generateWebhookSecret();
    const secret2 = generateWebhookSecret();

    assert.equal(secret1.length, 64);
    assert.equal(secret2.length, 64);
    assert.notEqual(secret1, secret2);
  });
});
