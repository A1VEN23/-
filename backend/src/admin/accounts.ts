/**
 * gem-twa — Admin: Accounts
 *
 * Account management for the admin panel:
 *  - getAllAccounts()     — list all accounts with aggregated wallet balances
 *  - updateAccount()     — patch nickname / channelName / notes
 *  - getAdminStats()     — dashboard KPIs
 *  - exportAccountsCSV() — UTF-8 BOM CSV download
 */

import { prisma } from '../db';
import { COIN_IDS } from '../proxy/prices';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminAccount {
  id: string;
  telegramId: string;
  username: string | null;
  nickname: string | null;
  channelName: string | null;
  notes: string | null;
  balanceUsd: number;
  walletCount: number;
  lastActive: Date;
  createdAt: Date;
}

export interface AdminStats {
  totalUsd: number;
  todayIncoming: number;
  activeWallets: number;
  txErrors: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fetch USD prices for a list of CoinGecko IDs. Returns 0 on failure. */
async function fetchUsdPrices(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return {};
    const data = await res.json() as Record<string, { usd?: number }>;
    return Object.fromEntries(
      Object.entries(data).map(([id, v]) => [id, v?.usd ?? 0]),
    );
  } catch {
    return {};
  }
}

/** Parse a decimal-string amount safely. */
function parseAmount(amount: string): number {
  const n = parseFloat(amount);
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// getAllAccounts
// ---------------------------------------------------------------------------

/**
 * Returns every Account joined with its wallet balances (in USD).
 * Balance is computed as the sum of on-chain amounts × current USD price.
 * Falls back to 0 when price data is unavailable.
 */
export async function getAllAccounts(): Promise<AdminAccount[]> {
  // 1. Fetch all accounts and their wallets in one query
  const accounts = await prisma.account.findMany({
    orderBy: { lastActive: 'desc' },
  });

  const wallets = await prisma.wallet.findMany({
    select: {
      telegramId: true,
      chain: true,
      transactions: {
        where:  { status: 'confirmed' },
        select: { amount: true, type: true },
      },
    },
  });

  // 2. Resolve prices for all unique chains
  const chains  = [...new Set(wallets.map((w) => w.chain))];
  const cgIds   = [...new Set(chains.map((c) => COIN_IDS[c]).filter(Boolean))];
  const prices  = await fetchUsdPrices(cgIds);

  // 3. Compute per-telegramId balance and wallet count
  const balanceMap = new Map<string, number>();
  const countMap   = new Map<string, number>();

  for (const wallet of wallets) {
    const cgId     = COIN_IDS[wallet.chain];
    const priceUsd = cgId ? (prices[cgId] ?? 0) : 0;

    // Sum confirmed incoming minus confirmed outgoing
    let net = 0;
    for (const tx of wallet.transactions) {
      const amt = parseAmount(tx.amount);
      net += tx.type === 'receive' ? amt : -amt;
    }
    if (net < 0) net = 0;

    balanceMap.set(
      wallet.telegramId,
      (balanceMap.get(wallet.telegramId) ?? 0) + net * priceUsd,
    );
    countMap.set(
      wallet.telegramId,
      (countMap.get(wallet.telegramId) ?? 0) + 1,
    );
  }

  // 4. Map to AdminAccount
  return accounts.map((acc) => ({
    id:          acc.id,
    telegramId:  acc.telegramId,
    username:    acc.username,
    nickname:    acc.nickname,
    channelName: acc.channelName,
    notes:       acc.notes,
    balanceUsd:  Math.round((balanceMap.get(acc.telegramId) ?? 0) * 100) / 100,
    walletCount: countMap.get(acc.telegramId) ?? 0,
    lastActive:  acc.lastActive,
    createdAt:   acc.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// updateAccount
// ---------------------------------------------------------------------------

export async function updateAccount(
  id: string,
  data: { nickname?: string; channelName?: string; notes?: string },
): Promise<void> {
  await prisma.account.update({
    where: { id },
    data,
  });
}

// ---------------------------------------------------------------------------
// getAdminStats
// ---------------------------------------------------------------------------

export async function getAdminStats(): Promise<AdminStats> {
  const now       = new Date();
  const dayStart  = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  // Parallel queries
  const [wallets, todayTxs, txErrors] = await Promise.all([
    prisma.wallet.findMany({
      select: {
        chain: true,
        transactions: {
          where:  { status: 'confirmed' },
          select: { amount: true, type: true },
        },
      },
    }),
    prisma.transaction.findMany({
      where: {
        type:      'receive',
        status:    'confirmed',
        createdAt: { gte: dayStart },
      },
      include: { wallet: { select: { chain: true } } },
    }),
    prisma.txError.count(),
  ]);

  // Build price map for all chains
  const chains  = [...new Set(wallets.map((w) => w.chain))];
  const cgIds   = [...new Set(chains.map((c) => COIN_IDS[c]).filter(Boolean))];
  const prices  = await fetchUsdPrices(cgIds);

  // Total USD across all wallets
  let totalUsd = 0;
  let activeWallets = 0;

  for (const wallet of wallets) {
    const cgId     = COIN_IDS[wallet.chain];
    const priceUsd = cgId ? (prices[cgId] ?? 0) : 0;

    let net = 0;
    for (const tx of wallet.transactions) {
      const amt = parseAmount(tx.amount);
      net += tx.type === 'receive' ? amt : -amt;
    }
    if (net > 0) {
      totalUsd += net * priceUsd;
      activeWallets++;
    }
  }

  // Today's incoming in USD
  let todayIncoming = 0;
  for (const tx of todayTxs) {
    const chain    = (tx as typeof tx & { wallet: { chain: string } }).wallet.chain;
    const cgId     = COIN_IDS[chain];
    const priceUsd = cgId ? (prices[cgId] ?? 0) : 0;
    todayIncoming += parseAmount(tx.amount) * priceUsd;
  }

  return {
    totalUsd:      Math.round(totalUsd      * 100) / 100,
    todayIncoming: Math.round(todayIncoming * 100) / 100,
    activeWallets,
    txErrors,
  };
}

// ---------------------------------------------------------------------------
// exportAccountsCSV
// ---------------------------------------------------------------------------

/**
 * Exports all accounts as a UTF-8 BOM CSV string.
 * Columns: ID, Nickname, Channel, Notes, Username, Balance USD, Last Active, Created
 */
export async function exportAccountsCSV(): Promise<string> {
  const accounts = await getAllAccounts();

  const BOM     = '\uFEFF';
  const headers = [
    'ID',
    'Nickname',
    'Channel',
    'Notes',
    'Username',
    'Balance USD',
    'Last Active',
    'Created',
  ].join(',');

  /** Wrap a value in quotes and escape inner quotes. */
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '""';
    const str = String(v).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = accounts.map((acc) =>
    [
      cell(acc.id),
      cell(acc.nickname),
      cell(acc.channelName),
      cell(acc.notes),
      cell(acc.username),
      cell(acc.balanceUsd.toFixed(2)),
      cell(acc.lastActive.toISOString()),
      cell(acc.createdAt.toISOString()),
    ].join(','),
  );

  return BOM + [headers, ...rows].join('\r\n');
}
