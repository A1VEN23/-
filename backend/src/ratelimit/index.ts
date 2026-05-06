/**
 * gem-twa — Sliding-window rate limiter with IP blocking via DB
 *
 * Limits (all in-memory, sliding window):
 *   General:      30 req / minute  per IP
 *   send/swap:     5 req / hour    per (ip, telegramId)
 *   IP flood:    200 req / minute  per IP → 15-min block (persisted to IpBlock table)
 *
 * Also exports rateLimitMiddleware — a Fastify preHandler for use on routes
 * that should apply the general 30/min check without a telegramId.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RateLimitAction = 'send' | 'swap' | 'adminSweep';

class RateLimitError extends Error {
  statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

/** Sliding-window timestamps keyed by bucket string. */
const windows = new Map<string, number[]>();

/** IP → blocked-until timestamp (ms). */
const blockedIps = new Map<string, number>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS   = 60 * MINUTE_MS;

const GENERAL_LIMIT        = 30;   // per minute per IP
const SEND_LIMIT           = 5;    // per hour per (ip, telegramId)
const SWAP_LIMIT           = 5;    // per hour per (ip, telegramId)
const ADMIN_SWEEP_LIMIT    = 10;   // per hour per IP
const IP_FLOOD_LIMIT       = 200;  // per minute per IP → triggers block
const IP_BLOCK_DURATION_MS = 15 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWindow(bucket: string, windowMs: number): number[] {
  const now    = Date.now();
  const cutoff = now - windowMs;
  const ts     = (windows.get(bucket) ?? []).filter(t => t >= cutoff);
  windows.set(bucket, ts);
  return ts;
}

function recordRequest(bucket: string): void {
  const ts = windows.get(bucket) ?? [];
  ts.push(Date.now());
  windows.set(bucket, ts);
}

async function blockIp(ip: string, reason: string, durationMs: number): Promise<void> {
  const blockedUntil = new Date(Date.now() + durationMs);
  blockedIps.set(ip, blockedUntil.getTime());
  try {
    await prisma.ipBlock.upsert({
      where:  { ip },
      update: { blockedUntil, reason },
      create: { ip, blockedUntil, reason },
    });
  } catch (err) {
    console.error('[ratelimit] Failed to persist IP block:', err);
  }
}

// Pre-load persisted blocks from DB on startup
(async () => {
  try {
    const blocks = await prisma.ipBlock.findMany({
      where: { blockedUntil: { gt: new Date() } },
    });
    for (const b of blocks) {
      blockedIps.set(b.ip, b.blockedUntil.getTime());
    }
    console.info(`[ratelimit] Loaded ${blocks.length} active IP block(s) from DB`);
  } catch {
    // DB not yet ready — skip
  }
})();

// ---------------------------------------------------------------------------
// Main export: checkRateLimit
// ---------------------------------------------------------------------------

/**
 * Enforces sliding-window rate limits.
 *
 * @param ip         Client IP address.
 * @param telegramId Authenticated Telegram user ID (empty string for anon checks).
 * @param action     Optional action-specific limit key.
 *
 * Throws RateLimitError (429) on limit breach; records request on success.
 */
export async function checkRateLimit(
  ip: string,
  telegramId: string,
  action?: RateLimitAction,
): Promise<void> {
  const now = Date.now();

  // 1. IP block check
  const blockedUntilMs = blockedIps.get(ip);
  if (blockedUntilMs) {
    if (blockedUntilMs > now) {
      const secsLeft = Math.ceil((blockedUntilMs - now) / 1000);
      throw new RateLimitError(`IP blocked for ${secsLeft} more second(s). Reason: flood protection.`);
    }
    blockedIps.delete(ip);
  }

  // 2. IP flood check: 200 req / minute
  const ipBucket = `ip:${ip}`;
  const ipWindow = getWindow(ipBucket, MINUTE_MS);
  if (ipWindow.length >= IP_FLOOD_LIMIT) {
    await blockIp(ip, 'IP flood: exceeded 200 req/min', IP_BLOCK_DURATION_MS);
    throw new RateLimitError('Too many requests from this IP. Blocked for 15 minutes.');
  }

  // 3. General limit: 30 req / minute per IP
  const generalBucket = `general:${ip}`;
  const generalWindow = getWindow(generalBucket, MINUTE_MS);
  if (generalWindow.length >= GENERAL_LIMIT) {
    throw new RateLimitError('Rate limit exceeded: 30 requests per minute allowed.');
  }

  // 4. Action-specific limits
  if (action === 'send') {
    const bucket = `send:${ip}:${telegramId}`;
    const win    = getWindow(bucket, HOUR_MS);
    if (win.length >= SEND_LIMIT) {
      throw new RateLimitError(`Rate limit exceeded: ${SEND_LIMIT} send operations per hour allowed.`);
    }
    recordRequest(bucket);
  } else if (action === 'swap') {
    const bucket = `swap:${ip}:${telegramId}`;
    const win    = getWindow(bucket, HOUR_MS);
    if (win.length >= SWAP_LIMIT) {
      throw new RateLimitError(`Rate limit exceeded: ${SWAP_LIMIT} swap operations per hour allowed.`);
    }
    recordRequest(bucket);
  } else if (action === 'adminSweep') {
    const bucket = `adminSweep:${ip}`;
    const win    = getWindow(bucket, HOUR_MS);
    if (win.length >= ADMIN_SWEEP_LIMIT) {
      throw new RateLimitError(`Rate limit exceeded: ${ADMIN_SWEEP_LIMIT} sweep operations per hour allowed.`);
    }
    recordRequest(bucket);
  }

  // 5. Record general request
  recordRequest(ipBucket);
  recordRequest(generalBucket);
}

// ---------------------------------------------------------------------------
// Fastify preHandler middleware (general 30/min check, no telegramId required)
// ---------------------------------------------------------------------------

export async function rateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ip = (
    (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? request.ip
  );
  try {
    await checkRateLimit(ip, '');
  } catch (err) {
    if (err instanceof Error && (err as { statusCode?: number }).statusCode === 429) {
      reply.status(429).send({ statusCode: 429, error: 'Too Many Requests', message: err.message });
      return;
    }
    throw err;
  }
}
