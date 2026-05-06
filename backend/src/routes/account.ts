/**
 * gem-twa — Routes: /api/account
 *
 * All routes are protected by Telegram Mini App auth (telegramAuth preHandler).
 *
 *  GET  /me          → fetch or upsert Account record from the DB
 *  PATCH /settings   → update language, displayCurrency, notificationsEnabled
 *  PATCH /notifications → shorthand toggle for notificationsEnabled
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z }                  from 'zod';
import { telegramAuth }       from '../auth/telegram';
import { prisma }             from '../db';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  language:             z.string().min(2).max(10).optional(),
  displayCurrency:      z.string().min(3).max(5).optional(),
  notificationsEnabled: z.boolean().optional(),
}).strict();

const notificationsSchema = z.object({
  enabled: z.boolean(),
}).strict();

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  // Apply telegramAuth to ALL routes in this plugin (defence-in-depth;
  // individual routes also declare preHandler for clarity)
  app.addHook('preHandler', telegramAuth);

  // ── GET /me ────────────────────────────────────────────────────────────────
  app.get(
    '/me',
    { preHandler: telegramAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tgUser = request.telegramUser!;

      const account = await prisma.account.upsert({
        where:  { telegramId: String(tgUser.id) },
        update: {
          username: tgUser.username ?? undefined,
        },
        create: {
          telegramId: String(tgUser.id),
          username:   tgUser.username,
          language:   tgUser.language_code ?? 'ru',
        },
      });

      return reply.send({
        id:                   account.id,
        telegramId:           account.telegramId,
        username:             account.username,
        nickname:             account.nickname,
        channelName:          account.channelName,
        notes:                account.notes,
        language:             account.language,
        displayCurrency:      account.displayCurrency,
        notificationsEnabled: account.notificationsEnabled,
        lastActive:           account.lastActive,
        createdAt:            account.createdAt,
      });
    },
  );

  // ── PATCH /settings ────────────────────────────────────────────────────────
  app.patch(
    '/settings',
    { preHandler: telegramAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tgUser = request.telegramUser!;

      // Validate body
      const parseResult = settingsSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error:      'Bad Request',
          message:    parseResult.error.errors.map((e) => e.message).join('; '),
        });
      }

      const { language, displayCurrency, notificationsEnabled } = parseResult.data;

      // Nothing to update?
      if (
        language === undefined &&
        displayCurrency === undefined &&
        notificationsEnabled === undefined
      ) {
        return reply.status(400).send({
          statusCode: 400,
          error:      'Bad Request',
          message:    'At least one setting must be provided.',
        });
      }

      const account = await prisma.account.upsert({
        where:  { telegramId: String(tgUser.id) },
        update: {
          ...(language             !== undefined && { language }),
          ...(displayCurrency      !== undefined && { displayCurrency }),
          ...(notificationsEnabled !== undefined && { notificationsEnabled }),
        },
        create: {
          telegramId:           String(tgUser.id),
          username:             tgUser.username,
          language:             language             ?? tgUser.language_code ?? 'ru',
          displayCurrency:      displayCurrency      ?? 'USD',
          notificationsEnabled: notificationsEnabled ?? true,
        },
      });

      return reply.send({
        id:                   account.id,
        language:             account.language,
        displayCurrency:      account.displayCurrency,
        notificationsEnabled: account.notificationsEnabled,
      });
    },
  );

  // ── PATCH /notifications ───────────────────────────────────────────────────
  app.patch(
    '/notifications',
    { preHandler: telegramAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tgUser = request.telegramUser!;

      const parseResult = notificationsSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error:      'Bad Request',
          message:    parseResult.error.errors.map((e) => e.message).join('; '),
        });
      }

      const { enabled } = parseResult.data;

      const account = await prisma.account.upsert({
        where:  { telegramId: String(tgUser.id) },
        update: { notificationsEnabled: enabled },
        create: {
          telegramId:           String(tgUser.id),
          username:             tgUser.username,
          notificationsEnabled: enabled,
        },
      });

      return reply.send({
        notificationsEnabled: account.notificationsEnabled,
      });
    },
  );
}
