/**
 * gem-twa — Wallet routes
 *
 * Prefix: /api/wallet  (registered in index.ts)
 *
 * All endpoints require a valid Telegram Mini App initData in the
 * `Authorization: tma <initData>` header (enforced via telegramAuth preHandler).
 *
 * Endpoints
 * ─────────
 * GET  /all                     — All wallets with native + token balances + prices
 * GET  /:chain                  — Single wallet with balance
 * POST /send                    — Send transaction  (5/hour rate limit)
 * GET  /:chain/history          — Transaction history from DB
 * POST /validate-address        — Validate an address for a given chain
 * POST /fee-estimate            — Estimate network fee
 * GET  /address-book            — List saved contacts
 * POST /address-book            — Save new contact
 * DELETE /address-book/:id      — Remove contact
 * GET  /nfts                    — NFT list (EVM chains, OpenSea-compatible stub)
 * GET  /:chain/chart            — Price chart proxy → CoinGecko
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

import { telegramAuth }               from '../auth/telegram';
import { prisma }                     from '../db';
import { checkRateLimit }             from '../ratelimit';
import { getOrCreateWallet, getPrivateKey, listWallets } from '../vault/keyVault';
import { sendTransaction, validateAddress, getGasEstimate, CHAIN_CONFIG } from '../signer';
import type { Chain }                 from '../signer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/** Fetch current USD prices for a list of CoinGecko IDs. */
async function fetchPrices(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  try {
    const url = `${COINGECKO_BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return {};
    const data = await res.json() as Record<string, { usd?: number }>;
    return Object.fromEntries(
      Object.entries(data).map(([id, v]) => [id, v?.usd ?? 0]),
    );
  } catch {
    return {};
  }
}

/**
 * Fetch native balance for a wallet.
 * Returns a human-readable string; falls back to '0' on error.
 */
async function getNativeBalance(chain: Chain, address: string): Promise<string> {
  try {
    const cfg = CHAIN_CONFIG[chain];
    // EVM: use eth_getBalance via public RPC
    const EVM_CHAINS = ['ethereum','bsc','polygon','arbitrum','optimism','base'];
    if (EVM_CHAINS.includes(chain)) {
      const res = await fetch(cfg.rpcUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_getBalance', params:[address,'latest'] }),
        signal:  AbortSignal.timeout(8_000),
      });
      const { result } = await res.json() as { result?: string };
      if (!result) return '0';
      const wei = BigInt(result);
      const divisor = BigInt(10) ** BigInt(cfg.decimals);
      return (Number(wei) / Number(divisor)).toFixed(6);
    }
    // Non-EVM: not fetching live balance in this stub; return '0'
    return '0';
  } catch {
    return '0';
  }
}

/** EVM token balances via a simple ERC-20 balanceOf call stub. */
async function getTokenBalances(chain: Chain, address: string): Promise<Array<{
  symbol: string; name: string; balance: string; contractAddress: string;
}>> {
  // Placeholder — real implementation would call Moralis / Alchemy token API
  return [];
}

/** Resolve IP from request (respects X-Forwarded-For). */
function resolveIp(request: FastifyRequest): string {
  return (
    (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? request.ip
  );
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SendBodySchema = z.object({
  chain:  z.string().min(1),
  to:     z.string().min(1),
  amount: z.string().min(1),
  asset:  z.string().optional(),
  memo:   z.string().optional(),
});

const ValidateAddressSchema = z.object({
  chain:   z.string().min(1),
  address: z.string().min(1),
});

const FeeEstimateSchema = z.object({
  chain:  z.string().min(1),
  to:     z.string().min(1),
  amount: z.string().min(1),
  asset:  z.string().optional(),
});

const AddressBookSchema = z.object({
  name:    z.string().min(1).max(100),
  address: z.string().min(1),
  chain:   z.string().min(1),
});

const PERIOD_TO_DAYS: Record<string, number> = {
  '1D': 1, '7D': 7, '1M': 30, '3M': 90, '1Y': 365, 'ALL': 1825,
};

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default async function walletRoutes(app: FastifyInstance): Promise<void> {
  // Apply telegramAuth to ALL routes in this plugin
  app.addHook('preHandler', telegramAuth);

  // ─────────────────────────────────────────────────────────────────────────
  // GET /all — all wallets with balances + prices
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/all', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    // Ensure all chains have wallets
    const chains = Object.keys(CHAIN_CONFIG) as Chain[];
    await Promise.all(chains.map(c => getOrCreateWallet(telegramId, c)));

    const wallets = await listWallets(telegramId);

    // Fetch prices for all unique CoinGecko IDs
    const geckoIds = [...new Set(chains.map(c => CHAIN_CONFIG[c].coingeckoId))];
    const prices   = await fetchPrices(geckoIds);

    const walletsWithBalances = await Promise.all(
      wallets.map(async (w) => {
        const chain    = w.chain as Chain;
        const cfg      = CHAIN_CONFIG[chain] ?? null;
        const balance  = cfg ? await getNativeBalance(chain, w.address) : '0';
        const tokens   = cfg ? await getTokenBalances(chain, w.address) : [];
        const priceUsd = cfg ? (prices[cfg.coingeckoId] ?? 0) : 0;
        const balanceUsd = (parseFloat(balance) * priceUsd).toFixed(2);

        return {
          chain:       w.chain,
          address:     w.address,
          nativeCoin:  cfg?.nativeCoin ?? w.chain.toUpperCase(),
          balance,
          balanceUsd,
          priceUsd,
          tokens,
          explorerUrl: cfg?.explorerUrl,
        };
      }),
    );

    return reply.send({ wallets: walletsWithBalances });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /:chain — single wallet + balance
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/:chain', async (
    request: FastifyRequest<{ Params: { chain: string } }>,
    reply: FastifyReply,
  ) => {
    const telegramId = String(request.telegramUser!.id);
    const chain      = request.params.chain as Chain;

    if (!CHAIN_CONFIG[chain]) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` });
    }

    await checkRateLimit(resolveIp(request), telegramId);

    const wallet = await getOrCreateWallet(telegramId, chain);
    const cfg    = CHAIN_CONFIG[chain];

    const [balance, prices] = await Promise.all([
      getNativeBalance(chain, wallet.address),
      fetchPrices([cfg.coingeckoId]),
    ]);

    const priceUsd   = prices[cfg.coingeckoId] ?? 0;
    const balanceUsd = (parseFloat(balance) * priceUsd).toFixed(2);

    return reply.send({
      chain,
      address:    wallet.address,
      nativeCoin: cfg.nativeCoin,
      balance,
      balanceUsd,
      priceUsd,
      explorerUrl: cfg.explorerUrl,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /send — send transaction (5/hour per user)
  // ─────────────────────────────────────────────────────────────────────────
  app.post(
    '/send',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const telegramId = String(request.telegramUser!.id);
      await checkRateLimit(resolveIp(request), telegramId, 'send');

      const parsed = SendBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
      }

      const { chain, to, amount, asset, memo } = parsed.data;
      const chainKey = chain as Chain;

      if (!CHAIN_CONFIG[chainKey]) {
        return reply.status(400).send({ error: `Unsupported chain: ${chain}` });
      }

      // Validate destination address
      const isValid = await validateAddress(chainKey, to);
      if (!isValid) {
        return reply.status(400).send({ error: 'Invalid destination address for chain.' });
      }

      // Retrieve private key
      const privateKey = await getPrivateKey(telegramId, chain);

      // Broadcast transaction
      const txResult = await sendTransaction(chainKey, { to, amount, data: memo }, privateKey);

      // Persist transaction record
      const wallet = await prisma.wallet.findUnique({
        where: { telegramId_chain: { telegramId, chain } },
        select: { id: true },
      });

      if (wallet) {
        await prisma.transaction.create({
          data: {
            walletId:   wallet.id,
            chain,
            type:       'send',
            amount,
            asset:      asset ?? CHAIN_CONFIG[chainKey].nativeCoin,
            toAddress:  to,
            txHash:     txResult.txHash,
            status:     txResult.success ? 'pending' : 'failed',
            memo:       memo ?? null,
          },
        });
      }

      // Notify via Telegram bot (fire-and-forget; don't block response)
      void notifyTelegramUser(
        telegramId,
        `✅ Transaction sent!\nChain: ${chain}\nTo: ${to}\nAmount: ${amount}\nTx: ${txResult.txHash}`,
      );

      return reply.send({
        success:     txResult.success,
        txHash:      txResult.txHash,
        explorerUrl: txResult.explorerUrl,
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /:chain/history — transaction history from DB
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/:chain/history', async (
    request: FastifyRequest<{ Params: { chain: string } }>,
    reply: FastifyReply,
  ) => {
    const telegramId = String(request.telegramUser!.id);
    const { chain }  = request.params;

    await checkRateLimit(resolveIp(request), telegramId);

    const wallet = await prisma.wallet.findUnique({
      where: { telegramId_chain: { telegramId, chain } },
      select: { id: true },
    });

    if (!wallet) {
      return reply.send({ transactions: [] });
    }

    const transactions = await prisma.transaction.findMany({
      where:   { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take:    50,
    });

    return reply.send({ transactions });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /validate-address
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/validate-address', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    const parsed = ValidateAddressSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const { chain, address } = parsed.data;
    const chainKey           = chain as Chain;

    if (!CHAIN_CONFIG[chainKey]) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` });
    }

    const valid = await validateAddress(chainKey, address);
    return reply.send({ valid });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /fee-estimate
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/fee-estimate', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    const parsed = FeeEstimateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const { chain, to, amount } = parsed.data;
    const chainKey              = chain as Chain;

    if (!CHAIN_CONFIG[chainKey]) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` });
    }

    const wallet = await getOrCreateWallet(telegramId, chain);
    const cfg    = CHAIN_CONFIG[chainKey];

    const [estimate, prices] = await Promise.all([
      getGasEstimate(chainKey, { to, amount }, wallet.address),
      fetchPrices([cfg.coingeckoId]),
    ]);

    const priceUsd = prices[cfg.coingeckoId] ?? 0;
    const feeUsd   = (parseFloat(estimate.estimatedFeeNative) * priceUsd).toFixed(6);

    return reply.send({
      fee:    estimate.estimatedFeeNative,
      feeUsd,
      coin:   cfg.nativeCoin,
      detail: estimate,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /address-book
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/address-book', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    const entries = await prisma.addressBook.findMany({
      where:   { telegramId },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ entries });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /address-book — add contact
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/address-book', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    const parsed = AddressBookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const { name, address, chain } = parsed.data;
    const chainKey                 = chain as Chain;

    if (!CHAIN_CONFIG[chainKey]) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` });
    }

    const isValid = await validateAddress(chainKey, address);
    if (!isValid) {
      return reply.status(400).send({ error: 'Invalid address for the specified chain.' });
    }

    const entry = await prisma.addressBook.create({
      data: { telegramId, name, address, chain },
    });

    return reply.status(201).send({ entry });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /address-book/:id — remove contact
  // ─────────────────────────────────────────────────────────────────────────
  app.delete('/address-book/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    const { id } = request.params;

    const entry = await prisma.addressBook.findUnique({ where: { id } });
    if (!entry) {
      return reply.status(404).send({ error: 'Address book entry not found.' });
    }
    if (entry.telegramId !== telegramId) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    await prisma.addressBook.delete({ where: { id } });
    return reply.send({ deleted: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /nfts — NFT list (EVM chains via stub; extend with Moralis/Alchemy)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/nfts', async (request: FastifyRequest, reply: FastifyReply) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    // Stub — real implementation would iterate EVM wallets and call NFT API
    return reply.send({ nfts: [] });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /:chain/chart?period=1D — price chart proxy → CoinGecko
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/:chain/chart', async (
    request: FastifyRequest<{
      Params:      { chain: string };
      Querystring: { period?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const telegramId = String(request.telegramUser!.id);
    await checkRateLimit(resolveIp(request), telegramId);

    const { chain }  = request.params;
    const period     = request.query.period ?? '1D';
    const chainKey   = chain as Chain;

    if (!CHAIN_CONFIG[chainKey]) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` });
    }

    const days       = PERIOD_TO_DAYS[period] ?? 1;
    const geckoId    = CHAIN_CONFIG[chainKey].coingeckoId;
    const cgUrl      = `${COINGECKO_BASE}/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`;

    try {
      const res = await fetch(cgUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return reply.status(502).send({ error: 'Failed to fetch chart data from CoinGecko.' });
      }
      const data = await res.json() as { prices?: [number, number][] };

      // Normalise: [timestamp_ms, price_usd]
      const prices = (data.prices ?? []).map(([ts, price]) => ({ ts, price }));
      return reply.send({ chain, period, days, prices });
    } catch (err) {
      return reply.status(504).send({ error: 'CoinGecko request timed out.' });
    }
  });
}

// ---------------------------------------------------------------------------
// Internal: Telegram Bot notification (fire-and-forget)
// ---------------------------------------------------------------------------

async function notifyTelegramUser(telegramId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: telegramId, text }),
      signal:  AbortSignal.timeout(5_000),
    });
  } catch {
    // Non-fatal
  }
}
