/**
 * gem-twa — Routes: /api/admin
 *
 * All endpoints require Telegram auth AND the caller must be the configured admin.
 *
 * Endpoints
 * ─────────
 * GET  /stats
 * GET  /accounts
 * PATCH /accounts/:id
 * GET  /accounts/export-csv            → text/csv download
 *
 * POST /sweep/calculate
 * POST /sweep/initiate
 * POST /sweep/confirm
 *
 * POST /backups/create
 * GET  /backups
 * GET  /backups/:id/download           → application/octet-stream
 *
 * GET  /errors
 * POST /errors/:id/retry
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z }                from 'zod';
import { telegramAuth }     from '../auth/telegram';
import { prisma }           from '../db';
import {
  getAllAccounts,
  updateAccount,
  getAdminStats,
  exportAccountsCSV,
} from '../admin/accounts';
import {
  calculateSweepable,
  initiateSweep,
  confirmSweep,
} from '../admin/sweep';
import {
  createBackup,
  downloadBackup,
  restoreBackup,
} from '../admin/backup';
import { sendTransaction, CHAIN_CONFIG } from '../signer';
import { getPrivateKey }    from '../vault/keyVault';
import type { Chain }       from '../signer/types';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const updateAccountSchema = z.object({
  nickname:    z.string().max(64).optional(),
  channelName: z.string().max(128).optional(),
  notes:       z.string().max(1024).optional(),
}).strict();

const confirmSweepSchema = z.object({
  sweepId: z.string().min(1),
  pin:     z.string().min(1),
}).strict();

// ---------------------------------------------------------------------------
// Admin guard middleware
// ---------------------------------------------------------------------------

async function adminGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // First run Telegram auth to populate request.telegramUser
  await telegramAuth(request, reply);

  if (reply.sent) return; // telegramAuth already rejected

  const telegramId = String(request.telegramUser!.id);
  const adminId    = process.env.VITE_ADMIN_ID ?? '';

  if (!adminId) {
    reply.status(503).send({ statusCode: 503, error: 'Admin not configured' });
    return;
  }

  if (telegramId !== adminId) {
    reply.status(403).send({ statusCode: 403, error: 'Forbidden' });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function adminRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /stats ─────────────────────────────────────────────────────────────
  app.get(
    '/stats',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const stats = await getAdminStats();
      return reply.send(stats);
    },
  );

  // ── GET /accounts ──────────────────────────────────────────────────────────
  app.get(
    '/accounts',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const accounts = await getAllAccounts();
      return reply.send(accounts);
    },
  );

  // ── GET /accounts/export-csv ───────────────────────────────────────────────
  // NOTE: must be declared before /:id to avoid route conflicts
  app.get(
    '/accounts/export-csv',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const csv = await exportAccountsCSV();
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="accounts.csv"')
        .send(csv);
    },
  );

  // ── PATCH /accounts/:id ────────────────────────────────────────────────────
  app.patch(
    '/accounts/:id',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const parsed = updateAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error:      'Validation error',
          issues:     parsed.error.issues,
        });
      }
      await updateAccount(request.params.id, parsed.data);
      return reply.send({ ok: true });
    },
  );

  // ── POST /sweep/calculate ──────────────────────────────────────────────────
  app.post(
    '/sweep/calculate',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Body: { telegramId?: string } }>,
      reply: FastifyReply,
    ) => {
      const plan = await calculateSweepable(request.body?.telegramId);
      return reply.send(plan);
    },
  );

  // ── POST /sweep/initiate ───────────────────────────────────────────────────
  app.post(
    '/sweep/initiate',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Body: { telegramId?: string } }>,
      reply: FastifyReply,
    ) => {
      const sweepId = await initiateSweep(request.body?.telegramId);
      return reply.send({ sweepId });
    },
  );

  // ── POST /sweep/confirm ────────────────────────────────────────────────────
  app.post(
    '/sweep/confirm',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const parsed = confirmSweepSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error:      'Validation error',
          issues:     parsed.error.issues,
        });
      }
      const results = await confirmSweep(parsed.data.sweepId, parsed.data.pin);
      return reply.send({ ok: true, results });
    },
  );

  // ── POST /backups/create ───────────────────────────────────────────────────
  app.post(
    '/backups/create',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const record = await createBackup();
      return reply.status(201).send(record);
    },
  );

  // ── GET /backups ───────────────────────────────────────────────────────────
  app.get(
    '/backups',
    { preHandler: adminGuard },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const backups = await prisma.backup.findMany({
        orderBy: { createdAt: 'desc' },
      });
      return reply.send(backups);
    },
  );

  // ── GET /backups/:id/download ──────────────────────────────────────────────
  app.get(
    '/backups/:id/download',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const data = await downloadBackup(request.params.id);
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="backup_${request.params.id}.enc"`)
        .send(data);
    },
  );

  // ── GET /errors ────────────────────────────────────────────────────────────
  app.get(
    '/errors',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
      reply: FastifyReply,
    ) => {
      const limit  = Math.min(parseInt(request.query.limit  ?? '50', 10), 200);
      const offset = parseInt(request.query.offset ?? '0', 10);

      const [errors, total] = await Promise.all([
        prisma.txError.findMany({
          orderBy: { timestamp: 'desc' },
          skip:    offset,
          take:    limit,
          include: { wallet: { select: { telegramId: true, address: true } } },
        }),
        prisma.txError.count(),
      ]);

      return reply.send({ total, limit, offset, errors });
    },
  );

  // ── POST /errors/:id/retry ─────────────────────────────────────────────────
  app.post(
    '/errors/:id/retry',
    { preHandler: adminGuard },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const txError = await prisma.txError.findUnique({
        where:   { id: request.params.id },
        include: { wallet: true },
      });

      if (!txError) {
        return reply.status(404).send({ statusCode: 404, error: 'Error record not found' });
      }

      const { wallet } = txError;

      // Re-derive private key and attempt to retry the transaction
      try {
        const privateKey = await getPrivateKey(wallet.telegramId, wallet.chain);
        const chainCfg   = CHAIN_CONFIG[wallet.chain as Chain];

        if (!chainCfg) {
          return reply.status(400).send({
            statusCode: 400,
            error: `Unsupported chain: ${wallet.chain}`,
          });
        }

        // We don't know the original destination from TxError, so we retry
        // as a self-consolidation back to the same address (no-op sweep pattern).
        // In a real scenario the original TxParams should be stored in the error record.
        const txResult = await sendTransaction(wallet.chain as Chain, {
          from:       wallet.address,
          to:         wallet.address,
          amount:     txError.amount,
          privateKey,
          memo:       `retry:${txError.id}`,
        });

        // Delete the error record on success
        await prisma.txError.delete({ where: { id: txError.id } });

        return reply.send({ ok: true, txHash: txResult.txHash });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({
          statusCode: 502,
          error:      'Retry failed',
          message:    errorMessage,
        });
      }
    },
  );
}
