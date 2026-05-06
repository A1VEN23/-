/**
 * XRP Ledger signer — xrpl
 *
 * Wallet type:     secp256k1 (default family seed / ED25519 optional)
 * RPC (WebSocket): wss://xrplcluster.com
 * Derivation:      XRPL native (not BIP-39 HD by default; mnemonic used via
 *                  xrpl.Wallet.fromMnemonic when supplied)
 */

import {
  Client,
  Wallet,
  xrpToDrops,
  dropsToXrp,
  isValidAddress,
  Payment,
  Transaction,
  TxResponse,
} from 'xrpl';
import type { WalletData, TxResult } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_URL      = 'wss://xrplcluster.com';
const EXPLORER    = 'https://livenet.xrpl.org';
const RESERVE_XRP = 2; // base reserve – protect users from draining reserve

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(WS_URL);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate or restore an XRP Ledger wallet.
 *
 * If `mnemonic` is supplied the wallet is restored using xrpl's built-in
 * Wallet.fromMnemonic() (RFC1751 or BIP-39 phrase supported).
 * Otherwise a fresh wallet with a random entropy is created.
 */
export async function generateXRPWallet(mnemonic?: string): Promise<WalletData> {
  let wallet: Wallet;

  if (mnemonic) {
    // xrpl supports BIP-39 mnemonics via the `mnemonicEncoding` option
    wallet = Wallet.fromMnemonic(mnemonic, { mnemonicEncoding: 'bip39' });
  } else {
    wallet = Wallet.generate();
  }

  return {
    address:    wallet.address,
    privateKey: wallet.privateKey,   // hex-encoded
    publicKey:  wallet.publicKey,    // hex-encoded
    mnemonic:   mnemonic,            // undefined when freshly generated
    chain:      'xrp',
  };
}

// ---------------------------------------------------------------------------
// Send XRP
// ---------------------------------------------------------------------------

/**
 * Transfer XRP to a destination address.
 *
 * @param to              Destination rXXX… address.
 * @param amount          Amount in XRP (e.g. "10.5").
 * @param privateKey      Hex-encoded private key (WalletData.privateKey).
 * @param destinationTag  Optional 32-bit unsigned integer destination tag.
 */
export async function sendXRP(
  to: string,
  amount: string,
  privateKey: string,
  destinationTag?: number,
): Promise<TxResult> {
  return withClient(async (client) => {
    // Rebuild wallet from private key
    const wallet = Wallet.fromPrivateKey(privateKey);

    // Convert XRP to drops (1 XRP = 1_000_000 drops)
    const amountDrops = xrpToDrops(amount);

    const payment: Payment = {
      TransactionType:  'Payment',
      Account:          wallet.address,
      Destination:      to,
      Amount:           amountDrops,
      ...(destinationTag !== undefined ? { DestinationTag: destinationTag } : {}),
    };

    const prepared = await client.autofill(payment);
    const signed   = wallet.sign(prepared);
    const result   = await client.submitAndWait(signed.tx_blob);

    const meta       = result.result.meta as Record<string, unknown> | undefined;
    const resultCode = (meta?.TransactionResult as string | undefined) ?? 'unknown';
    const success    = resultCode === 'tesSUCCESS';

    return {
      txHash:      result.result.hash,
      success,
      explorerUrl: `${EXPLORER}/transactions/${result.result.hash}`,
      raw:         result.result,
    };
  });
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is a valid XRP Ledger classic address.
 */
export function validateXRPAddress(address: string): boolean {
  return isValidAddress(address);
}
