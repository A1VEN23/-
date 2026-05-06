import { prisma } from '../db';
import { encryptPrivateKey, decryptPrivateKey, hashForDebug } from './crypto';
import { generateWallet } from '../signer';

const MASTER_SECRET = process.env.MASTER_SECRET;
if (!MASTER_SECRET) {
  throw new Error('MASTER_SECRET environment variable is required');
}

export interface WalletInfo {
  address: string;
  chain: string;
}

/**
 * Returns the existing wallet for (telegramId, chain) or generates a new one,
 * encrypts the private key, and persists it to the database.
 */
export async function getOrCreateWallet(
  telegramId: string,
  chain: string,
): Promise<{ address: string }> {
  const existing = await prisma.wallet.findUnique({
    where: { telegramId_chain: { telegramId, chain } },
    select: { address: true },
  });

  if (existing) {
    return { address: existing.address };
  }

  // Generate a fresh wallet for this chain
  const generated = await generateWallet(chain);

  const encryptedPrivateKey = encryptPrivateKey(generated.privateKey, MASTER_SECRET!);
  const encryptedMnemonic   = generated.mnemonic
    ? encryptPrivateKey(generated.mnemonic, MASTER_SECRET!)
    : undefined;

  await prisma.wallet.create({
    data: {
      telegramId,
      chain,
      address:            generated.address,
      encryptedPrivateKey,
      encryptedMnemonic,
    },
  });

  console.debug(
    `[vault] Created wallet chain=${chain} tg=${telegramId} ` +
    `addr=${generated.address} keyHash=${hashForDebug(generated.privateKey)}`,
  );

  return { address: generated.address };
}

/**
 * Retrieves and decrypts the private key for an existing wallet.
 * Throws if the wallet does not exist.
 */
export async function getPrivateKey(
  telegramId: string,
  chain: string,
): Promise<string> {
  const wallet = await prisma.wallet.findUnique({
    where: { telegramId_chain: { telegramId, chain } },
    select: { encryptedPrivateKey: true },
  });

  if (!wallet) {
    throw new Error(`Wallet not found: telegramId=${telegramId} chain=${chain}`);
  }

  return decryptPrivateKey(wallet.encryptedPrivateKey, MASTER_SECRET!);
}

/**
 * Returns a list of all wallets belonging to the given Telegram user.
 */
export async function listWallets(
  telegramId: string,
): Promise<Array<{ chain: string; address: string }>> {
  const wallets = await prisma.wallet.findMany({
    where: { telegramId },
    select: { chain: true, address: true },
    orderBy: { createdAt: 'asc' },
  });

  return wallets.map(w => ({ chain: w.chain, address: w.address }));
}
