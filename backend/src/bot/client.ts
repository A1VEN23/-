/**
 * gem-twa — Telegram Bot API client
 *
 * Pure HTTP client using fetch only — no third-party SDK.
 * All methods throw on non-OK responses; callers should catch.
 */

const BASE_URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${BASE_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as TelegramResponse<T>;

  if (!json.ok) {
    throw new Error(
      `Telegram API error [${method}]: ${json.error_code ?? response.status} — ${json.description ?? 'unknown error'}`,
    );
  }

  return json.result as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendMessageOptions {
  /** HTML or Markdown parse mode */
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  /** Inline keyboard markup */
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;
  /** Disable link previews */
  disable_web_page_preview?: boolean;
  /** Send silently (no notification sound) */
  disable_notification?: boolean;
  /** Reply to a specific message */
  reply_to_message_id?: number;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export interface ReplyKeyboardMarkup {
  keyboard: KeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
}

export interface KeyboardButton {
  text: string;
  web_app?: { url: string };
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

export interface Message {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

/**
 * Send a text message to a chat.
 * Defaults to HTML parse mode for rich formatting.
 */
export async function sendMessage(
  chatId: number | string,
  text: string,
  options: SendMessageOptions = {},
): Promise<Message> {
  return call<Message>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

/**
 * Register a webhook URL with Telegram.
 * Pass TELEGRAM_BOT_SECRET as the secret token so we can verify incoming requests.
 */
export async function setWebhook(url: string): Promise<boolean> {
  return call<boolean>('setWebhook', {
    url,
    secret_token: process.env.TELEGRAM_BOT_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

/**
 * Remove the currently registered webhook (switches back to long-polling mode).
 */
export async function deleteWebhook(): Promise<boolean> {
  return call<boolean>('deleteWebhook', { drop_pending_updates: false });
}

/**
 * Acknowledge a callback query (dismisses the "loading" spinner on the button).
 * Optionally show a toast notification to the user.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  return call<boolean>('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: false } : {}),
  });
}
