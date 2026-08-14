import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 96-bit IV for AES-GCM
const AUTH_TAG_LENGTH = 16; // Standard 128-bit Auth Tag

export interface EncryptedData {
  encryptedText: string; // Hex or base64 encoded ciphertext
  iv: string;            // Hex encoded initialization vector
  authTag: string;       // Hex encoded authentication tag
}

/**
 * Retrieves and validates the 32-byte master encryption key from environment.
 */
function getMasterKey(): Buffer {
  const masterKeyHex = process.env.APP_MASTER_KEY;
  if (!masterKeyHex) {
    throw new Error('FATAL SECURITY ERROR: APP_MASTER_KEY is not defined in environment variables.');
  }

  const keyBuffer = Buffer.from(masterKeyHex, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(`FATAL SECURITY ERROR: APP_MASTER_KEY must be exactly 32 bytes (64 hex chars), got ${keyBuffer.length} bytes.`);
  }

  return keyBuffer;
}

/**
 * Encrypts sensitive plain text (such as Telegram Bot Token) using AES-256-GCM.
 */
export function encryptToken(plainText: string): EncryptedData {
  if (!plainText || typeof plainText !== 'string') {
    throw new Error('Invalid plainText supplied for encryption.');
  }

  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    encryptedText: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypts ciphertext using AES-256-GCM and verifies authenticity with Auth Tag.
 */
export function decryptToken(encryptedData: EncryptedData): string {
  if (!encryptedData || !encryptedData.encryptedText || !encryptedData.iv || !encryptedData.authTag) {
    throw new Error('Invalid EncryptedData object supplied for decryption.');
  }

  const masterKey = getMasterKey();
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const authTag = Buffer.from(encryptedData.authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData.encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Masks a Telegram bot token for safe display in UI or logs.
 * Example: '123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ' -> '123456...xyZ'
 */
export function maskToken(token: string): string {
  if (!token || typeof token !== 'string') return '***';
  if (token.length <= 10) return '***';
  const prefix = token.slice(0, 6);
  const suffix = token.slice(-3);
  return `${prefix}...${suffix}`;
}

/**
 * Generates a cryptographically secure random secret token for Telegram Webhook verification.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex'); // 64-character hex string
}
