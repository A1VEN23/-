/**
 * gem-twa — Proxy: on-chain balances
 *
 * Provides getBalance() and getTokenBalances() for every supported chain.
 * All results are cached (30 s) and requests are retried up to 3× with
 * exponential back-off to absorb transient RPC hiccups.
 */

import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Cache — 30-second TTL
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  ts: number;
}

const CACHE_TTL_MS = 30_000;

const balanceCache    = new Map<string, CacheEntry<number>>();
const tokenCache      = new Map<string, CacheEntry<TokenBalance[]>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { value, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Retry helper — 3 attempts, exponential back-off (500 ms, 1 000 ms, 2 000 ms)
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise<void>((res) => setTimeout(res, 500 * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Token balance type
// ---------------------------------------------------------------------------

export interface TokenBalance {
  symbol: string;
  name: string;
  balance: number;
  balanceUsd: number;
  contractAddress: string;
}

// ---------------------------------------------------------------------------
// RPC endpoints
// ---------------------------------------------------------------------------

const EVM_RPC: Record<string, string> = {
  ethereum: process.env.ETH_RPC_URL  ?? 'https://eth.llamarpc.com',
  bsc:      process.env.BSC_RPC_URL  ?? 'https://bsc-dataseed1.binance.org',
  polygon:  process.env.POLY_RPC_URL ?? 'https://polygon-rpc.com',
  arbitrum: process.env.ARB_RPC_URL  ?? 'https://arb1.arbitrum.io/rpc',
  optimism: process.env.OPT_RPC_URL  ?? 'https://mainnet.optimism.io',
  base:     process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
};

function getEvmProvider(chain: string): ethers.JsonRpcProvider {
  const url = EVM_RPC[chain];
  if (!url) throw new Error(`No EVM RPC configured for chain: ${chain}`);
  return new ethers.JsonRpcProvider(url);
}

// Minimal ERC-20 ABI for balance + metadata queries
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

// ERC-20 Transfer topic
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// ---------------------------------------------------------------------------
// getBalance
// ---------------------------------------------------------------------------

/**
 * Returns the native-coin balance (in human-readable units, e.g. ETH not wei)
 * for the given chain and address.
 */
export async function getBalance(chain: string, address: string): Promise<number> {
  const key = `${chain}:${address}`;
  const cached = cacheGet(balanceCache, key);
  if (cached !== null) return cached;

  const value = await withRetry(async () => {
    // ── EVM chains ──────────────────────────────────────────────────────────
    if (chain in EVM_RPC) {
      const provider = getEvmProvider(chain);
      const raw = await provider.getBalance(address);
      return parseFloat(ethers.formatEther(raw));
    }

    // ── Solana ──────────────────────────────────────────────────────────────
    if (chain === 'solana') {
      const { Connection, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const rpc = process.env.SOL_RPC_URL ?? clusterApiUrl('mainnet-beta');
      const conn = new Connection(rpc, 'confirmed');
      const lamports = await conn.getBalance(new PublicKey(address));
      return lamports / LAMPORTS_PER_SOL;
    }

    // ── TON ─────────────────────────────────────────────────────────────────
    if (chain === 'ton') {
      const { TonClient, Address } = await import('@ton/ton');
      const client = new TonClient({
        endpoint: process.env.TON_RPC_URL ?? 'https://toncenter.com/api/v2/jsonRPC',
        apiKey:   process.env.TON_API_KEY,
      });
      const state = await client.getContractState(Address.parse(address));
      // balance is in nanotons
      return Number(state.balance) / 1e9;
    }

    // ── TRON ─────────────────────────────────────────────────────────────────
    if (chain === 'tron') {
      // Dynamic import — tronweb is optional
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const TronWeb = require('tronweb') as typeof import('tronweb');
      const tronWeb = new TronWeb({
        fullHost: process.env.TRON_RPC_URL ?? 'https://api.trongrid.io',
        headers:  process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
      });
      const sunBalance = await tronWeb.trx.getBalance(address);
      return sunBalance / 1_000_000; // SUN → TRX
    }

    // ── Bitcoin ──────────────────────────────────────────────────────────────
    if (chain === 'bitcoin') {
      const url = `https://blockstream.info/api/address/${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Blockstream API error: ${res.status}`);
      const data = (await res.json()) as {
        chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
      };
      const satoshis =
        data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
      return satoshis / 1e8;
    }

    // ── Litecoin ─────────────────────────────────────────────────────────────
    if (chain === 'litecoin') {
      const url = `https://api.blockchair.com/litecoin/dashboards/address/${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Blockchair API error: ${res.status}`);
      const data = (await res.json()) as {
        data: Record<string, { address: { balance: number } }>;
      };
      const entry = data.data[address];
      return (entry?.address?.balance ?? 0) / 1e8;
    }

    // ── Dogecoin ─────────────────────────────────────────────────────────────
    if (chain === 'dogecoin') {
      const url = `https://api.blockchair.com/dogecoin/dashboards/address/${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Blockchair API error: ${res.status}`);
      const data = (await res.json()) as {
        data: Record<string, { address: { balance: number } }>;
      };
      const entry = data.data[address];
      return (entry?.address?.balance ?? 0) / 1e8;
    }

    // ── Cosmos ───────────────────────────────────────────────────────────────
    if (chain === 'cosmos') {
      const lcd = process.env.COSMOS_LCD_URL ?? 'https://api.cosmos.network';
      const url = `${lcd}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Cosmos LCD error: ${res.status}`);
      const data = (await res.json()) as { balances: Array<{ denom: string; amount: string }> };
      const uatom = data.balances.find((b) => b.denom === 'uatom');
      return uatom ? parseInt(uatom.amount, 10) / 1e6 : 0;
    }

    // ── XRP ──────────────────────────────────────────────────────────────────
    if (chain === 'xrp') {
      const url = `https://api.xrpscan.com/api/v1/account/${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`XRPScan API error: ${res.status}`);
      const data = (await res.json()) as { xrpBalance: string };
      return parseFloat(data.xrpBalance ?? '0');
    }

    // ── Aptos ────────────────────────────────────────────────────────────────
    if (chain === 'aptos') {
      const node = process.env.APTOS_NODE_URL ?? 'https://fullnode.mainnet.aptoslabs.com/v1';
      const url = `${node}/accounts/${encodeURIComponent(address)}/resource/0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return 0;
        throw new Error(`Aptos node error: ${res.status}`);
      }
      const data = (await res.json()) as { data: { coin: { value: string } } };
      return parseInt(data.data.coin.value, 10) / 1e8;
    }

    // ── NEAR ─────────────────────────────────────────────────────────────────
    if (chain === 'near') {
      const rpc = process.env.NEAR_RPC_URL ?? 'https://rpc.mainnet.near.org';
      const body = {
        jsonrpc: '2.0',
        id:      'gem-twa',
        method:  'query',
        params: {
          request_type: 'view_account',
          finality:     'final',
          account_id:   address,
        },
      };
      const res = await fetch(rpc, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`NEAR RPC error: ${res.status}`);
      const data = (await res.json()) as { result?: { amount: string }; error?: unknown };
      if (data.error) throw new Error(`NEAR RPC error: ${JSON.stringify(data.error)}`);
      // amount is in yoctoNEAR (10^24)
      return Number(BigInt(data.result?.amount ?? '0') / BigInt(1e18)) / 1e6;
    }

    throw new Error(`Unsupported chain: ${chain}`);
  });

  cacheSet(balanceCache, key, value);
  return value;
}

// ---------------------------------------------------------------------------
// getTokenBalances
// ---------------------------------------------------------------------------

/**
 * Returns token balances for the given chain and address.
 * Only tokens that have been transferred to/from the address are included
 * (detected via on-chain event logs / RPC calls).
 */
export async function getTokenBalances(
  chain: string,
  address: string,
): Promise<TokenBalance[]> {
  const key = `tokens:${chain}:${address}`;
  const cached = cacheGet(tokenCache, key);
  if (cached !== null) return cached;

  const value = await withRetry(async (): Promise<TokenBalance[]> => {
    // ── EVM chains ──────────────────────────────────────────────────────────
    if (chain in EVM_RPC) {
      const provider = getEvmProvider(chain);

      // Gather token addresses from Transfer logs (last 10 000 blocks)
      const currentBlock = await provider.getBlockNumber();
      const fromBlock    = Math.max(0, currentBlock - 10_000);

      const logs = await provider.getLogs({
        fromBlock,
        toBlock: 'latest',
        topics:  [
          TRANSFER_TOPIC,
          null,
          ethers.zeroPadValue(address.toLowerCase(), 32),
        ],
      });

      const contractAddresses = [...new Set(logs.map((l) => l.address))];

      const results: TokenBalance[] = [];

      await Promise.allSettled(
        contractAddresses.map(async (contractAddress) => {
          try {
            const token   = new ethers.Contract(contractAddress, ERC20_ABI, provider);
            const [rawBal, decimals, symbol, name] = await Promise.all([
              token.balanceOf(address) as Promise<bigint>,
              token.decimals()         as Promise<number>,
              token.symbol()           as Promise<string>,
              token.name()             as Promise<string>,
            ]);
            const balance = parseFloat(ethers.formatUnits(rawBal, decimals));
            if (balance > 0) {
              results.push({ symbol, name, balance, balanceUsd: 0, contractAddress });
            }
          } catch {
            // Skip tokens that revert or don't implement ERC-20 properly
          }
        }),
      );

      return results;
    }

    // ── Solana ──────────────────────────────────────────────────────────────
    if (chain === 'solana') {
      const { Connection, PublicKey, clusterApiUrl } = await import('@solana/web3.js');
      const { TOKEN_PROGRAM_ID }                     = await import('@solana/spl-token');

      const rpc  = process.env.SOL_RPC_URL ?? clusterApiUrl('mainnet-beta');
      const conn = new Connection(rpc, 'confirmed');

      const accounts = await conn.getTokenAccountsByOwner(new PublicKey(address), {
        programId: TOKEN_PROGRAM_ID,
      });

      const results: TokenBalance[] = [];

      for (const { account } of accounts.value) {
        try {
          // Parse SPL token account data (layout: mint[32], owner[32], amount[8], ...)
          const data   = account.data;
          const amount = data.readBigUInt64LE(64);
          if (amount === 0n) continue;

          const mint = new PublicKey(data.slice(0, 32)).toBase58();

          // Fetch metadata via Token Metadata program (best-effort)
          let symbol = mint.slice(0, 6);
          let name   = `SPL-${mint.slice(0, 8)}`;

          try {
            const metaRes = await fetch(
              `https://token.jup.ag/strict`,
            );
            if (metaRes.ok) {
              const list = (await metaRes.json()) as Array<{
                address: string;
                symbol:  string;
                name:    string;
                decimals: number;
              }>;
              const meta = list.find((t) => t.address === mint);
              if (meta) {
                symbol = meta.symbol;
                name   = meta.name;
                results.push({
                  symbol,
                  name,
                  balance:         Number(amount) / Math.pow(10, meta.decimals),
                  balanceUsd:      0,
                  contractAddress: mint,
                });
                continue;
              }
            }
          } catch {
            // ignore — fall through with raw values
          }

          results.push({
            symbol,
            name,
            balance:         Number(amount) / 1e6, // assume 6 decimals as fallback
            balanceUsd:      0,
            contractAddress: mint,
          });
        } catch {
          // skip malformed accounts
        }
      }

      return results;
    }

    // ── TON — Jetton API ────────────────────────────────────────────────────
    if (chain === 'ton') {
      const apiBase = process.env.TONAPI_URL ?? 'https://tonapi.io/v2';
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (process.env.TONAPI_KEY) {
        headers['Authorization'] = `Bearer ${process.env.TONAPI_KEY}`;
      }

      const res = await fetch(
        `${apiBase}/accounts/${encodeURIComponent(address)}/jettons`,
        { headers },
      );
      if (!res.ok) throw new Error(`TON API error: ${res.status}`);

      const data = (await res.json()) as {
        balances: Array<{
          balance:       string;
          jetton: {
            address:  string;
            name:     string;
            symbol:   string;
            decimals: number;
          };
        }>;
      };

      return (data.balances ?? [])
        .map((item) => ({
          symbol:          item.jetton.symbol,
          name:            item.jetton.name,
          balance:         parseInt(item.balance, 10) / Math.pow(10, item.jetton.decimals),
          balanceUsd:      0,
          contractAddress: item.jetton.address,
        }))
        .filter((t) => t.balance > 0);
    }

    // ── TRON — TronGrid TRC-20 ───────────────────────────────────────────────
    if (chain === 'tron') {
      const apiBase = process.env.TRONGRID_URL ?? 'https://api.trongrid.io';
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (process.env.TRON_API_KEY) {
        headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
      }

      const res = await fetch(
        `${apiBase}/v1/accounts/${encodeURIComponent(address)}/tokens?token_id=0&limit=200`,
        { headers },
      );
      if (!res.ok) throw new Error(`TronGrid API error: ${res.status}`);

      const data = (await res.json()) as {
        data?: Array<{
          tokenName:     string;
          tokenAbbr:     string;
          tokenId:       string;
          tokenDecimal:  number;
          balance:       string;
        }>;
      };

      return (data.data ?? [])
        .filter((t) => t.tokenId !== '_') // skip TRX native
        .map((t) => ({
          symbol:          t.tokenAbbr,
          name:            t.tokenName,
          balance:         parseInt(t.balance, 10) / Math.pow(10, t.tokenDecimal),
          balanceUsd:      0,
          contractAddress: t.tokenId,
        }))
        .filter((t) => t.balance > 0);
    }

    // For chains without token support, return empty array
    return [];
  });

  cacheSet(tokenCache, key, value);
  return value;
}
