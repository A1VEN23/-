/**
 * gem-twa — Telegram Mini App initData validation
 *
 * Security features:
 *  - HMAC-SHA256 verification per official Telegram spec
 *  - auth_date freshness check (max 24 h)
 *  - Nonce store: Map<string, number> prevents initData replay within 24 h
 *  - console.warn on auth failure with client IP
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface ValidationResult {
  valid: boolean;
  user?: TelegramUser;
}

// ---------------------------------------------------------------------------
// Nonce store — Map<nonceKey, timestamp>
// Prevents replay attacks within the 24-hour window.
// ---------------------------------------------------------------------------

const MAX_AUTH_AGE_MS = 24 * 60 * 60 * 1_000; // 24 h

/** nonceKey → first-seen timestamp (ms) */
const usedNonces = new Map<string, number>();

// Purge expired nonces every hour so the Map doesn't grow unbounded
setInterval(() => {
  const cutoff = Date.now() - MAX_AUTH_AGE_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}, 60 * 60 * 1_000);

// ---------------------------------------------------------------------------
// Bot token (required at module load)
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Validates Telegram Mini App `initData` per the official spec:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Steps:
 *   1. Parse query string.
 *   2. Extract and remove `hash`.
 *   3. Sort remaining fields alphabetically → "key=value\n" join.
 *   4. HMAC-SHA256 of that string with key = HMAC-SHA256("WebAppData", BOT_TOKEN).
 *   5. Compare hex digest with provided hash (constant-time via timingSafeEqual workaround).
 *   6. Validate auth_date ≤ 24 h old.
 *   7. Parse user JSON.
 */
export function validateInitData(initData: string): ValidationResult {
  if (!initData) return { valid: false };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { valid: false };
  }

  const receivedHash = params.get('hash');
  if (!receivedHash) return { valid: false };

  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // Derive secret key: HMAC-SHA256("WebAppData", BOT_TOKEN)
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN!)
    .digest();

  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(receivedHash, 'hex'))) {
    return { valid: false };
  }

  // Validate auth_date freshness
  const authDateStr = params.get('auth_date');
  if (!authDateStr) return { valid: false };

  const authDate = parseInt(authDateStr, 10);
  if (isNaN(authDate)) return { valid: false };

  const ageMs = Date.now() - authDate * 1_000;
  if (ageMs < 0 || ageMs > MAX_AUTH_AGE_MS) {
    return { valid: false };
  }

  // Parse user
  const userStr = params.get('user');
  if (!userStr) return { valid: false };

  let user: TelegramUser;
  try {
    user = JSON.parse(userStr) as TelegramUser;
  } catch {
    return { valid: false };
  }

  if (!user.id || !user.first_name) return { valid: false };

  return { valid: true, user };
}

// ---------------------------------------------------------------------------
// Fastify module augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    telegramUser?: TelegramUser;
  }
}

// ---------------------------------------------------------------------------
// Fastify preHandler
// ---------------------------------------------------------------------------

/**
 * Validates `Authorization: tma <initData>` header.
 * On success → attaches request.telegramUser.
 * On failure → replies 401 and logs a warn with client IP.
 * Enforces nonce uniqueness to block replay attacks.
 */
export async function telegramAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ip = (
    (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? request.ip
  );

  const authHeader = request.headers['authorization'] ?? '';
  if (!authHeader.startsWith('tma ')) {
    console.warn('Auth failed, ip:', ip);
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const initData = authHeader.slice(4);

  // Derive nonce key from auth_date + hash
  let nonceKey: string | null = null;
  try {
    const p = new URLSearchParams(initData);
    const authDate = p.get('auth_date');
    const hash     = p.get('hash');
    if (authDate && hash) {
      nonceKey = `${authDate}:${hash}`;
    }
  } catch {
    // fall through
  }

  if (!nonceKey) {
    console.warn('Auth failed, ip:', ip);
    return reply.status(401).send({ error: 'Malformed initData' });
  }

  if (usedNonces.has(nonceKey)) {
    console.warn('Auth failed, ip:', ip);
    return reply.status(401).send({ error: 'Replay detected' });
  }

  const result = validateInitData(initData);
  if (!result.valid || !result.user) {
    console.warn('Auth failed, ip:', ip);
    return reply.status(401).send({ error: 'Invalid Telegram initData' });
  }

  // Record nonce to prevent replay
  usedNonces.set(nonceKey, Date.now());

  request.telegramUser = result.user;
}
