import { describe, it, expect, beforeAll } from 'vitest';
import { encryptToken, decryptToken, maskToken, generateWebhookSecret } from './encryption.js';

describe('AES-256-GCM Cryptography & Token Vault', () => {
  beforeAll(() => {
    // Ensure test master key is present (32 bytes = 64 hex characters)
    process.env.APP_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  it('should encrypt a Telegram bot token and decrypt it back to original plain text', () => {
    const rawToken = '7123456789:AAFlM_abcdef123456789_XYZ-testSecret';
    
    const encrypted = encryptToken(rawToken);
    
    expect(encrypted.encryptedText).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();
    expect(encrypted.encryptedText).not.toBe(rawToken);

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(rawToken);
  });

  it('should generate a unique IV and different ciphertext for identical plain texts', () => {
    const rawToken = '7123456789:AAFlM_abcdef123456789_XYZ-testSecret';
    
    const enc1 = encryptToken(rawToken);
    const enc2 = encryptToken(rawToken);

    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.encryptedText).not.toBe(enc2.encryptedText);
    expect(decryptToken(enc1)).toBe(rawToken);
    expect(decryptToken(enc2)).toBe(rawToken);
  });

  it('should fail decryption and throw an error when ciphertext is tampered with (Auth Tag verification)', () => {
    const rawToken = '7123456789:AAFlM_abcdef123456789_XYZ-testSecret';
    const encrypted = encryptToken(rawToken);

    // Tamper with the ciphertext by flipping characters
    const tamperedCipher = encrypted.encryptedText.slice(0, -2) + (encrypted.encryptedText.endsWith('0') ? '1' : '0');
    
    expect(() => {
      decryptToken({
        ...encrypted,
        encryptedText: tamperedCipher,
      });
    }).toThrow();
  });

  it('should correctly mask bot tokens for logs and UI display', () => {
    const token = '123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ';
    const masked = maskToken(token);

    expect(masked).toBe('123456...xyZ');
    expect(masked).not.toContain('ABCDefGhIJKlmNoPQRsTUV');
  });

  it('should generate a secure 64-character hex webhook secret token', () => {
    const secret1 = generateWebhookSecret();
    const secret2 = generateWebhookSecret();

    expect(secret1).toHaveLength(64);
    expect(secret2).toHaveLength(64);
    expect(secret1).not.toBe(secret2);
  });
});
