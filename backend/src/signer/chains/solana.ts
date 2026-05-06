import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
} from '@solana/spl-token';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';
import bs58 from 'bs58';
import type { WalletData, TxResult } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";
const SOLANA_EXPLORER = 'https://explorer.solana.com';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConnection(): Connection {
  return new Connection(SOLANA_RPC, 'confirmed');
}

/**
 * Restore a Keypair from a base58-encoded private key.
 */
function keypairFromPrivateKey(privateKey: string): Keypair {
  const secretKey = bs58.decode(privateKey);
  return Keypair.fromSecretKey(secretKey);
}

function buildExplorerTxUrl(txHash: string): string {
  return `${SOLANA_EXPLORER}/tx/${txHash}`;
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate a new Solana wallet using BIP39 mnemonic + ed25519 HD derivation.
 * Derivation path: m/44'/501'/0'/0'
 *
 * If `mnemonic` is provided the existing seed phrase is used.
 */
export async function generateSolanaWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);

  if (!bip39.validateMnemonic(phrase)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // BIP39 seed (no passphrase)
  const seed = await bip39.mnemonicToSeed(phrase);

  // ed25519 HD derivation
  const { key: derivedKey } = derivePath(
    SOLANA_DERIVATION_PATH,
    seed.toString('hex')
  );

  const keypair = Keypair.fromSeed(derivedKey);

  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const publicKeyBase58 = keypair.publicKey.toBase58();

  return {
    address: publicKeyBase58,
    privateKey: privateKeyBase58,
    publicKey: publicKeyBase58,
    mnemonic: phrase,
    chain: 'solana',
    derivationPath: SOLANA_DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// SOL transfer
// ---------------------------------------------------------------------------

/**
 * Send a native SOL transfer.
 *
 * @param to         Recipient base58 public key
 * @param amount     Amount in **lamports** (1 SOL = 1_000_000_000 lamports)
 * @param privateKey Sender's base58-encoded secret key
 */
export async function sendSOL(
  to: string,
  amount: string,
  privateKey: string
): Promise<TxResult> {
  const connection = getConnection();
  const sender = keypairFromPrivateKey(privateKey);
  const recipient = new PublicKey(to);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports: BigInt(amount),
    })
  );

  // Fetch latest blockhash
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender.publicKey;

  const txHash = await sendAndConfirmTransaction(connection, transaction, [sender], {
    commitment: 'confirmed',
  });

  const confirmedTx = await connection.getTransaction(txHash, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  return {
    txHash,
    success: confirmedTx?.meta?.err == null,
    blockNumber: confirmedTx?.slot,
    explorerUrl: buildExplorerTxUrl(txHash),
    raw: confirmedTx,
  };
}

// ---------------------------------------------------------------------------
// SPL Token transfer
// ---------------------------------------------------------------------------

/**
 * Send an SPL token transfer.
 *
 * @param mintAddress Mint address of the SPL token
 * @param to          Recipient wallet base58 public key
 * @param amount      Amount in the token's **smallest unit** (e.g. 1_000_000 for 1 USDC with 6 decimals)
 * @param privateKey  Sender's base58-encoded secret key
 */
export async function sendSPLToken(
  mintAddress: string,
  to: string,
  amount: string,
  privateKey: string
): Promise<TxResult> {
  const connection = getConnection();
  const sender = keypairFromPrivateKey(privateKey);
  const mintPubkey = new PublicKey(mintAddress);
  const recipientPubkey = new PublicKey(to);

  // Ensure recipient has an associated token account (create if needed)
  const recipientATA = await getOrCreateAssociatedTokenAccount(
    connection,
    sender,           // payer
    mintPubkey,
    recipientPubkey
  );

  // Get sender's associated token account
  const senderATA = getAssociatedTokenAddressSync(
    mintPubkey,
    sender.publicKey
  );

  const transaction = new Transaction().add(
    createTransferInstruction(
      senderATA,
      recipientATA.address,
      sender.publicKey,
      BigInt(amount),
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender.publicKey;

  const txHash = await sendAndConfirmTransaction(connection, transaction, [sender], {
    commitment: 'confirmed',
  });

  const confirmedTx = await connection.getTransaction(txHash, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  return {
    txHash,
    success: confirmedTx?.meta?.err == null,
    blockNumber: confirmedTx?.slot,
    explorerUrl: buildExplorerTxUrl(txHash),
    raw: confirmedTx,
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Validate a Solana base58 public key address.
 */
export function validateSolanaAddress(address: string): boolean {
  try {
    const pubkey = new PublicKey(address);
    return PublicKey.isOnCurve(pubkey.toBuffer());
  } catch {
    return false;
  }
}
