/**
 * gem-twa — Proxy: transaction broadcast
 *
 * Accepts a signed transaction (hex or base64 depending on chain) and
 * broadcasts it to the appropriate network. Returns the transaction hash /
 * signature on success.
 */

import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// EVM RPC map (mirrors balances.ts; kept separate to avoid circular deps)
// ---------------------------------------------------------------------------

const EVM_RPC: Record<string, string> = {
  ethereum: process.env.ETH_RPC_URL  ?? 'https://eth.llamarpc.com',
  bsc:      process.env.BSC_RPC_URL  ?? 'https://bsc-dataseed1.binance.org',
  polygon:  process.env.POLY_RPC_URL ?? 'https://polygon-rpc.com',
  arbitrum: process.env.ARB_RPC_URL  ?? 'https://arb1.arbitrum.io/rpc',
  optimism: process.env.OPT_RPC_URL  ?? 'https://mainnet.optimism.io',
  base:     process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
};

// ---------------------------------------------------------------------------
// broadcastTransaction
// ---------------------------------------------------------------------------

/**
 * Broadcasts a signed transaction to the given chain's network.
 *
 * @param chain    - Chain identifier (e.g. 'ethereum', 'solana', 'ton').
 * @param signedTx - Signed transaction payload.
 *                   EVM:    0x-prefixed hex string.
 *                   Solana: base-64-encoded serialised transaction.
 *                   TON:    hex-encoded BOC (bag-of-cells).
 *                   TRON:   hex string of the raw signed tx.
 *                   Bitcoin/Litecoin/Dogecoin: hex-encoded raw transaction.
 *                   Cosmos: base-64-encoded protobuf TxRaw.
 *                   XRP:    hex-encoded signed transaction blob.
 *                   Aptos:  JSON string of the SignedTransaction.
 *                   NEAR:   base-64-encoded SignedTransaction.
 * @returns Transaction hash / signature string.
 */
export async function broadcastTransaction(
  chain:    string,
  signedTx: string,
): Promise<string> {
  // ── EVM chains ─────────────────────────────────────────────────────────────
  if (chain in EVM_RPC) {
    const provider = new ethers.JsonRpcProvider(EVM_RPC[chain]);
    const txResponse = await provider.broadcastTransaction(signedTx);
    return txResponse.hash;
  }

  // ── Solana ─────────────────────────────────────────────────────────────────
  if (chain === 'solana') {
    const { Connection, clusterApiUrl } = await import('@solana/web3.js');
    const rpc  = process.env.SOL_RPC_URL ?? clusterApiUrl('mainnet-beta');
    const conn = new Connection(rpc, 'confirmed');
    const raw  = Buffer.from(signedTx, 'base64');
    const sig  = await conn.sendRawTransaction(raw, {
      skipPreflight:       false,
      preflightCommitment: 'confirmed',
    });
    return sig;
  }

  // ── TON ────────────────────────────────────────────────────────────────────
  if (chain === 'ton') {
    const { TonClient } = await import('@ton/ton');
    const client = new TonClient({
      endpoint: process.env.TON_RPC_URL ?? 'https://toncenter.com/api/v2/jsonRPC',
      apiKey:   process.env.TON_API_KEY,
    });

    // signedTx is a hex-encoded BOC
    const bocBuffer = Buffer.from(signedTx, 'hex');
    await client.sendFile(bocBuffer);

    // TON does not return a hash from sendFile; compute it from the BOC
    const { Cell } = await import('@ton/core');
    const cell     = Cell.fromBoc(bocBuffer)[0];
    return cell.hash().toString('hex');
  }

  // ── TRON ───────────────────────────────────────────────────────────────────
  if (chain === 'tron') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TronWeb = require('tronweb') as typeof import('tronweb');
    const tronWeb = new TronWeb({
      fullHost: process.env.TRON_RPC_URL ?? 'https://api.trongrid.io',
      headers:  process.env.TRON_API_KEY
        ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
        : {},
    });
    const tx     = JSON.parse(signedTx) as object;
    const result = (await tronWeb.trx.sendRawTransaction(tx)) as { txid: string };
    return result.txid;
  }

  // ── Bitcoin ────────────────────────────────────────────────────────────────
  if (chain === 'bitcoin') {
    const res = await fetch('https://blockstream.info/api/tx', {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    signedTx,
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Bitcoin broadcast failed: ${msg}`);
    }
    return (await res.text()).trim();
  }

  // ── Litecoin ───────────────────────────────────────────────────────────────
  if (chain === 'litecoin') {
    const rpc = process.env.LTC_RPC_URL ?? 'https://api.blockchair.com/litecoin/push/transaction';
    const res = await fetch(rpc, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data: signedTx }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Litecoin broadcast failed: ${msg}`);
    }
    const data = (await res.json()) as { data: { transaction_hash: string } };
    return data.data.transaction_hash;
  }

  // ── Dogecoin ───────────────────────────────────────────────────────────────
  if (chain === 'dogecoin') {
    const rpc = process.env.DOGE_RPC_URL ?? 'https://api.blockchair.com/dogecoin/push/transaction';
    const res = await fetch(rpc, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data: signedTx }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Dogecoin broadcast failed: ${msg}`);
    }
    const data = (await res.json()) as { data: { transaction_hash: string } };
    return data.data.transaction_hash;
  }

  // ── Cosmos ─────────────────────────────────────────────────────────────────
  if (chain === 'cosmos') {
    const lcd = process.env.COSMOS_LCD_URL ?? 'https://api.cosmos.network';
    const res = await fetch(`${lcd}/cosmos/tx/v1beta1/txs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tx_bytes: signedTx,      // base64 protobuf TxRaw
        mode:     'BROADCAST_MODE_SYNC',
      }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Cosmos broadcast failed: ${msg}`);
    }
    const data = (await res.json()) as { tx_response: { txhash: string; code: number; raw_log: string } };
    if (data.tx_response.code !== 0) {
      throw new Error(`Cosmos tx error ${data.tx_response.code}: ${data.tx_response.raw_log}`);
    }
    return data.tx_response.txhash;
  }

  // ── XRP ────────────────────────────────────────────────────────────────────
  if (chain === 'xrp') {
    const node = process.env.XRP_RPC_URL ?? 'https://s1.ripple.com:51234';
    const body = {
      method: 'submit',
      params: [{ tx_blob: signedTx }],
    };
    const res = await fetch(node, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`XRP RPC error: ${res.status}`);
    const data = (await res.json()) as {
      result: { tx_json?: { hash?: string }; engine_result: string; engine_result_message: string };
    };
    if (!data.result.engine_result.startsWith('tes')) {
      throw new Error(`XRP broadcast failed: ${data.result.engine_result_message}`);
    }
    return data.result.tx_json?.hash ?? 'unknown';
  }

  // ── Aptos ──────────────────────────────────────────────────────────────────
  if (chain === 'aptos') {
    const node = process.env.APTOS_NODE_URL ?? 'https://fullnode.mainnet.aptoslabs.com/v1';
    const res  = await fetch(`${node}/transactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    signedTx, // JSON-stringified SignedTransaction
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Aptos broadcast failed: ${msg}`);
    }
    const data = (await res.json()) as { hash: string };
    return data.hash;
  }

  // ── NEAR ───────────────────────────────────────────────────────────────────
  if (chain === 'near') {
    const rpc  = process.env.NEAR_RPC_URL ?? 'https://rpc.mainnet.near.org';
    const body = {
      jsonrpc: '2.0',
      id:      'gem-twa',
      method:  'broadcast_tx_commit',
      params:  [signedTx], // base64-encoded SignedTransaction
    };
    const res = await fetch(rpc, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`NEAR RPC HTTP error: ${res.status}`);
    const data = (await res.json()) as {
      result?: { transaction: { hash: string } };
      error?:  { message: string };
    };
    if (data.error) throw new Error(`NEAR broadcast failed: ${data.error.message}`);
    return data.result?.transaction.hash ?? 'unknown';
  }

  throw new Error(`broadcastTransaction: unsupported chain "${chain}"`);
}
