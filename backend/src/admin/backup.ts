/**
 * gem-twa — Admin: Backup
 *
 * Wallet data backup and restore:
 *  - createBackup()     — dump Wallet rows, encrypt AES-256-GCM, write to /backups/
 *  - downloadBackup()   — read an existing backup file as a Buffer
 *  - restoreBackup()    — decrypt and upsert Wallet rows
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync }                 from 'fs';
import { join }                       from 'path';
import { prisma }                     from '../db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM   = 'aes-256-gcm';
const IV_LEN      = 12;   // 96-bit IV for GCM
const SALT_LEN    = 32;
const KEY_LEN     = 32;
const BACKUP_DIR  = process.env.BACKUP_DIR ?? '/backups';

const BACKUP_SECRET = process.env.MASTER_SECRET ?? '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupRecord {
  id: string;
  filename: string;
  walletCount: number;
  createdAt: Date;
}

interface WalletRow {
  id: string;
  telegramId: string;
  chain: string;
  address: string;
  encryptedPrivateKey: string;
  encryptedMnemonic: string | null;
  createdAt: Date;
}

interface BackupPayload {
  version: number;
  exportedAt: string;
  wallets: WalletRow[];
}

// ---------------------------------------------------------------------------
// Internal crypto helpers
// ---------------------------------------------------------------------------

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LEN);
}

function encryptBuffer(plain: Buffer, secret: string): Buffer {
  const salt   = randomBytes(SALT_LEN);
  const iv     = randomBytes(IV_LEN);
  const key    = deriveKey(secret, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag    = cipher.getAuthTag(); // 16 bytes

  // Layout: [4-byte magic] [salt 32] [iv 12] [authTag 16] [ciphertext …]
  const magic = Buffer.from('GEMB');
  return Buffer.concat([magic, salt, iv, authTag, ciphertext]);
}

function decryptBuffer(enc: Buffer, secret: string): Buffer {
  const magic = enc.slice(0, 4).toString('ascii');
  if (magic !== 'GEMB') throw new Error('Invalid backup format (bad magic bytes)');

  let offset = 4;
  const salt       = enc.slice(offset, offset + SALT_LEN); offset += SALT_LEN;
  const iv         = enc.slice(offset, offset + IV_LEN);   offset += IV_LEN;
  const authTag    = enc.slice(offset, offset + 16);        offset += 16;
  const ciphertext = enc.slice(offset);

  const key      = deriveKey(secret, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

export async function createBackup(): Promise<BackupRecord> {
  if (!BACKUP_SECRET) {
    throw new Error('MASTER_SECRET is required for backup encryption');
  }

  // 1. Load all wallet rows
  const wallets = await prisma.wallet.findMany();

  const payload: BackupPayload = {
    version:    1,
    exportedAt: new Date().toISOString(),
    wallets:    wallets as WalletRow[],
  };

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = encryptBuffer(plaintext, BACKUP_SECRET);

  // 2. Ensure backup directory exists
  if (!existsSync(BACKUP_DIR)) {
    await mkdir(BACKUP_DIR, { recursive: true });
  }

  const filename = `backup_${Date.now()}.enc`;
  const filepath = join(BACKUP_DIR, filename);

  await writeFile(filepath, encrypted);

  // 3. Record in DB
  const record = await prisma.backup.create({
    data: {
      filename,
      walletCount: wallets.length,
    },
  });

  return {
    id:          record.id,
    filename:    record.filename,
    walletCount: record.walletCount,
    createdAt:   record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// downloadBackup
// ---------------------------------------------------------------------------

export async function downloadBackup(id: string): Promise<Buffer> {
  const record = await prisma.backup.findUnique({ where: { id } });
  if (!record) {
    throw Object.assign(new Error('Backup record not found'), { statusCode: 404 });
  }

  const filepath = join(BACKUP_DIR, record.filename);

  if (!existsSync(filepath)) {
    throw Object.assign(
      new Error(`Backup file not found on disk: ${record.filename}`),
      { statusCode: 404 },
    );
  }

  return readFile(filepath);
}

// ---------------------------------------------------------------------------
// restoreBackup
// ---------------------------------------------------------------------------

/**
 * Accepts raw encrypted backup data (Buffer), decrypts it, and upserts all
 * wallet records into the database.  Existing records (matched on id) are
 * updated; new records are created.
 */
export async function restoreBackup(encryptedData: Buffer): Promise<void> {
  if (!BACKUP_SECRET) {
    throw new Error('MASTER_SECRET is required for backup decryption');
  }

  const plain   = decryptBuffer(encryptedData, BACKUP_SECRET);
  const payload = JSON.parse(plain.toString('utf8')) as BackupPayload;

  if (!payload.wallets || !Array.isArray(payload.wallets)) {
    throw new Error('Invalid backup payload: missing wallets array');
  }

  // Upsert each wallet
  await prisma.$transaction(
    payload.wallets.map((w) =>
      prisma.wallet.upsert({
        where:  { telegramId_chain: { telegramId: w.telegramId, chain: w.chain } },
        update: {
          address:             w.address,
          encryptedPrivateKey: w.encryptedPrivateKey,
          encryptedMnemonic:   w.encryptedMnemonic,
        },
        create: {
          id:                  w.id,
          telegramId:          w.telegramId,
          chain:               w.chain,
          address:             w.address,
          encryptedPrivateKey: w.encryptedPrivateKey,
          encryptedMnemonic:   w.encryptedMnemonic,
          createdAt:           new Date(w.createdAt),
        },
      }),
    ),
  );
}
