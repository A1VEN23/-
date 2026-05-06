/**
 * gem-twa — Bot Notifications
 *
 * All user-facing and admin-facing Telegram notifications.
 * Uses sendMessage from ./client with HTML parse mode.
 */

import { sendMessage, type InlineKeyboardMarkup } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepPlanEntry {
  /** Wallet address */
  address: string;
  /** Human-readable chain name */
  chain: string;
  /** Native asset symbol */
  asset: string;
  /** Amount to sweep (decimal string) */
  amount: string;
  /** Estimated gas/fee (decimal string) */
  estimatedFee: string;
}

export interface SweepResultEntry {
  address: string;
  chain: string;
  asset: string;
  amount: string;
  /** 'ok' | 'failed' | 'skipped' */
  status: 'ok' | 'failed' | 'skipped';
  txHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Emoji helpers
// ---------------------------------------------------------------------------

const EMOJI = {
  received:  '💎',
  sent:      '📤',
  admin:     '🔔',
  sweep:     '🧹',
  ok:        '✅',
  fail:      '❌',
  skip:      '⏭',
  fee:       '⛽',
  link:      '🔗',
  wallet:    '👛',
  chain:     '🔗',
} as const;

// ---------------------------------------------------------------------------
// Helper: truncate long hash/address for display
// ---------------------------------------------------------------------------

function short(str: string, head = 6, tail = 4): string {
  if (str.length <= head + tail + 2) return str;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// User notifications
// ---------------------------------------------------------------------------

/**
 * Notify user that funds have arrived in their deposit address.
 */
export async function notifyUserReceived(
  telegramId: number | string,
  amount: string,
  asset: string,
  chain: string,
  txHash: string,
): Promise<void> {
  const text =
    `${EMOJI.received} <b>Получено пополнение</b>\n\n` +
    `Сумма: <b>${amount} ${asset}</b>\n` +
    `Сеть: <b>${chain}</b>\n` +
    `TX: <code>${txHash}</code>`;

  await sendMessage(telegramId, text);
}

/**
 * Notify user that their outbound transaction was broadcast.
 */
export async function notifyUserSent(
  telegramId: number | string,
  amount: string,
  asset: string,
  toAddress: string,
  fee: string,
  coin: string,
): Promise<void> {
  const text =
    `${EMOJI.sent} <b>Отправлено</b>\n\n` +
    `Сумма: <b>${amount} ${asset}</b>\n` +
    `Кому: <code>${toAddress}</code>\n` +
    `${EMOJI.fee} Комиссия: <b>${fee} ${coin}</b>`;

  await sendMessage(telegramId, text);
}

// ---------------------------------------------------------------------------
// Admin notifications
// ---------------------------------------------------------------------------

/**
 * Notify admin when a deposit is received to any monitored channel wallet.
 */
export async function notifyAdminReceived(
  adminId: number | string,
  channelName: string,
  notes: string,
  amount: string,
  asset: string,
  txLink: string,
): Promise<void> {
  const text =
    `${EMOJI.admin} <b>Новый депозит</b>\n\n` +
    `Канал: <b>${channelName}</b>\n` +
    (notes ? `Заметки: ${notes}\n` : '') +
    `Сумма: <b>${amount} ${asset}</b>\n` +
    `${EMOJI.link} <a href="${txLink}">Просмотр транзакции</a>`;

  await sendMessage(adminId, text, { disable_web_page_preview: true });
}

/**
 * Notify admin about a pending sweep with full plan details.
 * Includes Confirm / Cancel inline keyboard.
 */
export async function notifyAdminSweepRequest(
  adminId: number | string,
  sweepPlan: SweepPlanEntry[],
  sweepId: string,
): Promise<void> {
  // Build plan summary lines
  const planLines = sweepPlan
    .map(
      (entry, idx) =>
        `${idx + 1}. <code>${short(entry.address)}</code> — ` +
        `<b>${entry.amount} ${entry.asset}</b> (${entry.chain})\n` +
        `   ${EMOJI.fee} Комиссия ≈ ${entry.estimatedFee} ${entry.asset}`,
    )
    .join('\n');

  const total = sweepPlan.reduce(
    (acc, e) => acc + parseFloat(e.amount),
    0,
  );
  const totalAsset = sweepPlan[0]?.asset ?? '';

  const text =
    `${EMOJI.sweep} <b>Запрос на свип</b> <code>#${sweepId}</code>\n\n` +
    `<b>Кошельки для свипа (${sweepPlan.length}):</b>\n` +
    planLines +
    `\n\n<b>Итого:</b> ~${total.toFixed(6)} ${totalAsset}\n\n` +
    `Подтвердить выполнение свипа?`;

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: '✅ Подтвердить',
          callback_data: `sweep_confirm_${sweepId}`,
        },
        {
          text: '❌ Отмена',
          callback_data: `sweep_cancel_${sweepId}`,
        },
      ],
    ],
  };

  await sendMessage(adminId, text, {
    reply_markup: keyboard,
    disable_web_page_preview: true,
  });
}

/**
 * Notify admin with the results of a completed sweep operation.
 */
export async function notifyAdminSweepResult(
  adminId: number | string,
  results: SweepResultEntry[],
): Promise<void> {
  const statusEmoji = (status: SweepResultEntry['status']) => {
    if (status === 'ok')      return EMOJI.ok;
    if (status === 'failed')  return EMOJI.fail;
    return EMOJI.skip;
  };

  const lines = results.map((r) => {
    const base =
      `${statusEmoji(r.status)} <code>${short(r.address)}</code> ` +
      `${r.amount} ${r.asset} (${r.chain})`;

    if (r.status === 'ok' && r.txHash) {
      return `${base}\n   TX: <code>${r.txHash}</code>`;
    }
    if (r.status === 'failed' && r.error) {
      return `${base}\n   Ошибка: ${r.error}`;
    }
    return base;
  });

  const ok      = results.filter((r) => r.status === 'ok').length;
  const failed  = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  const text =
    `${EMOJI.sweep} <b>Результаты свипа</b>\n\n` +
    lines.join('\n') +
    `\n\n` +
    `${EMOJI.ok} Успешно: ${ok}  ` +
    `${EMOJI.fail} Ошибок: ${failed}  ` +
    `${EMOJI.skip} Пропущено: ${skipped}`;

  await sendMessage(adminId, text, { disable_web_page_preview: true });
}
