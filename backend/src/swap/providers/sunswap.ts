/**
 * gem-twa — SunSwap Swap Provider (TRON)
 *
 * Docs:  https://github.com/sunswap-io/sunswap-v2-periphery
 * API:   https://rot.endjgfsv.link/swap/router  (official SunSwap routing API)
 *
 * SunSwap transactions are ultimately signed with the user's TRON private key
 * and broadcast via TronWeb. This provider handles the routing/quote step.
 */

const SUNSWAP_ROUTER_URL = 'https://rot.endjgfsv.link/swap/router';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SunSwapRouterPath {
  /** Token addresses along the route */
  tokens: string[];
  /** Intermediate pool types (e.g. "v2", "v3", "stable") */
  poolTypes?: string[];
}

export interface SunSwapQuoteResult {
  /** Amount received by the user (after fees), in token base units */
  amountOut: string;
  /** Minimum amount out after slippage */
  amountOutMin: string;
  /** Price impact as decimal fraction, e.g. "0.0012" */
  priceImpact: string;
  /** Fee in percent */
  tradeFee: string;
  /** Best route path details */
  routePath: SunSwapRouterPath;
  /** Router contract address to call */
  routerAddress: string;
  /** Encoded call data for the swap (hex) */
  callData?: string;
  /** Raw response from the router API */
  raw: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchRouter(params: URLSearchParams): Promise<unknown> {
  const url = `${SUNSWAP_ROUTER_URL}?${params}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`SunSwap router ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the best swap route from SunSwap.
 *
 * @param fromToken  Source token address on TRON (TRC-20 address, or "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" for TRX native)
 * @param toToken    Destination token address on TRON
 * @param amountIn   Input amount in token base units (sun for TRX = 1e-6 TRX)
 * @param slippage   Slippage tolerance in percent (default "0.5")
 */
export async function getSunSwapQuote(
  fromToken: string,
  toToken: string,
  amountIn: string,
  slippage = '0.5',
): Promise<SunSwapQuoteResult> {
  const params = new URLSearchParams({
    fromToken,
    toToken,
    amountIn,
    slippage,
    // Request all route types
    typeList: 'v2,v3,stable,mixed',
  });

  const raw = await fetchRouter(params) as {
    data?: {
      amountOut?: string;
      amountOutMin?: string;
      priceImpact?: string;
      tradeFee?: string;
      routePath?: SunSwapRouterPath;
      routerAddress?: string;
      callData?: string;
    };
    code?: number;
    message?: string;
  };

  if (raw.code !== undefined && raw.code !== 0) {
    throw new Error(`SunSwap router error: ${raw.message ?? JSON.stringify(raw)}`);
  }

  const d = raw.data ?? {};

  return {
    amountOut: d.amountOut ?? '0',
    amountOutMin: d.amountOutMin ?? '0',
    priceImpact: d.priceImpact ?? '0',
    tradeFee: d.tradeFee ?? '0',
    routePath: d.routePath ?? { tokens: [fromToken, toToken] },
    routerAddress: d.routerAddress ?? '',
    callData: d.callData,
    raw,
  };
}
