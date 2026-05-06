/**
 * Litecoin signer — bitcoinjs-lib with custom network params
 *
 * Address type:    P2WPKH (native SegWit, bech32 "ltc1…")
 * Derivation path: m/84'/2'/0'/0/0  (BIP-84, coin type 2 = LTC)
 * UTXO provider:   https://ltc.bitaps.com/api/v1/blockchain
 * Fixed fee:       100 000 litoshis  ≈ 0.001 LTC
 */

import * as bitcoin    from 'bitcoinjs-lib';
import * as bip39      from 'bip39';
import * as ecc        from 'tiny-secp256k1';
import { BIP32Factory }  from 'bip32';
import { ECPairFactory } from 'ecpair';
import type { WalletData, TxResult } from '../types';

// Register ECC
bitcoin.initEccLib(ecc);

const ECPair = ECPairFactory(ecc);
const bip32  = BIP32Factory(ecc);

// ---------------------------------------------------------------------------
// Litecoin network parameters
// ---------------------------------------------------------------------------

const LITECOIN_NETWORK: bitcoin.networks.Network = {
  messagePrefix:     '\x19Litecoin Signed Message:\n',
  bech32:            'ltc',
  bip32: {
    public:  0x019da462,  // Lpub
    private: 0x019d9cfe,  // Lprv
  },
  pubKeyHash: 0x30,       // 'L' addresses
  scriptHash: 0x32,       // 'M' addresses
  wif:        0xb0,
};

const DERIVATION_PATH  = "m/84'/2'/0'/0/0";
const FIXED_FEE_LITS   = 100_000; // litoshis
const EXPLORER_URL     = 'https://litecoinspace.org';

// ---------------------------------------------------------------------------
// UTXO provider — bitaps.com
// ---------------------------------------------------------------------------

interface BitapsUTXO {
  txHash: string;
  vout:   number;
  value:  number; // litoshis
}

async function fetchUTXOs(address: string): Promise<BitapsUTXO[]> {
  const res = await fetch(
    `https://api.bitaps.com/ltc/v1/blockchain/address/transactions/${address}?mode=unspent`,
  );
  if (!res.ok) throw new Error(`Bitaps UTXO fetch failed: ${res.status}`);
  const json = await res.json() as { data?: { list?: BitapsUTXO[] } };
  return json.data?.list ?? [];
}

async function fetchRawTx(txHash: string): Promise<string> {
  const res = await fetch(
    `https://api.bitaps.com/ltc/v1/blockchain/transaction/${txHash}/raw`,
  );
  if (!res.ok) throw new Error(`Raw tx fetch failed: ${res.status}`);
  const json = await res.json() as { data?: string };
  if (!json.data) throw new Error('No raw tx data');
  return json.data;
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

export async function generateLTCWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);
  if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid mnemonic phrase');

  const seed   = await bip39.mnemonicToSeed(phrase);
  const root   = bip32.fromSeed(seed, LITECOIN_NETWORK);
  const child  = root.derivePath(DERIVATION_PATH);

  if (!child.privateKey) throw new Error('Could not derive private key');

  const { address } = bitcoin.payments.p2wpkh({
    pubkey:  child.publicKey,
    network: LITECOIN_NETWORK,
  });

  if (!address) throw new Error('Could not derive P2WPKH address');

  return {
    address,
    privateKey:     child.toWIF(),
    publicKey:      child.publicKey.toString('hex'),
    mnemonic:       phrase,
    chain:          'litecoin',
    derivationPath: DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// Send LTC
// ---------------------------------------------------------------------------

/**
 * Transfer LTC to a destination address.
 *
 * @param to            Destination Litecoin address (ltc1…, L…, or M…).
 * @param amount        Amount in LTC (e.g. "0.5").
 * @param privateKeyWIF WIF-encoded private key (WalletData.privateKey).
 */
export async function sendLTC(
  to: string,
  amount: string,
  privateKeyWIF: string,
): Promise<TxResult> {
  const keyPair   = ECPair.fromWIF(privateKeyWIF, LITECOIN_NETWORK);
  const p2wpkh    = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: LITECOIN_NETWORK });
  const fromAddress = p2wpkh.address!;

  const utxos     = await fetchUTXOs(fromAddress);
  if (utxos.length === 0) throw new Error('No UTXOs available');

  const amountLits = Math.round(parseFloat(amount) * 1e8);
  const totalIn    = utxos.reduce((s, u) => s + u.value, 0);
  const change     = totalIn - amountLits - FIXED_FEE_LITS;

  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${amountLits + FIXED_FEE_LITS} lits, have ${totalIn} lits`,
    );
  }

  const psbt = new bitcoin.Psbt({ network: LITECOIN_NETWORK });

  for (const utxo of utxos) {
    const rawHex = await fetchRawTx(utxo.txHash);
    psbt.addInput({
      hash:        utxo.txHash,
      index:       utxo.vout,
      witnessUtxo: { script: p2wpkh.output!, value: utxo.value },
    });
  }

  psbt.addOutput({ address: to, value: amountLits });

  if (change > 546) {
    psbt.addOutput({ address: fromAddress, value: change });
  }

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();

  // Broadcast via bitaps
  const broadcastRes = await fetch('https://api.bitaps.com/ltc/v1/blockchain/sendrawtransaction', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ rawTx: txHex }),
  });

  if (!broadcastRes.ok) {
    const errText = await broadcastRes.text();
    throw new Error(`Broadcast failed: ${broadcastRes.status} — ${errText}`);
  }

  const json   = await broadcastRes.json() as { data?: string };
  const txHash = json.data ?? '';

  return {
    txHash,
    success: true,
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
    raw: { amountLits, fee: FIXED_FEE_LITS, change, inputs: utxos.length },
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

export function validateLTCAddress(address: string): boolean {
  try {
    bitcoin.address.toOutputScript(address, LITECOIN_NETWORK);
    return true;
  } catch {
    return false;
  }
}
