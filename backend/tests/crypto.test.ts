/**
 * gem-twa — Crypto tests
 *
 * Tests AES-256-GCM encrypt/decrypt roundtrip and security properties.
 */

import { test } from 'node:test';
import assert   from 'node:assert';

import { encryptPrivateKey, decryptPrivateKey } from '../src/vault/crypto';

const MASTER_SECRET  = 'test-master-secret-for-unit-tests';
const ORIGINAL_KEY   = '0xdeadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('encrypt/decrypt roundtrip', () => {
  const encrypted = encryptPrivateKey(ORIGINAL_KEY, MASTER_SECRET);
  const decrypted = decryptPrivateKey(encrypted, MASTER_SECRET);
  assert.strictEqual(decrypted, ORIGINAL_KEY, 'decrypted value should match original');
});

test('encrypted text не содержит оригинальный ключ', () => {
  const encrypted = encryptPrivateKey(ORIGINAL_KEY, MASTER_SECRET);
  assert.ok(
    !encrypted.includes(ORIGINAL_KEY),
    'encrypted output must not contain the original private key in plaintext',
  );
  // Also verify the raw hex key bytes are not present
  const keyHex = Buffer.from(ORIGINAL_KEY, 'utf8').toString('hex');
  assert.ok(
    !encrypted.includes(keyHex),
    'encrypted output must not contain hex-encoded key bytes',
  );
});

test('два шифрования дают разный IV', () => {
  const encrypted1 = encryptPrivateKey(ORIGINAL_KEY, MASTER_SECRET);
  const encrypted2 = encryptPrivateKey(ORIGINAL_KEY, MASTER_SECRET);

  // Format: salt:iv:authTag:ciphertext — IV is the second segment
  const iv1 = encrypted1.split(':')[1];
  const iv2 = encrypted2.split(':')[1];

  assert.notStrictEqual(
    iv1,
    iv2,
    'two encryptions of the same key must produce different IVs (random IV per encryption)',
  );

  // Salts should also differ
  const salt1 = encrypted1.split(':')[0];
  const salt2 = encrypted2.split(':')[0];
  assert.notStrictEqual(salt1, salt2, 'two encryptions must also produce different salts');

  // Both should still decrypt correctly
  assert.strictEqual(decryptPrivateKey(encrypted1, MASTER_SECRET), ORIGINAL_KEY);
  assert.strictEqual(decryptPrivateKey(encrypted2, MASTER_SECRET), ORIGINAL_KEY);
});
