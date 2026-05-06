/**
 * Dogecoin signer — bitcoinjs-lib with custom network params
 *
 * Address type:    P2PKH (legacy, "D…")
 * Derivation path: m/44'/3'/0'/0/0  (BIP-44, coin type 3 = DOGE)
 * UTXO provider:   https://api.bitaps.com/doge/v1/blockchain
 * Fixed fee:       1 000 000 koinus  = 1 DOGE
 */

import * as bitcoin    from 'bitcoinjs-lib';
import * as bip39      from 'bip39';
import * as ecc        from 'tiny-secp256k1';
import { BIP32Factory }  from 'bip32';
import { ECPairFactory } from 'ecpair';
import type { WalletData, TxResult } from '../types';

bitcoin.initEccLib(ecc);

const ECPair = ECPairFactory(ecc);
const bip32  = BIP32Factory(ecc);

// ---------------------------------------------------------------------------
// Dogecoin network parameters
// ---------------------------------------------------------------------------

const DOGECOIN_NETWORK: bitcoin.networks.Network = {
  messagePrefix: '\x19Dogecoin Signed Message:\n',
  bech32:        'doge',   // not used (no SegWit), but required by type
  bip32: {
    public:  0x02facafd,
    private: 0x02fac398,
  },
  pubKeyHash: 0x1e,        // 'D' addresses
  scriptHash: 0x16,        // 'A' addresses
  wif:        0x9e,
};

const DERIVATION_PATH = "m/44'/3'/0'/0/0";
const FIXED_FEE_KOIN  = 1_000_000; // koinus (1 DOGE)
const EXPLORER_URL    = 'https://dogechain.info';

// ---------------------------------------------------------------------------
// UTXO provider — bitaps.com
// ---------------------------------------------------------------------------

interface BitapsUTXO {
  txHash: string;
  vout:   number;
  value:  number; // koinus
}

async function fetchUTXOs(address: string): Promise<BitapsUTXO[]> {
  const res = await fetch(
    `https://api.bitaps.com/doge/v1/blockchain/address/transactions/${address}?mode=unspent`,
  );
  if (!res.ok) throw new Error(`Bitaps UTXO fetch failed: ${res.status}`);
  const json = await res.json() as { data?: { list?: BitapsUTXO[] } };
  return json.data?.list ?? [];
}

async function fetchRawTx(txHash: string): Promise<string> {
  const res = await fetch(
    `https://api.bitaps.com/doge/v1/blockchain/transaction/${txHash}/raw`,
  );
  if (!res.ok) throw new Error(`Raw tx fetch failed: ${res.status}`);
  const json = await res.json() as { data?: string };
  if (!json.data) throw new Error('No raw tx data');
  return json.data;
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

export async function generateDOGEWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);
  if (!bip39.validateMnemonic(phrase)) throw new Error('Invalid mnemonic phrase');

  const seed  = await bip39.mnemonicToSeed(phrase);
  const root  = bip32.fromSeed(seed, DOGECOIN_NETWORK);
  const child = root.derivePath(DERIVATION_PATH);

  if (!child.privateKey) throw new Error('Could not derive private key');

  // Dogecoin uses P2PKH (no SegWit)
  const { address } = bitcoin.payments.p2pkh({
    pubkey:  child.publicKey,
    network: DOGECOIN_NETWORK,
  });

  if (!address) throw new Error('Could not derive P2PKH address');

  return {
    address,
    privateKey:     child.toWIF(),
    publicKey:      child.publicKey.toString('hex'),
    mnemonic:       phrase,
    chain:          'dogecoin',
    derivationPath: DERIVATION_PATH,
  };
}

// ---------------------------------------------------------------------------
// Send DOGE
// ---------------------------------------------------------------------------

/**
 * Transfer DOGE to a destination address.
 *
 * @param to            Destination Dogecoin address (D…).
 * @param amount        Amount in DOGE (e.g. "100").
 * @param privateKeyWIF WIF-encoded private key (WalletData.privateKey).
 */
export async function sendDOGE(
  to: string,
  amount: string,
  privateKeyWIF: string,
): Promise<TxResult> {
  const keyPair     = ECPair.fromWIF(privateKeyWIF, DOGECOIN_NETWORK);
  const p2pkh       = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: DOGECOIN_NETWORK });
  const fromAddress = p2pkh.address!;

  const utxos   = await fetchUTXOs(fromAddress);
  if (utxos.length === 0) throw new Error('No UTXOs available');

  const amountKoin = Math.round(parseFloat(amount) * 1e8);
  const totalIn    = utxos.reduce((s, u) => s + u.value, 0);
  const change     = totalIn - amountKoin - FIXED_FEE_KOIN;

  if (change < 0) {
    throw new Error(
      `Insufficient funds. Need ${amountKoin + FIXED_FEE_KOIN} koinus, have ${totalIn}`,
    );
  }

  const psbt = new bitcoin.Psbt({ network: DOGECOIN_NETWORK });

  for (const utxo of utxos) {
    // Dogecoin is pre-SegWit → we need full nonWitnessUtxo
    const rawHex = await fetchRawTx(utxo.txHash);
    psbt.addInput({
      hash:             utxo.txHash,
      index:            utxo.vout,
      nonWitnessUtxo:   Buffer.from(rawHex, 'hex'),
    });
  }

  psbt.addOutput({ address: to, value: amountKoin });

  if (change > 0) {
    psbt.addOutput({ address: fromAddress, value: change });
  }

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();

  // Broadcast via bitaps
  const broadcastRes = await fetch(
    'https://api.bitaps.com/doge/v1/blockchain/sendrawtransaction',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rawTx: txHex }),
    },
  );

  if (!broadcastRes.ok) {
    const errText = await broadcastRes.text();
    throw new Error(`Broadcast failed: ${broadcastRes.status} — ${errText}`);
  }

  const json   = await broadcastRes.json() as { data?: string };
  const txHash = json.data ?? '';

  return {
    txHash,
    success:     true,
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
    raw: { amountKoin, fee: FIXED_FEE_KOIN, change, inputs: utxos.length },
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

export function validateDOGEAddress(address: string): boolean {
  try {
    bitcoin.address.toOutputScript(address, DOGECOIN_NETWORK);
    return true;
  } catch {
    return false;
  }
}
