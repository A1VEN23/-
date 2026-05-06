/**
 * Bitcoin signer — bitcoinjs-lib
 *
 * Address type:    P2WPKH (native SegWit, bech32)
 * Derivation path: m/84'/0'/0'/0/0  (BIP-84)
 * UTXO provider:   https://blockstream.info/api
 * Fixed fee:       2 000 satoshis
 */

import * as bitcoin    from 'bitcoinjs-lib';
import * as bip39      from 'bip39';
import * as ecc        from 'tiny-secp256k1';
import { BIP32Factory }  from 'bip32';
import { ECPairFactory } from 'ecpair';
import type { WalletData, TxResult } from '../types';

// Register the ECC library required by bitcoinjs-lib v6+
bitcoin.initEccLib(ecc);

const ECPair = ECPairFactory(ecc);
const bip32  = BIP32Factory(ecc);

const NETWORK         = bitcoin.networks.bitcoin;
const DERIVATION_PATH = "m/84'/0'/0'/0/0";
const FIXED_FEE_SATS  = 2_000; // satoshis

// ---------------------------------------------------------------------------
// Blockstream UTXO types
// ---------------------------------------------------------------------------

interface BlockstreamUTXO {
  txid:   string;
  vout:   number;
  status: { confirmed: boolean; block_height?: number };
  value:  number; // satoshis
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate a Bitcoin P2WPKH wallet.
 * If `mnemonic` is supplied the existing seed phrase is restored; otherwise a
 * fresh 24-word mnemonic is created.
 */
export async function generateBitcoinWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);

  if (!bip39.validateMnemonic(phrase)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const seed   = await bip39.mnemonicToSeed(phrase);
  const root   = bip32.fromSeed(seed, NETWORK);
  const child  = root.derivePath(DERIVATION_PATH);

  if (!child.privateKey) throw new Error('Could not derive private key');

  const { address } = bitcoin.payments.p2wpkh({
    pubkey:  child.publicKey,
    network: NETWORK,
  });

  if (!address) throw new Error('Could not derive P2WPKH address');

  const privateKeyWIF = child.toWIF();
  const publicKeyHex  = child.publicKey.toString('hex');

  return {
    address,
    privateKey:     privateKeyWIF,
    publicKey:      publicKeyHex,
    mnemonic:       phrase,
    chain:          'bitcoin',
    derivationPath: DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// UTXO fetching (Blockstream.info)
// ---------------------------------------------------------------------------

async function fetchUTXOs(address: string): Promise<BlockstreamUTXO[]> {
  const res = await fetch(`https://blockstream.info/api/address/${address}/utxo`);
  if (!res.ok) {
    throw new Error(`Blockstream UTXO fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<BlockstreamUTXO[]>;
}

async function fetchRawTx(txid: string): Promise<string> {
  const res = await fetch(`https://blockstream.info/api/tx/${txid}/hex`);
  if (!res.ok) {
    throw new Error(`Blockstream raw tx fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// BTC transfer
// ---------------------------------------------------------------------------

/**
 * Send BTC to a destination address.
 *
 * @param to            Destination Bitcoin address.
 * @param amountBTC     Amount in BTC (e.g. "0.001").
 * @param privateKeyWIF WIF-encoded private key from WalletData.privateKey.
 */
export async function sendBTC(
  to: string,
  amountBTC: string,
  privateKeyWIF: string
): Promise<TxResult> {
  // Reconstruct the key pair from WIF
  const keyPair = ECPair.fromWIF(privateKeyWIF, NETWORK);

  // Derive our P2WPKH address
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK });
  const fromAddress = p2wpkh.address!;

  // Fetch UTXOs
  const utxos = await fetchUTXOs(fromAddress);
  if (utxos.length === 0) throw new Error('No UTXOs available');

  const amountSats = Math.round(parseFloat(amountBTC) * 1e8);
  const totalIn    = utxos.reduce((s, u) => s + u.value, 0);
  const change     = totalIn - amountSats - FIXED_FEE_SATS;

  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${amountSats + FIXED_FEE_SATS} sats, have ${totalIn} sats`
    );
  }

  // Build PSBT
  const psbt = new bitcoin.Psbt({ network: NETWORK });

  // Add inputs (we need the full previous tx for witness)
  for (const utxo of utxos) {
    const rawTxHex = await fetchRawTx(utxo.txid);
    psbt.addInput({
      hash:             utxo.txid,
      index:            utxo.vout,
      witnessUtxo: {
        script: p2wpkh.output!,
        value:  utxo.value,
      },
    });
  }

  // Recipient output
  psbt.addOutput({ address: to, value: amountSats });

  // Change output (omit if dust)
  if (change > 546) {
    psbt.addOutput({ address: fromAddress, value: change });
  }

  // Sign all inputs
  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();

  const txHex = psbt.extractTransaction().toHex();

  // Broadcast via Blockstream
  const broadcastRes = await fetch('https://blockstream.info/api/tx', {
    method: 'POST',
    body:   txHex,
    headers: { 'Content-Type': 'text/plain' },
  });

  if (!broadcastRes.ok) {
    const errText = await broadcastRes.text();
    throw new Error(`Broadcast failed: ${broadcastRes.status} — ${errText}`);
  }

  const txHash = (await broadcastRes.text()).trim();

  return {
    txHash,
    success: true,
    explorerUrl: `https://blockstream.info/tx/${txHash}`,
    raw: { amountSats, fee: FIXED_FEE_SATS, change, inputs: utxos.length },
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is a valid mainnet Bitcoin address
 * (legacy P2PKH, P2SH, or native SegWit bech32 P2WPKH/P2WSH).
 */
export function validateBTCAddress(address: string): boolean {
  try {
    bitcoin.address.toOutputScript(address, NETWORK);
    return true;
  } catch {
    return false;
  }
}
