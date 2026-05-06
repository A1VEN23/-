/**
 * gem-twa — Jupiter Swap Provider (Solana)
 *
 * Docs:  https://station.jup.ag/docs/apis/swap-api
 * Quote: GET  https://quote-api.jup.ag/v6/quote
 * Swap:  POST https://quote-api.jup.ag/v6/swap  → returns base64 serialised tx
 */

const QUOTE_BASE = 'https://quote-api.jup.ag/v6';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JupiterRoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: JupiterRoutePlan[];
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapResponse {
  /** Base64-encoded serialised versioned transaction */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Jupiter GET ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Jupiter POST ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the best quote from Jupiter aggregator.
 *
 * @param inputMint   Source SPL token mint address (or SOL: "So11111111111111111111111111111111111111112")
 * @param outputMint  Destination SPL token mint address
 * @param amount      Amount in lamports (or token's base unit)
 * @param slippage    Slippage in basis points (default 50 = 0.5%)
 */
export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippage = 50,
): Promise<JupiterQuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippage.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });

  return get<JupiterQuoteResponse>(`${QUOTE_BASE}/quote?${params}`);
}

/**
 * Build a swap transaction from a Jupiter quote.
 *
 * Returns a base64-encoded versioned transaction that can be deserialized,
 * signed with the user's keypair, and broadcast.
 *
 * @param quoteResponse  Full quote object returned by getJupiterQuote
 * @param userPublicKey  Base58 Solana public key of the signer
 */
export async function buildJupiterSwap(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
): Promise<JupiterSwapResponse> {
  return post<JupiterSwapResponse>(`${QUOTE_BASE}/swap`, {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  });
}

/**
 * Fetch the Jupiter verified token list.
 * Cached externally (route layer handles 1-hour cache).
 */
export async function getJupiterTokenList(): Promise<
  Array<{ address: string; symbol: string; name: string; decimals: number; logoURI: string }>
> {
  // Strict list (vetted tokens only)
  return get('https://token.jup.ag/strict');
}
