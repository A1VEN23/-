/**
 * TON signer — @ton/ton
 *
 * Wallet:    WalletContractV4  (most widely supported)
 * Endpoint:  https://toncenter.com/api/v2/jsonRPC
 * Address:   non-bounceable (bounceable = false)
 */

import {
  TonClient,
  WalletContractV4,
  internal,
  toNano,
  Address,
  beginCell,
  Cell,
  JettonMaster,
  JettonWallet,
} from '@ton/ton';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import type { WalletData, TxResult } from '../types';

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: TonClient | null = null;

function getClient(): TonClient {
  if (!_client) {
    _client = new TonClient({
      endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate a TON wallet (WalletContractV4).
 * Pass an existing 24-word mnemonic to restore; omit to create a fresh one.
 */
export async function generateTONWallet(mnemonic?: string): Promise<WalletData> {
  const words: string[] = mnemonic ? mnemonic.trim().split(/\s+/) : await mnemonicNew(24);

  const keyPair = await mnemonicToPrivateKey(words);

  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  // Non-bounceable address (user-facing)
  const address = wallet.address.toString({ bounceable: false, urlSafe: true });

  // Encode keys as hex strings for storage / transport
  const privateKeyHex = Buffer.from(keyPair.secretKey).toString('hex');
  const publicKeyHex  = Buffer.from(keyPair.publicKey).toString('hex');

  return {
    address,
    privateKey: privateKeyHex,
    publicKey:  publicKeyHex,
    mnemonic:   words.join(' '),
    chain:      'ton',
    derivationPath: 'TON standard (BIP-39 mnemonic, no HD path)',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reconstruct key pair from the 64-byte secret key hex stored in WalletData */
async function keyPairFromPrivateKeyHex(privateKeyHex: string) {
  const secretKey = Buffer.from(privateKeyHex, 'hex');
  // @ton/crypto key pair: { publicKey: Uint8Array, secretKey: Uint8Array }
  // secretKey is 64 bytes: first 32 = private, last 32 = public
  const publicKey = secretKey.subarray(32);
  return { secretKey, publicKey };
}

async function openWalletContract(publicKey: Buffer) {
  const client = getClient();
  const wallet = WalletContractV4.create({ workchain: 0, publicKey });
  return client.open(wallet);
}

// ---------------------------------------------------------------------------
// Native TON transfer
// ---------------------------------------------------------------------------

/**
 * Send TON to an address.
 *
 * @param to         Destination address (bounceable or non-bounceable).
 * @param amount     Amount in TON (e.g. "1.5").
 * @param privateKey 64-byte secret key hex (from WalletData.privateKey).
 * @param memo       Optional comment / memo text.
 */
export async function sendTON(
  to: string,
  amount: string,
  privateKey: string,
  memo?: string
): Promise<TxResult> {
  const keyPair = await keyPairFromPrivateKeyHex(privateKey);
  const opened  = await openWalletContract(Buffer.from(keyPair.publicKey));

  const seqno = await opened.getSeqno();

  // Build optional comment body
  let body: Cell | undefined;
  if (memo) {
    body = beginCell()
      .storeUint(0, 32) // op = 0 → text comment
      .storeStringTail(memo)
      .endCell();
  }

  const transfer = opened.createTransfer({
    seqno,
    secretKey: Buffer.from(keyPair.secretKey),
    messages: [
      internal({
        to:     Address.parse(to),
        value:  toNano(amount),
        bounce: false,
        body,
      }),
    ],
  });

  await opened.send(transfer);

  // TON has no synchronous tx hash at broadcast time; derive from boc hash
  const txHash = Buffer.from(transfer.hash()).toString('hex');

  return {
    txHash,
    success: true,
    explorerUrl: `https://tonscan.org/tx/${txHash}`,
    raw: { seqno },
  };
}

// ---------------------------------------------------------------------------
// Jetton (TRC-20 equivalent) transfer
// ---------------------------------------------------------------------------

/**
 * Send a Jetton token.
 *
 * @param jettonMasterAddress  Address of the Jetton master contract.
 * @param to                   Destination wallet address.
 * @param amount               Amount in nano-jettons (smallest unit).
 * @param privateKey           64-byte secret key hex.
 */
export async function sendJetton(
  jettonMasterAddress: string,
  to: string,
  amount: string,
  privateKey: string
): Promise<TxResult> {
  const client  = getClient();
  const keyPair = await keyPairFromPrivateKeyHex(privateKey);
  const opened  = await openWalletContract(Buffer.from(keyPair.publicKey));

  // Resolve the sender's Jetton wallet address
  const jettonMaster = client.open(
    JettonMaster.create(Address.parse(jettonMasterAddress))
  );
  const senderJettonWalletAddr = await jettonMaster.getWalletAddress(opened.address);
  const senderJettonWallet     = client.open(JettonWallet.create(senderJettonWalletAddr));

  const seqno = await opened.getSeqno();

  // Jetton transfer message body (TEP-74)
  const forwardPayload = beginCell().endCell(); // empty forward payload

  const jettonTransferBody = beginCell()
    .storeUint(0x0f8a7ea5, 32)          // op: jetton transfer
    .storeUint(0, 64)                   // query_id
    .storeCoins(BigInt(amount))         // jetton amount
    .storeAddress(Address.parse(to))    // destination
    .storeAddress(opened.address)       // response_destination (excess fees back)
    .storeBit(false)                    // no custom payload
    .storeCoins(toNano('0.00000001'))   // forward_ton_amount (min notification)
    .storeBit(false)                    // forward_payload in this cell
    .storeBuilder(forwardPayload.asBuilder())
    .endCell();

  const transfer = opened.createTransfer({
    seqno,
    secretKey: Buffer.from(keyPair.secretKey),
    messages: [
      internal({
        to:    senderJettonWallet.address,
        value: toNano('0.05'), // attach 0.05 TON for gas
        body:  jettonTransferBody,
      }),
    ],
  });

  await opened.send(transfer);

  const txHash = Buffer.from(transfer.hash()).toString('hex');

  return {
    txHash,
    success: true,
    explorerUrl: `https://tonscan.org/tx/${txHash}`,
    raw: { seqno, jettonMasterAddress, senderJettonWallet: senderJettonWalletAddr.toString() },
  };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the string is a valid TON address (bounceable or non-bounceable).
 */
export function validateTONAddress(address: string): boolean {
  try {
    Address.parse(address);
    return true;
  } catch {
    return false;
  }
}
