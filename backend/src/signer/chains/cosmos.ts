/**
 * Cosmos (ATOM) signer — @cosmjs/stargate
 *
 * Address type:    bech32 "cosmos1…"
 * Derivation path: m/44'/118'/0'/0/0  (SLIP-44)
 * RPC:             https://cosmos-rpc.publicnode.com:443
 */

import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, StargateClient, GasPrice, coin } from '@cosmjs/stargate';
import { fromHex, toHex } from '@cosmjs/encoding';
import * as bip39 from 'bip39';
import type { WalletData, TxResult } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL        = 'https://cosmos-rpc.publicnode.com:443';
const DENOM          = 'uatom';
const BECH32_PREFIX  = 'cosmos';
const DERIVATION_PATH = "m/44'/118'/0'/0/0";
const GAS_PRICE      = GasPrice.fromString('0.025uatom');
const EXPLORER_URL   = 'https://www.mintscan.io/cosmos';

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate or restore a Cosmos wallet.
 *
 * @param mnemonic  Optional BIP-39 mnemonic. A fresh one is created if omitted.
 */
export async function generateCosmosWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);

  if (!bip39.validateMnemonic(phrase)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(phrase, {
    prefix: BECH32_PREFIX,
    hdPaths: [makeHdPath(0, 0)],
  });

  const [account] = await wallet.getAccounts();

  // Serialise the private key from the wallet's signer
  const privKeyBytes = await derivePrivKey(phrase);
  const privateKey   = toHex(privKeyBytes);
  const publicKey    = toHex(account.pubkey);

  return {
    address:        account.address,
    privateKey,
    publicKey,
    mnemonic:       phrase,
    chain:          'cosmos',
    derivationPath: DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a BIP-44 HD path object accepted by @cosmjs */
function makeHdPath(account: number, index: number) {
  // @cosmjs uses stringPath overload
  const { stringToPath } = require('@cosmjs/crypto');
  return stringToPath(`m/44'/118'/${account}'/0/${index}`);
}

/** Derive the raw 32-byte private key from a mnemonic (Cosmos slip44 path). */
async function derivePrivKey(mnemonic: string): Promise<Uint8Array> {
  const { Slip10, Slip10Curve, stringToPath } = await import('@cosmjs/crypto');
  const seed  = await bip39.mnemonicToSeed(mnemonic);
  const path  = stringToPath(DERIVATION_PATH);
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, path);
  return privkey;
}

/** Build a signer from a hex private key */
async function walletFromPrivKey(privateKeyHex: string): Promise<DirectSecp256k1Wallet> {
  return DirectSecp256k1Wallet.fromKey(fromHex(privateKeyHex), BECH32_PREFIX);
}

// ---------------------------------------------------------------------------
// Send ATOM
// ---------------------------------------------------------------------------

/**
 * Transfer ATOM to a destination address.
 *
 * @param to          Destination cosmos1… address.
 * @param amount      Amount in ATOM (e.g. "1.5").
 * @param privateKey  Hex-encoded private key (WalletData.privateKey).
 * @param memo        Optional transaction memo.
 */
export async function sendATOM(
  to: string,
  amount: string,
  privateKey: string,
  memo?: string,
): Promise<TxResult> {
  const wallet = await walletFromPrivKey(privateKey);
  const [account] = await wallet.getAccounts();
  const fromAddress = account.address;

  const client = await SigningStargateClient.connectWithSigner(RPC_URL, wallet, {
    gasPrice: GAS_PRICE,
  });

  // Convert ATOM → uatom
  const uatomAmount = String(Math.round(parseFloat(amount) * 1_000_000));
  const sendCoin    = coin(uatomAmount, DENOM);

  const result = await client.sendTokens(
    fromAddress,
    to,
    [sendCoin],
    'auto',
    memo ?? '',
  );

  return {
    txHash:      result.transactionHash,
    success:     result.code === 0,
    blockNumber: result.height,
    explorerUrl: `${EXPLORER_URL}/txs/${result.transactionHash}`,
    raw:         result,
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is a valid Cosmos bech32 address (cosmos1…).
 */
export function validateCosmosAddress(address: string): boolean {
  try {
    const { fromBech32 } = require('@cosmjs/encoding');
    const { prefix, data } = fromBech32(address);
    return prefix === BECH32_PREFIX && data.length === 20;
  } catch {
    return false;
  }
}
