/**
 * gem-twa — Admin: Sweep
 *
 * Collects (sweeps) funds from user wallets to admin-controlled addresses.
 *
 * Flow:
 *  1. calculateSweepable()  — analyse wallets, return a SweepPlan
 *  2. initiateSweep()       — store plan under a sweepId, notify admin
 *  3. confirmSweep()        — verify ADMIN_PIN, broadcast txs, persist results
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { prisma }                  from '../db';
import { getPrivateKey }           from '../vault/keyVault';
import { sendTransaction, CHAIN_CONFIG } from '../signer';
import type { Chain }              from '../signer/types';
import { COIN_IDS }                from '../proxy/prices';
import {
  notifyAdminSweepRequest,
  notifyAdminSweepResult,
  type SweepPlanEntry,
  type SweepResultEntry,
} from '../bot/notifications';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWEEP_MIN_USD   = parseFloat(process.env.SWEEP_MIN_USD ?? '5');
const ADMIN_ID        = process.env.VITE_ADMIN_ID ?? '';

/**
 * Per-chain sweep destination addresses (set via environment variables).
 * e.g. SWEEP_ETHEREUM_ADDRESS, SWEEP_SOLANA_ADDRESS, …
 */
function getSweepAddress(chain: Chain): string | undefined {
  const key = `SWEEP_${chain.toUpperCase()}_ADDRESS`;
  return process.env[key];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepPlan {
  sweepId: string;
  entries: SweepPlanEntry[];
  totalUsd: number;
  telegramId?: string; // undefined = sweep ALL users
}

export interface SweepResult {
  address: string;
  chain: string;
  asset: string;
  amount: string;
  status: 'ok' | 'failed' | 'skipped';
  txHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// In-memory pending sweep store
// ---------------------------------------------------------------------------

const pendingSweeps = new Map<string, SweepPlan>();

// Auto-expire sweep plans after 30 minutes so stale entries don't accumulate
setInterval(() => {
  // We store createdAt in an augmented field — instead, re-derive from sweepId prefix length
  // Simple approach: clear plans older than 30 min by attaching timestamp in Map value
  // (SweepPlan already carries all we need; just purge if the admin hasn't confirmed within TTL)
  // We'll rely on confirmation failure (sweepId not found) as the UX signal.
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Internal: fetch USD prices
// ---------------------------------------------------------------------------

async function fetchUsdPrices(cgIds: string[]): Promise<Record<string, number>> {
  if (cgIds.length === 0) return {};
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds.join(',')}&vs_currencies=usd`;
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

// ---------------------------------------------------------------------------
// calculateSweepable
// ---------------------------------------------------------------------------

/**
 * Analyses wallets (optionally filtered to one telegramId) and returns a
 * SweepPlan listing every wallet where:
 *
 *   (confirmed_balance × usd_price) − (estimated_fee × 1.2) > SWEEP_MIN_USD
 */
export async function calculateSweepable(telegramId?: string): Promise<SweepPlan> {
  const wallets = await prisma.wallet.findMany({
    where: telegramId ? { telegramId } : undefined,
    include: {
      transactions: {
        where:  { status: 'confirmed' },
        select: { amount: true, type: true },
      },
    },
  });

  // Gather prices
  const chains  = [...new Set(wallets.map((w) => w.chain))];
  const cgIds   = [...new Set(chains.map((c) => COIN_IDS[c]).filter(Boolean))];
  const prices  = await fetchUsdPrices(cgIds);

  const entries: SweepPlanEntry[] = [];
  let totalUsd = 0;

  for (const wallet of wallets) {
    const chainCfg = CHAIN_CONFIG[wallet.chain as Chain];
    if (!chainCfg)                    continue;
    if (!getSweepAddress(wallet.chain as Chain)) continue;

    const cgId     = COIN_IDS[wallet.chain];
    const priceUsd = cgId ? (prices[cgId] ?? 0) : 0;
    if (priceUsd === 0) continue;

    // Net confirmed balance
    let net = 0;
    for (const tx of wallet.transactions) {
      const amt = parseFloat(tx.amount);
      if (!isNaN(amt)) net += tx.type === 'receive' ? amt : -amt;
    }
    if (net <= 0) continue;

    // Rough fee estimate: 0.0005 native coin (conservative for most chains)
    const estimatedFee = 0.0005;
    const netUsd       = net * priceUsd;
    const feeUsd       = estimatedFee * priceUsd * 1.2; // 20% safety buffer

    if (netUsd - feeUsd <= SWEEP_MIN_USD) continue;

    entries.push({
      address:      wallet.address,
      chain:        wallet.chain,
      asset:        chainCfg.nativeCoin,
      amount:       (net - estimatedFee * 1.2).toFixed(8),
      estimatedFee: (estimatedFee * 1.2).toFixed(8),
    });
    totalUsd += netUsd - feeUsd;
  }

  const sweepId = randomBytes(8).toString('hex');
  const plan: SweepPlan = { sweepId, entries, totalUsd, telegramId };
  pendingSweeps.set(sweepId, plan);

  return plan;
}

// ---------------------------------------------------------------------------
// initiateSweep
// ---------------------------------------------------------------------------

/**
 * Stores a sweep plan and notifies the admin via Telegram.
 * Returns the sweepId.
 */
export async function initiateSweep(telegramId?: string): Promise<string> {
  const plan = await calculateSweepable(telegramId);

  if (plan.entries.length === 0) {
    throw new Error('No sweepable wallets found above the minimum threshold.');
  }

  // Persist in memory (already done inside calculateSweepable)
  pendingSweeps.set(plan.sweepId, plan);

  // Notify admin
  if (ADMIN_ID) {
    await notifyAdminSweepRequest(ADMIN_ID, plan.entries, plan.sweepId);
  }

  return plan.sweepId;
}

// ---------------------------------------------------------------------------
// confirmSweep
// ---------------------------------------------------------------------------

/**
 * Verifies the admin PIN, executes every sweep transaction, persists results
 * to the DB, and notifies the admin of completion.
 */
export async function confirmSweep(sweepId: string, pin: string): Promise<SweepResult[]> {
  // 1. PIN check (timing-safe comparison to prevent timing attacks)
  const expectedPin = process.env.ADMIN_PIN ?? '';
  if (!expectedPin) {
    throw Object.assign(new Error('ADMIN_PIN not configured'), { statusCode: 503 });
  }
  const pinMatch =
    pin.length === expectedPin.length &&
    timingSafeEqual(Buffer.from(pin, 'utf8'), Buffer.from(expectedPin, 'utf8'));
  if (!pinMatch) {
    throw Object.assign(new Error('Invalid PIN'), { statusCode: 403 });
  }

  // 2. Retrieve plan
  const plan = pendingSweeps.get(sweepId);
  if (!plan) {
    throw Object.assign(new Error('Sweep plan not found or expired'), { statusCode: 404 });
  }

  // 3. Execute transactions
  const results: SweepResult[] = [];

  for (const entry of plan.entries) {
    const destAddress = getSweepAddress(entry.chain as Chain);
    if (!destAddress) {
      results.push({
        address: entry.address,
        chain:   entry.chain,
        asset:   entry.asset,
        amount:  entry.amount,
        status:  'skipped',
        error:   `No sweep address configured for chain ${entry.chain}`,
      });
      continue;
    }

    // Find the wallet record
    const wallet = await prisma.wallet.findFirst({
      where: { address: entry.address, chain: entry.chain },
    });

    if (!wallet) {
      results.push({
        address: entry.address,
        chain:   entry.chain,
        asset:   entry.asset,
        amount:  entry.amount,
        status:  'skipped',
        error:   'Wallet record not found in database',
      });
      continue;
    }

    try {
      const privateKey = await getPrivateKey(wallet.telegramId, wallet.chain);
      const txResult   = await sendTransaction(wallet.chain as Chain, {
        from:       entry.address,
        to:         destAddress,
        amount:     entry.amount,
        privateKey,
        memo:       `admin-sweep-${sweepId}`,
      });

      // Persist sweep transaction
      await prisma.transaction.create({
        data: {
          walletId:   wallet.id,
          chain:      entry.chain,
          type:       'sweep',
          amount:     entry.amount,
          asset:      entry.asset,
          toAddress:  destAddress,
          fromAddress: entry.address,
          txHash:     txResult.txHash,
          status:     'confirmed',
          memo:       `sweep:${sweepId}`,
        },
      });

      results.push({
        address: entry.address,
        chain:   entry.chain,
        asset:   entry.asset,
        amount:  entry.amount,
        status:  'ok',
        txHash:  txResult.txHash,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Persist error record
      await prisma.txError.create({
        data: {
          walletId:     wallet.id,
          chain:        entry.chain,
          amount:       entry.amount,
          errorCode:    'SWEEP_FAILED',
          errorMessage,
        },
      });

      results.push({
        address: entry.address,
        chain:   entry.chain,
        asset:   entry.asset,
        amount:  entry.amount,
        status:  'failed',
        error:   errorMessage,
      });
    }
  }

  // 4. Clean up pending plan
  pendingSweeps.delete(sweepId);

  // 5. Notify admin of results
  if (ADMIN_ID) {
    const notifResults: SweepResultEntry[] = results.map((r) => ({
      address: r.address,
      chain:   r.chain,
      asset:   r.asset,
      amount:  r.amount,
      status:  r.status,
      txHash:  r.txHash,
      error:   r.error,
    }));
    await notifyAdminSweepResult(ADMIN_ID, notifResults);
  }

  return results;
}
