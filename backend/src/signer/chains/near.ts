/**
 * NEAR Protocol signer — near-api-js
 *
 * Key scheme:      Ed25519 (implicit accounts use 0x… hex of pubkey)
 * Derivation:      ed25519-hd-key (SLIP-10) on path m/44'/397'/0'
 * RPC:             https://rpc.mainnet.near.org
 *
 * NEAR does not use BIP-39 HD wallets in its official tooling but we support
 * deterministic derivation from a mnemonic for import/export compatibility.
 */

import * as nearAPI from 'near-api-js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';
import { KeyPair, utils } from 'near-api-js';
import type { WalletData, TxResult } from '../types';

const {
  connect,
  keyStores: { InMemoryKeyStore },
  transactions: { createTransaction, transfer },
  utils: { PublicKey, KeyPairEd25519 },
} = nearAPI;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL         = 'https://rpc.mainnet.near.org';
const DERIVATION_PATH = "m/44'/397'/0'";
const EXPLORER        = 'https://nearblocks.io';
const NEAR_DECIMALS   = 24; // yoctoNEAR per NEAR

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yoctoFromNEAR(near: string): bigint {
  // Convert NEAR string to yoctoNEAR (10^24)
  const [whole, frac = ''] = near.split('.');
  const fracPadded = frac.padEnd(NEAR_DECIMALS, '0').slice(0, NEAR_DECIMALS);
  return BigInt(whole) * BigInt(10 ** NEAR_DECIMALS) + BigInt(fracPadded);
}

async function getProvider() {
  const { JsonRpcProvider } = nearAPI.providers;
  return new JsonRpcProvider({ url: RPC_URL });
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate a NEAR wallet from a BIP-39 mnemonic or create a fresh one.
 *
 * Returns an "implicit account" — the hex representation of the Ed25519 public key.
 * Users need to fund this address before it becomes active on-chain.
 */
export async function generateNEARWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);
  if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid mnemonic phrase');

  const seed    = await bip39.mnemonicToSeed(phrase);
  const derived = derivePath(DERIVATION_PATH, seed.toString('hex'));

  const keyPair = nearAPI.utils.key_pair.KeyPairEd25519.fromString(
    utils.serialize.base_encode(derived.key),
  );

  // Implicit account id = lowercase hex of public key bytes
  const pubKeyBytes = Buffer.from(
    keyPair.getPublicKey().toString().replace('ed25519:', ''),
    'base64',
  );
  const implicitAddress = pubKeyBytes.toString('hex');

  return {
    address:        implicitAddress,
    privateKey:     utils.serialize.base_encode(derived.key),   // base58 encoded
    publicKey:      keyPair.getPublicKey().toString(),
    mnemonic:       phrase,
    chain:          'near',
    derivationPath: DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// Send NEAR
// ---------------------------------------------------------------------------

/**
 * Transfer NEAR to a destination account ID or implicit address.
 *
 * @param to         Destination NEAR account id (alice.near or implicit 0x…).
 * @param amount     Amount in NEAR (e.g. "2.5").
 * @param privateKey Base58-encoded private key (WalletData.privateKey).
 */
export async function sendNEAR(
  to: string,
  amount: string,
  privateKey: string,
): Promise<TxResult> {
  const keyPair = nearAPI.utils.key_pair.KeyPairEd25519.fromString(privateKey);

  // Derive implicit account id from public key
  const pubKeyBytes = Buffer.from(
    keyPair.getPublicKey().toString().replace('ed25519:', ''),
    'base64',
  );
  const fromAddress = pubKeyBytes.toString('hex');

  const keyStore = new InMemoryKeyStore();
  await keyStore.setKey('mainnet', fromAddress, keyPair as unknown as KeyPair);

  const near = await connect({
    networkId:  'mainnet',
    nodeUrl:    RPC_URL,
    keyStore,
  });

  const account = await near.account(fromAddress);

  const yocto  = yoctoFromNEAR(amount);
  const result = await account.sendMoney(to, yocto);

  return {
    txHash:      result.transaction.hash,
    success:     true,
    explorerUrl: `${EXPLORER}/txns/${result.transaction.hash}`,
    raw:         result,
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true for NEAR named accounts (alice.near, sub.alice.near) and
 * implicit accounts (64 hex chars).
 */
export function validateNEARAddress(address: string): boolean {
  // Implicit account: 64 hex characters
  if (/^[0-9a-f]{64}$/.test(address)) return true;

  // Named account: alphanumeric + hyphens, 2–64 chars, must end with .near or be top-level testnet ids
  if (/^[a-z0-9_-]{2,64}(\.near)?$/.test(address)) return true;

  return false;
}
