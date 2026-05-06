/**
 * gem-twa — STON.fi Swap Provider (TON)
 *
 * Docs:  https://docs.ston.fi/docs/developer-section/api-reference
 * API:   https://api.ston.fi/v1/
 *
 * STON.fi requires on-chain messages to be sent directly from the user's TON
 * wallet (jetton transfer with custom forward payload). This provider covers
 * the quote/simulation step; the actual transaction payload must be signed and
 * sent by the TON signer module.
 */

const STONFI_BASE = 'https://api.ston.fi/v1';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface STONfiSimulateResult {
  /** Human-readable offer amount (input) */
  offer_address: string;
  offer_units: string;
  /** Human-readable ask amount (output) */
  ask_address: string;
  ask_units: string;
  /** Slippage tolerance in basis-points form */
  slippage_tolerance: string;
  min_ask_units: string;
  /** Router/pool address used */
  router_address: string;
  pool_address: string;
  /** Price impact as a decimal fraction, e.g. "0.0012" */
  price_impact: string;
  /** Fee charged in offer token units */
  fee_units: string;
  fee_percent: string;
  /** Exchange rate: 1 offerToken = X askToken */
  swap_rate: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function post<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${STONFI_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`STON.fi API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${STONFI_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`STON.fi API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Simulate a swap on STON.fi to get a price quote.
 *
 * @param offerAddress  Jetton master address of the input token
 *                      (use "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" for native TON)
 * @param askAddress    Jetton master address of the output token
 * @param offerAmount   Amount in nano-units (nanoTON or jetton base unit)
 * @param slippage      Slippage tolerance in percent (default "0.5")
 */
export async function getSTONfiQuote(
  offerAddress: string,
  askAddress: string,
  offerAmount: string,
  slippage = '0.5',
): Promise<STONfiSimulateResult> {
  const data = await post<{ simulate_swap: STONfiSimulateResult }>(
    '/swap/simulate',
    {
      offer_address: offerAddress,
      ask_address: askAddress,
      units: offerAmount,
      slippage_tolerance: slippage,
    },
  );

  return data.simulate_swap;
}

/**
 * Fetch the STON.fi token/asset list.
 * Cached externally (route layer handles 1-hour cache).
 */
export async function getSTONfiTokenList(): Promise<
  Array<{ contract_address: string; symbol: string; display_name: string; decimals: number; image_url: string }>
> {
  const data = await get<{ asset_list: Array<{ contract_address: string; symbol: string; display_name: string; decimals: number; image_url: string }> }>(
    '/assets',
  );
  return data.asset_list;
}
