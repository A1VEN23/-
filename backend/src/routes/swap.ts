/**
 * gem-twa — Swap routes
 *
 * Prefix: /api/swap  (register in index.ts)
 *
 * All endpoints require Telegram Mini App auth via
 * `Authorization: tma <initData>` header (telegramAuth preHandler).
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────
 * POST /quote      — Get swap quote                (10 req/min)
 * POST /execute    — Execute swap                  (5 req/hour)
 * GET  /tokens/:chain — Token list for chain       (cached 1h, 30 req/min)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z }                  from 'zod';

import { telegramAuth }       from '../auth/telegram';
import { checkRateLimit }     from '../ratelimit';
import { getSwapQuote, executeSwap } from '../swap/router';
import { EVM_CHAIN_IDS, getOneInchTokenList } from '../swap/providers/oneinch';
import { getJupiterTokenList }  from '../swap/providers/jupiter';
import { getSTONfiTokenList }   from '../swap/providers/stonfi';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveIp(request: FastifyRequest): string {
  return (
    (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    request.socket.remoteAddress ??
    'unknown'
  );
}

// ─── Token-list in-memory cache (1 hour TTL) ─────────────────────────────────

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry>();
const TOKEN_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

function getCached(key: string): unknown | null {
  const entry = tokenCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function setCache(key: string, data: unknown): void {
  tokenCache.set(key, { data, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
}

async function fetchTokenList(chain: string): Promise<unknown> {
  const cached = getCached(chain);
  if (cached !== null) return cached;

  let data: unknown;

  if (EVM_CHAIN_IDS[chain]) {
    data = await getOneInchTokenList(chain);
  } else if (chain === 'solana') {
    data = await getJupiterTokenList();
  } else if (chain === 'ton') {
    data = await getSTONfiTokenList();
  } else {
    throw new Error(`No token list available for chain: "${chain}"`);
  }

  setCache(chain, data);
  return data;
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const QuoteSchema = z.object({
  chain:     z.string().min(1),
  fromToken: z.string().min(1),
  toToken:   z.string().min(1),
  amount:    z.string().regex(/^\d+$/, 'amount must be a positive integer string'),
  slippage:  z.number().min(0.01).max(50).optional(),
});

const ExecuteSchema = z.object({
  chain:     z.string().min(1),
  fromToken: z.string().min(1),
  toToken:   z.string().min(1),
  amount:    z.string().regex(/^\d+$/, 'amount must be a positive integer string'),
  slippage:  z.number().min(0.01).max(50),
});

// ─── Route plugin ─────────────────────────────────────────────────────────────

export default async function swapRoutes(app: FastifyInstance): Promise<void> {
  // All routes require Telegram auth
  app.addHook('preHandler', telegramAuth);

  // ───────────────────────────────────────────────────────────────────────────
  // POST /quote
  // ───────────────────────────────────────────────────────────────────────────
  app.post('/quote', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    // 10 requests per minute (general limit)
    await checkRateLimit(resolveIp(request), telegramId);

    const parseResult = QuoteSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const { chain, fromToken, toToken, amount, slippage } = parseResult.data;

    const quote = await getSwapQuote(chain, fromToken, toToken, amount, slippage);

    return reply.send({
      ok: true,
      quote,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // POST /execute
  // ───────────────────────────────────────────────────────────────────────────
  app.post('/execute', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    // 5 requests per hour (swap action limit)
    await checkRateLimit(resolveIp(request), telegramId, 'swap');

    const parseResult = ExecuteSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const { chain, fromToken, toToken, amount, slippage } = parseResult.data;

    const result = await executeSwap(chain, telegramId, fromToken, toToken, amount, slippage);

    return reply.send({
      ok: true,
      result,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /tokens/:chain
  // ───────────────────────────────────────────────────────────────────────────
  app.get(
    '/tokens/:chain',
    async (request: FastifyRequest<{ Params: { chain: string } }>, reply: FastifyReply) => {
      const telegramId = String(request.telegramUser!.id);
      await checkRateLimit(resolveIp(request), telegramId);

      const { chain } = request.params;

      const tokens = await fetchTokenList(chain);

      // Set cache-control header so CDN / clients can also cache
      void reply.header('Cache-Control', 'public, max-age=3600');

      return reply.send({
        ok: true,
        chain,
        tokens,
      });
    },
  );
}
