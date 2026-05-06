/**
 * gem-twa — 1inch Swap Provider
 *
 * Docs: https://docs.1inch.io/docs/aggregation-protocol/api/swagger
 * Base: https://api.1inch.dev/swap/v6.0/{chainId}
 *
 * Requires:  ONEINCH_API_KEY  env variable (Bearer token)
 */

const BASE = 'https://api.1inch.dev/swap/v6.0';

export const EVM_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
};

// Native token address used by 1inch for ETH/BNB/MATIC etc.
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OneInchQuote {
  fromToken: { address: string; symbol: string; decimals: number };
  toToken: { address: string; symbol: string; decimals: number };
  fromTokenAmount: string;
  toTokenAmount: string;
  estimatedGas: number;
  protocols: unknown[];
}

export interface OneInchSwapTx {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: number;
  gasPrice: string;
}

export interface OneInchSwapResponse {
  toTokenAmount: string;
  fromTokenAmount: string;
  tx: OneInchSwapTx;
  protocols: unknown[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.ONEINCH_API_KEY;
  if (!key) throw new Error('ONEINCH_API_KEY env variable is not set');
  return key;
}

function chainId(chain: string): number {
  const id = EVM_CHAIN_IDS[chain];
  if (!id) throw new Error(`1inch: unsupported chain "${chain}"`);
  return id;
}

async function request<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`1inch API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a quote (no wallet required).
 *
 * @param chain      Network name from EVM_CHAIN_IDS (e.g. "ethereum")
 * @param fromToken  Source token address (use NATIVE_TOKEN for native)
 * @param toToken    Destination token address
 * @param amount     Amount in source token's smallest unit (wei / smallest decimal)
 * @param slippage   Slippage tolerance in % (default 0.5)
 */
export async function getOneInchQuote(
  chain: string,
  fromToken: string,
  toToken: string,
  amount: string,
  slippage = 0.5,
): Promise<OneInchQuote> {
  const cid = chainId(chain);
  const params = new URLSearchParams({
    src: fromToken,
    dst: toToken,
    amount,
    slippage: slippage.toString(),
    includeProtocols: 'true',
    includeGas: 'true',
  });

  return request<OneInchQuote>(`${BASE}/${cid}/quote?${params}`);
}

/**
 * Build a ready-to-sign swap transaction.
 *
 * @param chain       Network name
 * @param fromToken   Source token address
 * @param toToken     Destination token address
 * @param amount      Amount in source token's smallest unit
 * @param fromAddress Sender / signer wallet address
 * @param slippage    Slippage tolerance in % (default 0.5)
 */
export async function buildOneInchSwap(
  chain: string,
  fromToken: string,
  toToken: string,
  amount: string,
  fromAddress: string,
  slippage = 0.5,
): Promise<OneInchSwapResponse> {
  const cid = chainId(chain);
  const params = new URLSearchParams({
    src: fromToken,
    dst: toToken,
    amount,
    from: fromAddress,
    slippage: slippage.toString(),
    disableEstimate: 'false',
    allowPartialFill: 'false',
    includeProtocols: 'true',
  });

  return request<OneInchSwapResponse>(`${BASE}/${cid}/swap?${params}`);
}

/**
 * Fetch the 1inch token list for a given chain.
 * Cached externally (route layer handles 1-hour cache).
 */
export async function getOneInchTokenList(
  chain: string,
): Promise<Record<string, { symbol: string; name: string; address: string; decimals: number; logoURI: string }>> {
  const cid = chainId(chain);
  const data = await request<{ tokens: Record<string, unknown> }>(
    `${BASE}/${cid}/tokens`,
  );
  return data.tokens as Record<string, { symbol: string; name: string; address: string; decimals: number; logoURI: string }>;
}
