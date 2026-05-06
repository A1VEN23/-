/**
 * gem-twa — Fastify server entry point (final hardened version)
 *
 * Security hardening:
 *  - Full CSP via Helmet
 *  - Custom sliding-window rate limits per endpoint
 *  - 404 / global error handlers (no stack in production)
 *  - Graceful shutdown with stopScheduler()
 *  - Startup env-var validation (fail-fast)
 */

import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors   from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';

// ---------------------------------------------------------------------------
// Startup: fail fast on missing required env vars
// ---------------------------------------------------------------------------

['DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'MASTER_SECRET', 'ADMIN_PIN'].forEach(key => {
  if (!process.env[key]) {
    console.error('FATAL: Missing ' + key);
    process.exit(1);
  }
});

const IS_PRODUCTION  = process.env.NODE_ENV === 'production';
const FRONTEND_URL   = process.env.VITE_FRONTEND_URL ?? 'http://localhost:5173';

// ---------------------------------------------------------------------------
// Scheduler (optional — guard against missing module)
// ---------------------------------------------------------------------------

let stopScheduler: (() => void) | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./admin/scheduler') as { stopScheduler?: () => void };
  stopScheduler = mod.stopScheduler;
} catch {
  // scheduler not yet available — skip
}

// ---------------------------------------------------------------------------
// Fastify instance
// ---------------------------------------------------------------------------

const app: FastifyInstance = Fastify({
  logger: {
    level: IS_PRODUCTION ? 'info' : 'debug',
  },
  trustProxy: true,
});

// ---------------------------------------------------------------------------
// Helmet — full Content Security Policy
// ---------------------------------------------------------------------------

await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      connectSrc:  [
        "'self'",
        FRONTEND_URL,
        'https://api.coingecko.com',
        'https://api.1inch.dev',
      ],
      frameSrc:    ["'none'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'https:'],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      formAction:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

await app.register(fastifyCors, {
  origin:         FRONTEND_URL,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    true,
});

// ---------------------------------------------------------------------------
// Global rate limit: 30 requests / minute per IP
// ---------------------------------------------------------------------------

await app.register(fastifyRateLimit, {
  global:     true,
  max:        30,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) =>
    (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? request.ip,
  errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) => ({
    statusCode: 429,
    error:      'Too Many Requests',
    message:    `Rate limit exceeded. Try again in ${context.after}.`,
  }),
});

// ---------------------------------------------------------------------------
// Health endpoint (public)
// ---------------------------------------------------------------------------

app.get('/health', async (_request: FastifyRequest, _reply: FastifyReply) => ({
  ok:        true,
  timestamp: new Date().toISOString(),
}));

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

const routePlugins: Array<{ path: string; module: string }> = [
  { path: '/api/wallet',  module: './routes/wallet'  },
  { path: '/api/swap',    module: './routes/swap'    },
  { path: '/api/admin',   module: './routes/admin'   },
  { path: '/api/account', module: './routes/account' },
  { path: '/api/bot',     module: './routes/bot'     },
];

for (const { path, module: mod } of routePlugins) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plugin = require(mod) as { default: Parameters<typeof app.register>[0] };
    await app.register(plugin.default, { prefix: path });
  } catch (err) {
    app.log.warn(`[startup] Route plugin not found: ${mod} — ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Custom per-route rate limits (applied inside route handlers):
//   POST /api/wallet/send      → 5 / hour    (checkRateLimit + config.rateLimit)
//   POST /api/swap/execute     → 5 / hour    (checkRateLimit + config.rateLimit)
//   POST /api/admin/sweep/*    → 10 / hour   (adminGuard + config.rateLimit)
//   POST /api/bot/webhook      → 100 / min   (config.rateLimit)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
  reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found.' });
});

// ---------------------------------------------------------------------------
// Global error handler — no stack traces in production
// ---------------------------------------------------------------------------

app.setErrorHandler(
  (error: Error & { statusCode?: number }, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;

    if (IS_PRODUCTION) {
      reply.status(statusCode).send({
        statusCode,
        error:
          statusCode === 429 ? 'Too Many Requests'
          : statusCode === 401 ? 'Unauthorized'
          : statusCode === 403 ? 'Forbidden'
          : statusCode === 404 ? 'Not Found'
          : statusCode < 500  ? 'Bad Request'
          : 'Internal Server Error',
        message: statusCode < 500 ? error.message : 'An unexpected error occurred.',
      });
    } else {
      reply.status(statusCode).send({
        statusCode,
        error:   error.name,
        message: error.message,
        stack:   error.stack,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Graceful shutdown (10 s hard timeout)
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  app.log.info(`[shutdown] Received ${signal}, shutting down…`);

  const hardKill = setTimeout(() => {
    app.log.error('[shutdown] Graceful shutdown timed out after 10s — forcing exit.');
    process.exit(1);
  }, 10_000);

  try {
    stopScheduler?.();
    await app.close();
    clearTimeout(hardKill);
    app.log.info('[shutdown] Server closed cleanly.');
    process.exit(0);
  } catch (err) {
    clearTimeout(hardKill);
    app.log.error({ err }, '[shutdown] Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT');  });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  await app.listen({ port: 3001, host: '0.0.0.0' });
  app.log.info('[startup] gem-twa backend listening on http://0.0.0.0:3001');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
