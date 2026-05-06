/**
 * Aptos signer — @aptos-labs/ts-sdk
 *
 * Key scheme:      Ed25519
 * Derivation path: m/44'/637'/0'/0'/0'  (SLIP-10 Ed25519)
 * RPC:             https://fullnode.mainnet.aptoslabs.com/v1
 */

import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
  AccountAddress,
  Mnemonic,
  Ed25519Account,
} from '@aptos-labs/ts-sdk';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import type { WalletData, TxResult } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL        = 'https://fullnode.mainnet.aptoslabs.com/v1';
const DERIVATION_PATH = "m/44'/637'/0'/0'/0'";
const EXPLORER       = 'https://explorer.aptoslabs.com';

const aptosConfig = new AptosConfig({ network: Network.MAINNET });
const aptos       = new Aptos(aptosConfig);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accountFromPrivKeyHex(hex: string): Ed25519Account {
  const privKey = new Ed25519PrivateKey(hex);
  return Account.fromPrivateKey({ privateKey: privKey });
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate or restore an Aptos wallet.
 *
 * @param mnemonic  Optional BIP-39 mnemonic.
 */
export async function generateAptosWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);
  if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid mnemonic phrase');

  const seed    = await bip39.mnemonicToSeed(phrase);
  const derived = derivePath(DERIVATION_PATH, seed.toString('hex'));

  const privKey  = new Ed25519PrivateKey(derived.key);
  const account  = Account.fromPrivateKey({ privateKey: privKey });

  return {
    address:        account.accountAddress.toString(),
    privateKey:     derived.key.toString('hex'),
    publicKey:      account.publicKey.toString(),
    mnemonic:       phrase,
    chain:          'aptos',
    derivationPath: DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// Send APT
// ---------------------------------------------------------------------------

/**
 * Transfer APT to a destination address.
 *
 * @param to         Destination 0x… Aptos address.
 * @param amount     Amount in APT (e.g. "1.5").
 * @param privateKey Hex-encoded private key (WalletData.privateKey).
 */
export async function sendAPT(
  to: string,
  amount: string,
  privateKey: string,
): Promise<TxResult> {
  const account  = accountFromPrivKeyHex(privateKey);

  // 1 APT = 100_000_000 Octas
  const octas = BigInt(Math.round(parseFloat(amount) * 1e8));

  const transaction = await aptos.transferCoinTransaction({
    sender:   account.accountAddress,
    recipient: AccountAddress.from(to),
    amount:    octas,
  });

  const pending = await aptos.signAndSubmitTransaction({
    signer:      account,
    transaction,
  });

  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash });

  return {
    txHash:      pending.hash,
    success:     (committed as { success?: boolean }).success ?? true,
    explorerUrl: `${EXPLORER}/txn/${pending.hash}?network=mainnet`,
    raw:         committed,
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is a valid Aptos account address (0x + 64 hex chars).
 */
export function validateAptosAddress(address: string): boolean {
  try {
    AccountAddress.from(address);
    return true;
  } catch {
    return false;
  }
}
