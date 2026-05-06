/**
 * gem-twa — Rate limit tests
 *
 * Tests sliding-window logic using the checkRateLimit() function.
 * Mocks the DB so tests run without Prisma.
 */

import { test, mock } from 'node:test';
import assert          from 'node:assert';

// ---------------------------------------------------------------------------
// Mock Prisma before importing the module under test
// ---------------------------------------------------------------------------

// The ratelimit module imports prisma for IP block persistence.
// We stub it so tests run without a real database.
mock.module('../src/db', {
  namedExports: {
    prisma: {
      ipBlock: {
        upsert:   async () => ({}),
        findMany: async () => ([]),
      },
    },
  },
});

// Now import the module under test (after mock is set up)
const { checkRateLimit } = await import('../src/ratelimit/index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ipCounter = 0;
/** Generate a unique IP for each test so limits don't bleed across tests. */
function freshIp(): string {
  return `10.0.0.${++ipCounter}`;
}

let tidCounter = 0;
function freshTid(): string {
  return `user_${++tidCounter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('позволяет 30 запросов, блокирует 31-й', async () => {
  const ip  = freshIp();
  const tid = freshTid();

  // 30 requests should all succeed
  for (let i = 0; i < 30; i++) {
    await assert.doesNotReject(
      () => checkRateLimit(ip, tid),
      `request ${i + 1} should be allowed`,
    );
  }

  // 31st should be rejected with 429
  await assert.rejects(
    () => checkRateLimit(ip, tid),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'should be an Error');
      assert.strictEqual((err as { statusCode?: number }).statusCode, 429, 'statusCode should be 429');
      return true;
    },
    '31st request should be rate-limited',
  );
});

test('отдельный лимит для send: 5/hour', async () => {
  const ip  = freshIp();
  const tid = freshTid();

  // 5 send operations should succeed
  for (let i = 0; i < 5; i++) {
    await assert.doesNotReject(
      () => checkRateLimit(ip, tid, 'send'),
      `send operation ${i + 1} should be allowed`,
    );
  }

  // 6th send should be rejected with 429
  await assert.rejects(
    () => checkRateLimit(ip, tid, 'send'),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'should be an Error');
      assert.strictEqual((err as { statusCode?: number }).statusCode, 429);
      assert.ok(
        (err as Error).message.includes('send'),
        'error message should mention send limit',
      );
      return true;
    },
    '6th send should be rate-limited',
  );
});
