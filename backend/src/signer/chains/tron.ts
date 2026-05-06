/**
 * TRON signer — tronweb
 *
 * Full node:  https://api.trongrid.io
 * Native:     TRX (6 decimals, 1 TRX = 1_000_000 sun)
 * Tokens:     TRC-20
 */

import TronWeb from 'tronweb';
import type { WalletData, TxResult } from '../types';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const TRON_FULL_HOST = 'https://api.trongrid.io';

function getTronWeb(privateKey?: string): InstanceType<typeof TronWeb> {
  return new TronWeb({
    fullHost: TRON_FULL_HOST,
    privateKey: privateKey ? privateKey.replace(/^0x/, '') : undefined,
  });
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate a new TRON wallet.
 * Returns address, private key (hex, no 0x prefix), and public key.
 */
export async function generateTRONWallet(): Promise<WalletData> {
  const tronWeb = getTronWeb();
  const account = await tronWeb.createAccount();

  // tronweb returns: { privateKey, publicKey, address: { base58, hex } }
  const address    = account.address.base58;
  const privateKey = account.privateKey as string;
  const publicKey  = account.publicKey  as string;

  return {
    address,
    privateKey,
    publicKey,
    chain: 'tron',
    derivationPath: 'TRON random key (no HD derivation)',
  };
}

// ---------------------------------------------------------------------------
// TRX transfer
// ---------------------------------------------------------------------------

/**
 * Send native TRX.
 *
 * @param to         Destination TRON address (base58).
 * @param amount     Amount in TRX as a string (e.g. "10.5").
 * @param privateKey Hex private key (no 0x prefix).
 */
export async function sendTRX(
  to: string,
  amount: string,
  privateKey: string
): Promise<TxResult> {
  const tronWeb = getTronWeb(privateKey);

  // Convert TRX → sun (1 TRX = 1_000_000 sun)
  const sunAmount = Math.round(parseFloat(amount) * 1_000_000);

  const fromAddress = tronWeb.address.fromPrivateKey(privateKey.replace(/^0x/, '')) as string;

  // Build unsigned transaction
  const unsignedTx = await tronWeb.transactionBuilder.sendTrx(
    to,
    sunAmount,
    fromAddress
  );

  // Sign and broadcast
  const signedTx = await tronWeb.trx.sign(unsignedTx, privateKey.replace(/^0x/, ''));
  const result   = await tronWeb.trx.sendRawTransaction(signedTx);

  const txHash = (result as any).transaction?.txID ?? (result as any).txid ?? '';

  return {
    txHash,
    success: !!(result as any).result,
    explorerUrl: `https://tronscan.org/#/transaction/${txHash}`,
    raw: result,
  };
}

// ---------------------------------------------------------------------------
// TRC-20 transfer
// ---------------------------------------------------------------------------

// Minimal TRC-20 ABI fragment for transfer
const TRC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: '_to',    type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name:            'transfer',
    outputs:         [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type:            'function',
  },
];

/**
 * Send a TRC-20 token.
 *
 * @param contractAddress  TRC-20 contract address (base58 or hex).
 * @param to               Destination address.
 * @param amount           Token amount in the token's smallest unit (e.g. 1_000_000 for 1 USDT).
 * @param privateKey       Hex private key.
 */
export async function sendTRC20(
  contractAddress: string,
  to: string,
  amount: string,
  privateKey: string
): Promise<TxResult> {
  const tronWeb = getTronWeb(privateKey);

  const fromAddress = tronWeb.address.fromPrivateKey(privateKey.replace(/^0x/, '')) as string;

  // Build the contract call transaction
  const unsignedTx = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    'transfer(address,uint256)',
    {
      feeLimit:       40_000_000,   // 40 TRX max fee
      callValue:      0,
      from:           fromAddress,
    },
    [
      { type: 'address', value: to },
      { type: 'uint256', value: amount },
    ],
    fromAddress
  );

  if (!unsignedTx.result?.result) {
    throw new Error(`Failed to build TRC-20 transfer tx: ${JSON.stringify(unsignedTx.result)}`);
  }

  const signedTx = await tronWeb.trx.sign(unsignedTx.transaction, privateKey.replace(/^0x/, ''));
  const result   = await tronWeb.trx.sendRawTransaction(signedTx);

  const txHash = (result as any).transaction?.txID ?? (result as any).txid ?? '';

  return {
    txHash,
    success: !!(result as any).result,
    explorerUrl: `https://tronscan.org/#/transaction/${txHash}`,
    raw: result,
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is a valid TRON base58 address.
 */
export function validateTRONAddress(address: string): boolean {
  try {
    const tronWeb = getTronWeb();
    return tronWeb.isAddress(address);
  } catch {
    return false;
  }
}
