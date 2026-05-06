/**
 * gem-twa — Auth tests
 *
 * Uses Node.js built-in test runner (node:test).
 * Validates initData rejection for common attack vectors.
 */

import { test } from 'node:test';
import assert   from 'node:assert';

// We need a real BOT_TOKEN for HMAC derivation; use a dummy in tests.
process.env.TELEGRAM_BOT_TOKEN = 'test_bot_token_12345';

import { validateInitData } from '../src/auth/telegram';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal valid initData query string for testing.
 * auth_date defaults to "now" so freshness check passes.
 * Does NOT compute a real hash — used to test rejection paths.
 */
function makeInitData(overrides: Record<string, string> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const base: Record<string, string> = {
    auth_date: String(now),
    user:      JSON.stringify({ id: 12345, first_name: 'Test' }),
    hash:      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ...overrides,
  };
  return new URLSearchParams(base).toString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('rejects empty string', () => {
  const result = validateInitData('');
  assert.strictEqual(result.valid, false, 'empty string should be rejected');
});

test('rejects expired auth_date — старше 24ч', () => {
  // auth_date 25 hours in the past
  const expiredDate = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
  const initData = makeInitData({ auth_date: String(expiredDate) });
  const result = validateInitData(initData);
  assert.strictEqual(result.valid, false, 'expired auth_date should be rejected');
});

test('rejects wrong hash', () => {
  const initData = makeInitData({ hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const result = validateInitData(initData);
  assert.strictEqual(result.valid, false, 'wrong hash should be rejected');
});

test('rejects missing hash field', () => {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user:      JSON.stringify({ id: 12345, first_name: 'Test' }),
    // no hash field
  });
  const result = validateInitData(params.toString());
  assert.strictEqual(result.valid, false, 'missing hash should be rejected');
});
