/**
 * gem-twa — Background Scheduler
 *
 * Runs two periodic jobs:
 *
 *  1. Balance monitor  (every 60 seconds)
 *     Fetches the native balance of every wallet in the DB.
 *     When a balance exceeds its previous known value, fires a notification
 *     to the wallet owner (and to admin, if an admin Telegram ID is set).
 *
 *  2. Auto-backup      (every 24 hours)
 *     Creates an encrypted snapshot of all wallet addresses (NOT private keys)
 *     and writes it to the configured backup destination.
 */

import { prisma }                 from '../db';
import { getBalance }             from '../proxy/balances';
import {
  notifyUserReceived,
  notifyAdminReceived,
}                                 from '../bot/notifications';

// ---------------------------------------------------------------------------
// State — previous balances keyed by "chain:address"
// ---------------------------------------------------------------------------

const previousBalances = new Map<string, number>();

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID
  ? parseInt(process.env.ADMIN_TELEGRAM_ID, 10)
  : null;

const BACKUP_DIR = process.env.BACKUP_DIR ?? '/tmp/gem-twa-backups';

// ---------------------------------------------------------------------------
// Interval references (kept so we can clearInterval on shutdown)
// ---------------------------------------------------------------------------

let balanceInterval: NodeJS.Timeout | null = null;
let backupInterval:  NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Balance monitoring
// ---------------------------------------------------------------------------

/**
 * Map chain names to their primary native asset symbol for display.
 */
const CHAIN_ASSET: Record<string, string> = {
  ethereum:  'ETH',
  bsc:       'BNB',
  polygon:   'MATIC',
  arbitrum:  'ETH',
  optimism:  'ETH',
  avalanche: 'AVAX',
  solana:    'SOL',
  ton:       'TON',
  tron:      'TRX',
  bitcoin:   'BTC',
  dogecoin:  'DOGE',
  litecoin:  'LTC',
  near:      'NEAR',
  cosmos:    'ATOM',
  aptos:     'APT',
  xrp:       'XRP',
};

function assetForChain(chain: string): string {
  return CHAIN_ASSET[chain.toLowerCase()] ?? chain.toUpperCase();
}

/**
 * Poll balances of every known wallet.
 * Fires notifications when balance increases (new deposit detected).
 */
async function checkBalances(): Promise<void> {
  let wallets: Array<{ chain: string; address: string; telegramId: string }>;

  try {
    wallets = await prisma.wallet.findMany({
      select: { chain: true, address: true, telegramId: true },
    });
  } catch (err) {
    console.error('[scheduler] Failed to fetch wallets:', err);
    return;
  }

  for (const wallet of wallets) {
    const key = `${wallet.chain}:${wallet.address}`;

    let balance: number;
    try {
      balance = await getBalance(wallet.chain, wallet.address);
    } catch {
      // Transient RPC error — skip this wallet for now
      continue;
    }

    const prev = previousBalances.get(key);

    if (prev !== undefined && balance > prev) {
      const diff  = balance - prev;
      const asset = assetForChain(wallet.chain);

      // Notify the user
      try {
        await notifyUserReceived(
          wallet.telegramId,
          diff.toFixed(8).replace(/\.?0+$/, ''), // trim trailing zeros
          asset,
          wallet.chain,
          '', // TX hash unavailable at polling time
        );
      } catch (err) {
        console.error('[scheduler] Failed to notify user:', err);
      }

      // Notify admin if configured
      if (ADMIN_TELEGRAM_ID) {
        try {
          await notifyAdminReceived(
            ADMIN_TELEGRAM_ID,
            wallet.chain,
            `addr: ${wallet.address}`,
            diff.toFixed(8).replace(/\.?0+$/, ''),
            asset,
            '', // TX link unavailable at polling time
          );
        } catch (err) {
          console.error('[scheduler] Failed to notify admin:', err);
        }
      }
    }

    previousBalances.set(key, balance);
  }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

interface BackupRecord {
  chain:      string;
  address:    string;
  telegramId: string;
  createdAt:  Date;
}

interface BackupSnapshot {
  timestamp: string;
  version:   number;
  wallets:   BackupRecord[];
}

/**
 * Create an encrypted JSON snapshot of all wallet addresses.
 * Private keys are NEVER included; the snapshot is for address recovery only.
 */
async function createBackup(): Promise<void> {
  const { createHash, createCipheriv, randomBytes } = await import('crypto');
  const { writeFile, mkdir }                        = await import('fs/promises');
  const { join }                                    = await import('path');

  // Ensure backup directory exists
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
  } catch {
    // Directory may already exist — ignore
  }

  let wallets: BackupRecord[];
  try {
    wallets = await prisma.wallet.findMany({
      select: {
        chain:      true,
        address:    true,
        telegramId: true,
        createdAt:  true,
      },
      orderBy: { createdAt: 'asc' },
    });
  } catch (err) {
    console.error('[scheduler] Backup failed — could not fetch wallets:', err);
    return;
  }

  const snapshot: BackupSnapshot = {
    timestamp: new Date().toISOString(),
    version:   1,
    wallets,
  };

  const plaintext = JSON.stringify(snapshot, null, 2);

  // Encrypt with AES-256-GCM using MASTER_SECRET as the key material
  const masterSecret = process.env.MASTER_SECRET ?? 'changeme';
  const salt         = randomBytes(32);
  const { scryptSync } = await import('crypto');
  const key          = scryptSync(masterSecret, salt, 32);
  const iv           = randomBytes(12);

  const cipher    = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Bundle: salt:iv:tag:ciphertext (all hex, colon-separated)
  const payload = [
    salt.toString('hex'),
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');

  // Checksum for integrity verification
  const checksum = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  const filename = `backup-${snapshot.timestamp.replace(/[:.]/g, '-')}-${checksum}.enc`;

  try {
    await writeFile(join(BACKUP_DIR, filename), payload, 'utf8');
    console.info(`[scheduler] Backup written: ${filename} (${wallets.length} wallets)`);
  } catch (err) {
    console.error('[scheduler] Failed to write backup file:', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the scheduler — call once at application startup.
 * Idempotent: calling twice without stopping first is safe (existing intervals
 * are cleared before new ones are created).
 */
export function startScheduler(): void {
  // Clear any existing intervals to prevent duplication
  if (balanceInterval) clearInterval(balanceInterval);
  if (backupInterval)  clearInterval(backupInterval);

  // Run immediately on startup, then repeat
  void checkBalances();

  balanceInterval = setInterval(() => {
    void checkBalances();
  }, 60_000); // every 60 seconds

  backupInterval = setInterval(() => {
    void createBackup();
  }, 24 * 60 * 60 * 1000); // every 24 hours

  console.info('[scheduler] Started — balance check: 60s, backup: 24h');
}

/**
 * Stop all scheduler intervals — call during graceful shutdown.
 */
export function stopScheduler(): void {
  if (balanceInterval) {
    clearInterval(balanceInterval);
    balanceInterval = null;
  }
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
  console.info('[scheduler] Stopped.');
}
