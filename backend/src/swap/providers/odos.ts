/**
 * gem-twa — Odos Swap Provider (EVM aggregator, no API key required)
 *
 * Docs: https://docs.odos.xyz/
 * Quote: POST https://api.odos.xyz/sor/quote/v2
 * Assemble: POST https://api.odos.xyz/sor/assemble
 */

import { EVM_CHAIN_IDS, NATIVE_TOKEN } from './oneinch';

const QUOTE_URL = 'https://api.odos.xyz/sor/quote/v2';
const ASSEMBLE_URL = 'https://api.odos.xyz/sor/assemble';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OdosQuoteInput {
  tokenAddress: string;
  amount: string;
}

export interface OdosQuoteOutput {
  tokenAddress: string;
  proportion: number;
}

export interface OdosQuoteRequest {
  chainId: number;
  inputTokens: OdosQuoteInput[];
  outputTokens: OdosQuoteOutput[];
  userAddr: string;
  slippageLimitPercent: number;
  referralCode?: number;
}

export interface OdosQuoteResponse {
  pathId: string;
  outAmounts: string[];
  inAmounts: string[];
  gasEstimate: number;
  blockNumber: number;
}

export interface OdosAssembleRequest {
  userAddr: string;
  pathId: string;
}

export interface OdosAssembleResponse {
  transaction: {
    chainId: number;
    to: string;
    data: string;
    value: string;
    gasLimit: number;
    gasPrice: string;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function chainId(chain: string): number {
  const id = EVM_CHAIN_IDS[chain];
  if (!id) throw new Error(`Odos: unsupported chain "${chain}"`);
  return id;
}

function normalizeToken(token: string): string {
  // Odos uses 0x0000000000000000000000000000000000000000 for native tokens
  if (token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
    return '0x0000000000000000000000000000000000000000';
  }
  return token;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Odos API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a swap quote from Odos (no wallet required).
 *
 * @param chain      Network name from EVM_CHAIN_IDS (e.g. "ethereum")
 * @param fromToken  Source token address (use NATIVE_TOKEN for native)
 * @param toToken    Destination token address
 * @param amount     Amount in source token's smallest unit (wei / smallest decimal)
 * @param fromAddress User wallet address (required by Odos)
 * @param slippage   Slippage tolerance in % (default 0.5)
 */
export async function getOdosQuote(
  chain: string,
  fromToken: string,
  toToken: string,
  amount: string,
  fromAddress: string,
  slippage = 0.5,
): Promise<OdosQuoteResponse> {
  const cid = chainId(chain);

  const body: OdosQuoteRequest = {
    chainId: cid,
    inputTokens: [
      {
        tokenAddress: normalizeToken(fromToken),
        amount,
      },
    ],
    outputTokens: [
      {
        tokenAddress: normalizeToken(toToken),
        proportion: 1,
      },
    ],
    userAddr: fromAddress,
    slippageLimitPercent: slippage,
  };

  return post<OdosQuoteResponse>(QUOTE_URL, body);
}

/**
 * Build a ready-to-sign swap transaction from a quote pathId.
 *
 * @param pathId     pathId returned by getOdosQuote
 * @param fromAddress User wallet address
 */
export async function buildOdosSwap(
  pathId: string,
  fromAddress: string,
): Promise<OdosAssembleResponse> {
  const body: OdosAssembleRequest = {
    userAddr: fromAddress,
    pathId,
  };

  return post<OdosAssembleResponse>(ASSEMBLE_URL, body);
}
