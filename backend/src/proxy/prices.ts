/**
 * gem-twa — Proxy: coin prices via CoinGecko
 *
 * Fetches USD / EUR / RUB prices with a 60-second cache and a fallback to the
 * last successfully retrieved values so the UI never shows blank prices during
 * a CoinGecko outage.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoinPrice {
  usd: number;
  eur: number;
  rub: number;
}

export type PriceMap = Record<string, CoinPrice>;

// ---------------------------------------------------------------------------
// Chain → CoinGecko coin-ID mapping
// ---------------------------------------------------------------------------

export const COIN_IDS: Record<string, string> = {
  ethereum:  'ethereum',
  bsc:       'binancecoin',
  polygon:   'matic-network',
  arbitrum:  'ethereum',
  optimism:  'ethereum',
  base:      'ethereum',
  solana:    'solana',
  ton:       'the-open-network',
  tron:      'tron',
  bitcoin:   'bitcoin',
  litecoin:  'litecoin',
  dogecoin:  'dogecoin',
  cosmos:    'cosmos',
  xrp:       'ripple',
  aptos:     'aptos',
  near:      'near',
};

// ---------------------------------------------------------------------------
// Cache — 60-second TTL + "last known" fallback
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: PriceMap;
  ts:    number;
}

const CACHE_TTL_MS = 60_000;

let priceCache:    CacheEntry | null = null;
let lastKnownPrices: PriceMap       = {};

function isFresh(entry: CacheEntry | null): entry is CacheEntry {
  return entry !== null && Date.now() - entry.ts < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// getCoinPrices
// ---------------------------------------------------------------------------

/**
 * Fetches current prices for the provided CoinGecko coin IDs.
 *
 * @param coinIds - Array of CoinGecko IDs (e.g. ['ethereum', 'bitcoin']).
 *                  Defaults to all entries in COIN_IDS if omitted.
 * @returns PriceMap keyed by coin ID with usd / eur / rub values.
 *          Falls back to the last successfully fetched prices on error.
 */
export async function getCoinPrices(coinIds?: string[]): Promise<PriceMap> {
  // Normalise and deduplicate
  const ids = [
    ...new Set(coinIds && coinIds.length > 0 ? coinIds : Object.values(COIN_IDS)),
  ];

  // Check cache — the full cache satisfies any subset of IDs within TTL
  if (isFresh(priceCache)) {
    return filterMap(priceCache.value, ids);
  }

  try {
    const url = new URL(`${COINGECKO_BASE}/simple/price`);
    url.searchParams.set('ids',           ids.join(','));
    url.searchParams.set('vs_currencies', 'usd,eur,rub');

    const res = await fetch(url.toString(), { headers: buildHeaders() });

    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status}: ${res.statusText}`);
    }

    const raw = (await res.json()) as Record<
      string,
      { usd?: number; eur?: number; rub?: number }
    >;

    const result: PriceMap = {};
    for (const [coinId, prices] of Object.entries(raw)) {
      result[coinId] = {
        usd: prices.usd ?? 0,
        eur: prices.eur ?? 0,
        rub: prices.rub ?? 0,
      };
    }

    // Persist cache + fallback store
    priceCache      = { value: result, ts: Date.now() };
    lastKnownPrices = { ...lastKnownPrices, ...result };

    return filterMap(result, ids);
  } catch (err) {
    // Return last-known prices so the UI degrades gracefully
    console.error('[prices] CoinGecko fetch failed, using stale prices:', err);

    if (Object.keys(lastKnownPrices).length > 0) {
      return filterMap(lastKnownPrices, ids);
    }

    // Absolute worst-case: return zeros for all requested IDs
    const fallback: PriceMap = {};
    for (const id of ids) {
      fallback[id] = { usd: 0, eur: 0, rub: 0 };
    }
    return fallback;
  }
}

/** Returns only the entries in `map` whose key is in `ids`. */
function filterMap(map: PriceMap, ids: string[]): PriceMap {
  const out: PriceMap = {};
  for (const id of ids) {
    if (map[id]) out[id] = map[id];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convenience: get price for a single chain (returns 0 if unknown)
// ---------------------------------------------------------------------------

export async function getPriceForChain(
  chain: string,
  currency: 'usd' | 'eur' | 'rub' = 'usd',
): Promise<number> {
  const coinId = COIN_IDS[chain];
  if (!coinId) return 0;
  const prices = await getCoinPrices([coinId]);
  return prices[coinId]?.[currency] ?? 0;
}
