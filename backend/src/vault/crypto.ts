import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;      // 128-bit auth tag
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;      // 256 bits

/**
 * Derives a 256-bit key from the masterSecret using scrypt.
 * The salt is passed in so we can re-derive during decryption.
 */
function deriveKey(masterSecret: string, salt: Buffer): Buffer {
  return scryptSync(masterSecret, salt, KEY_LENGTH);
}

/**
 * Encrypts a private key (or mnemonic) with AES-256-GCM.
 *
 * Output format (all hex, colon-separated):
 *   salt:iv:authTag:ciphertext
 */
export function encryptPrivateKey(privateKey: string, masterSecret: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv   = randomBytes(IV_LENGTH);
  const key  = deriveKey(masterSecret, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKey, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypts a value previously encrypted by encryptPrivateKey.
 * Throws if the auth tag verification fails (tampered data).
 */
export function decryptPrivateKey(encrypted: string, masterSecret: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted format: expected salt:iv:authTag:ciphertext');
  }

  const [saltHex, ivHex, authTagHex, ciphertextHex] = parts;

  const salt       = Buffer.from(saltHex, 'hex');
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const key = deriveKey(masterSecret, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Returns the first 8 hex characters of an HMAC-SHA256 of the key.
 * Used for debug logging — never logs the actual key material.
 */
export function hashForDebug(key: string): string {
  const debugSecret = process.env.DEBUG_HMAC_SECRET ?? 'debug-only-not-secret';
  return createHmac('sha256', debugSecret)
    .update(key)
    .digest('hex')
    .slice(0, 8);
}
