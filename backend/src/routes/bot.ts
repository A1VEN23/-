/**
 * gem-twa — Telegram Bot Webhook route
 *
 * Prefix: /api/bot  (registered in index.ts)
 *
 * Endpoints
 * ─────────
 * POST /webhook   — Receive updates from Telegram (verified by secret token)
 *
 * Security:
 *   Every incoming request must carry the header
 *   X-Telegram-Bot-Api-Secret-Token === process.env.TELEGRAM_BOT_SECRET
 *   Requests that fail this check receive 401 and are not processed.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sendMessage, answerCallbackQuery }                    from '../bot/client';
import { prisma }                                              from '../db';

// ---------------------------------------------------------------------------
// Telegram update shape (minimal — only what we use)
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOT_SECRET   = process.env.TELEGRAM_BOT_SECRET ?? '';
const FRONTEND_URL = process.env.VITE_FRONTEND_URL   ?? 'https://t.me/your_bot/app';

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStart(message: TelegramMessage): Promise<void> {
  const name = message.from?.first_name ?? 'пользователь';
  const text =
    `👋 Добро пожаловать, <b>${name}</b>!\n\n` +
    `Я — Gem Wallet, ваш защищённый криптокошелёк прямо в Telegram.\n\n` +
    `Нажмите кнопку ниже, чтобы открыть приложение:`;

  await sendMessage(message.chat.id, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '💎 Открыть Gem Wallet',
            web_app: { url: FRONTEND_URL },
          },
        ],
      ],
    },
  });
}

async function handleHelp(message: TelegramMessage): Promise<void> {
  const text =
    `ℹ️ <b>Доступные команды</b>\n\n` +
    `/start — Запустить бота и открыть кошелёк\n` +
    `/help — Показать эту справку\n` +
    `/balance — Показать суммарный баланс\n\n` +
    `Для полного управления активами используйте веб-приложение.`;

  await sendMessage(message.chat.id, text);
}

async function handleBalance(message: TelegramMessage): Promise<void> {
  if (!message.from) {
    await sendMessage(message.chat.id, '❌ Не удалось определить пользователя.');
    return;
  }

  try {
    // Look up the user's wallets in the DB
    const user = await prisma.user.findUnique({
      where:   { telegramId: BigInt(message.from.id) },
      include: { wallets: true },
    });

    if (!user || user.wallets.length === 0) {
      await sendMessage(
        message.chat.id,
        '👛 У вас пока нет кошельков. Откройте приложение, чтобы создать первый.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💎 Открыть Gem Wallet', web_app: { url: FRONTEND_URL } }],
            ],
          },
        },
      );
      return;
    }

    const walletCount = user.wallets.length;
    const chains = [...new Set(user.wallets.map((w) => w.chain))].join(', ');

    const text =
      `👛 <b>Ваши кошельки</b>\n\n` +
      `Всего кошельков: <b>${walletCount}</b>\n` +
      `Сети: <b>${chains}</b>\n\n` +
      `Для просмотра актуальных балансов откройте приложение:`;

    await sendMessage(message.chat.id, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 Открыть Gem Wallet', web_app: { url: FRONTEND_URL } }],
        ],
      },
    });
  } catch {
    await sendMessage(
      message.chat.id,
      '⚠️ Не удалось получить баланс. Попробуйте позже.',
    );
  }
}

// ---------------------------------------------------------------------------
// Callback query handlers
// ---------------------------------------------------------------------------

async function handleSweepConfirm(
  query: TelegramCallbackQuery,
  sweepId: string,
): Promise<void> {
  try {
    // Import confirmSweep lazily to avoid circular deps; the function is
    // expected to exist in admin/sweep.ts (created in a later step).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { confirmSweep } = require('../admin/sweep') as {
      confirmSweep: (id: string, adminId: number) => Promise<void>;
    };
    await confirmSweep(sweepId, query.from.id);
    await answerCallbackQuery(query.id, '✅ Свип подтверждён');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
    await answerCallbackQuery(query.id, `❌ Ошибка: ${msg}`);
  }
}

async function handleSweepCancel(
  query: TelegramCallbackQuery,
  sweepId: string,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cancelSweep } = require('../admin/sweep') as {
      cancelSweep: (id: string) => Promise<void>;
    };
    await cancelSweep(sweepId);
    await answerCallbackQuery(query.id, '🚫 Свип отменён');

    if (query.message) {
      await sendMessage(
        query.message.chat.id,
        `🚫 Свип <code>#${sweepId}</code> отменён администратором.`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
    await answerCallbackQuery(query.id, `❌ Ошибка: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

export default async function botRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /webhook
   * Telegram sends all updates here.
   */
  app.post(
    '/webhook',
    {
      config: {
        // Higher limit than global to allow bursts from Telegram
        rateLimit: { max: 100, timeWindow: '1 minute' },
      },
    },
    async (
      request: FastifyRequest<{ Body: TelegramUpdate }>,
      reply: FastifyReply,
    ) => {
      // ── Security: verify secret token ─────────────────────────────────────
      const incomingSecret = request.headers['x-telegram-bot-api-secret-token'];

      if (!BOT_SECRET || incomingSecret !== BOT_SECRET) {
        return reply.status(401).send({ ok: false, error: 'Unauthorized' });
      }

      const update = request.body;

      // Acknowledge Telegram immediately — all processing is fire-and-forget
      reply.status(200).send({ ok: true });

      // ── Message handler ──────────────────────────────────────────────────
      if (update.message) {
        const { text } = update.message;
        if (!text) return;

        const command = text.split(' ')[0]?.toLowerCase();

        try {
          if (command === '/start') {
            await handleStart(update.message);
          } else if (command === '/help') {
            await handleHelp(update.message);
          } else if (command === '/balance') {
            await handleBalance(update.message);
          }
          // Unknown commands are silently ignored
        } catch (err) {
          app.log.error({ err }, '[bot] Error handling message command');
        }
      }

      // ── Callback query handler ───────────────────────────────────────────
      if (update.callback_query) {
        const query = update.callback_query;
        const data  = query.data ?? '';

        try {
          if (data.startsWith('sweep_confirm_')) {
            const sweepId = data.replace('sweep_confirm_', '');
            await handleSweepConfirm(query, sweepId);
          } else if (data.startsWith('sweep_cancel_')) {
            const sweepId = data.replace('sweep_cancel_', '');
            await handleSweepCancel(query, sweepId);
          } else {
            // Unknown callback — dismiss silently
            await answerCallbackQuery(query.id);
          }
        } catch (err) {
          app.log.error({ err }, '[bot] Error handling callback query');
          try {
            await answerCallbackQuery(query.id, '⚠️ Произошла ошибка');
          } catch {
            // Best-effort — ignore secondary failures
          }
        }
      }
    },
  );
}
