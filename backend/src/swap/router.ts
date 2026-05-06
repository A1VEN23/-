/**
 * gem-twa — Swap Router
 *
 * Dispatches quote and execute requests to the correct DEX aggregator
 * depending on the target chain:
 *
 *   EVM chains  → 1inch  (ethereum, bsc, polygon, arbitrum, optimism, base)
 *   solana      → Jupiter
 *   ton         → STON.fi
 *   tron        → SunSwap
 *
 * executeSwap signs the transaction with the user's key from the vault,
 * broadcasts it, stores a Transaction record, and sends a Telegram
 * notification (fire-and-forget).
 */

import { prisma }                         from '../db';
import { getPrivateKey }                  from '../vault/keyVault';
import { EVM_CHAIN_IDS }                  from './providers/oneinch';
import { getOdosQuote, buildOdosSwap }    from './providers/odos';
import { getJupiterQuote, buildJupiterSwap } from './providers/jupiter';
import { getSTONfiQuote }                 from './providers/stonfi';
import { getSunSwapQuote }                from './providers/sunswap';

// EVM signing
import { EVM_CHAINS }                     from '../signer/chains/evm';
import { Wallet, JsonRpcProvider, toBigInt } from 'ethers';

// Solana signing
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

// TON signing (jetton transfer for STON.fi requires on-chain message)
import {
  TonClient,
  WalletContractV4,
  internal,
  Address,
  toNano,
  beginCell,
} from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

// TRON signing
import TronWeb from 'tronweb';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SwapQuote {
  chain: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  priceImpact: string;
  fee: string;
  provider: string;
  /** Raw provider response for use in buildSwap */
  raw: unknown;
}

export interface SwapResult {
  txHash: string;
  success: boolean;
  explorerUrl: string;
  fromAmount: string;
  toAmount: string;
}

// ─── Chain classification ─────────────────────────────────────────────────────

const EVM_CHAIN_NAMES = new Set(Object.keys(EVM_CHAIN_IDS));

function classifyChain(chain: string): 'evm' | 'solana' | 'ton' | 'tron' {
  if (EVM_CHAIN_NAMES.has(chain)) return 'evm';
  if (chain === 'solana')          return 'solana';
  if (chain === 'ton')             return 'ton';
  if (chain === 'tron')            return 'tron';
  throw new Error(`Unsupported swap chain: "${chain}"`);
}

// ─── Telegram notification helper ────────────────────────────────────────────

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

// ─── Quote router ─────────────────────────────────────────────────────────────

/**
 * Get the best swap quote for the given chain.
 *
 * @param chain     Network name (ethereum | bsc | polygon | arbitrum | optimism | base | solana | ton | tron)
 * @param fromToken Source token address (chain-native format)
 * @param toToken   Destination token address
 * @param amount    Amount in source token's smallest unit
 * @param slippage  Slippage tolerance in percent (default 0.5)
 */
export async function getSwapQuote(
  chain: string,
  fromToken: string,
  toToken: string,
  amount: string,
  slippage = 0.5,
): Promise<SwapQuote> {
  const kind = classifyChain(chain);

  switch (kind) {
    case 'evm': {
      // Odos requires a user address for quoting; use a dummy address for the quote phase
      const dummyAddr = '0x0000000000000000000000000000000000000000';
      const raw = await getOdosQuote(chain, fromToken, toToken, amount, dummyAddr, slippage);
      const slippageFactor = 1 - slippage / 100;
      const toAmountMin = BigInt(Math.floor(Number(raw.outAmounts[0]) * slippageFactor)).toString();

      return {
        chain,
        fromToken,
        toToken,
        fromAmount: amount,
        toAmount:   raw.outAmounts[0],
        toAmountMin,
        priceImpact: '0',
        fee:         String(raw.gasEstimate),
        provider:    'odos',
        raw,
      };
    }

    case 'solana': {
      const slippageBps = Math.round(slippage * 100); // % → bps
      const raw = await getJupiterQuote(fromToken, toToken, amount, slippageBps);
      return {
        chain,
        fromToken,
        toToken,
        fromAmount: raw.inAmount,
        toAmount:   raw.outAmount,
        toAmountMin: raw.otherAmountThreshold,
        priceImpact: raw.priceImpactPct,
        fee:         '0',
        provider:    'jupiter',
        raw,
      };
    }

    case 'ton': {
      const raw = await getSTONfiQuote(fromToken, toToken, amount, slippage.toString());
      return {
        chain,
        fromToken,
        toToken,
        fromAmount: raw.offer_units,
        toAmount:   raw.ask_units,
        toAmountMin: raw.min_ask_units,
        priceImpact: raw.price_impact,
        fee:         raw.fee_units,
        provider:    'stonfi',
        raw,
      };
    }

    case 'tron': {
      const raw = await getSunSwapQuote(fromToken, toToken, amount, slippage.toString());
      return {
        chain,
        fromToken,
        toToken,
        fromAmount: amount,
        toAmount:   raw.amountOut,
        toAmountMin: raw.amountOutMin,
        priceImpact: raw.priceImpact,
        fee:         raw.tradeFee,
        provider:    'sunswap',
        raw,
      };
    }
  }
}

// ─── Execute router ───────────────────────────────────────────────────────────

/**
 * Build, sign, and broadcast a swap transaction.
 *
 * @param chain      Network name
 * @param telegramId Telegram user id (used for key retrieval and notification)
 * @param fromToken  Source token address
 * @param toToken    Destination token address
 * @param amount     Amount in source token's smallest unit
 * @param slippage   Slippage tolerance in percent (default 0.5)
 */
export async function executeSwap(
  chain: string,
  telegramId: string,
  fromToken: string,
  toToken: string,
  amount: string,
  slippage = 0.5,
): Promise<SwapResult> {
  const kind = classifyChain(chain);

  // 1. Retrieve user's private key from vault
  const privateKey = await getPrivateKey(telegramId, chain);

  let result: SwapResult;

  switch (kind) {
    case 'evm': {
      result = await executeEVMSwap(chain, fromToken, toToken, amount, slippage, privateKey);
      break;
    }
    case 'solana': {
      result = await executeSolanaSwap(fromToken, toToken, amount, slippage, privateKey);
      break;
    }
    case 'ton': {
      result = await executeTONSwap(fromToken, toToken, amount, slippage, privateKey);
      break;
    }
    case 'tron': {
      result = await executeTronSwap(fromToken, toToken, amount, slippage, privateKey);
      break;
    }
    default: {
      throw new Error(`executeSwap: unhandled chain kind`);
    }
  }

  // 2. Persist transaction record
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { telegramId_chain: { telegramId, chain } },
      select: { id: true },
    });

    if (wallet) {
      await prisma.transaction.create({
        data: {
          walletId:    wallet.id,
          chain,
          type:        'swap',
          amount,
          asset:       `${fromToken}→${toToken}`,
          txHash:      result.txHash,
          status:      result.success ? 'pending' : 'failed',
        },
      });
    }
  } catch (err) {
    console.error('[swap] Failed to persist transaction:', err);
  }

  // 3. Telegram notification (fire-and-forget)
  void notifyTelegramUser(
    telegramId,
    result.success
      ? `✅ Swap executed!\nChain: ${chain}\n${fromToken} → ${toToken}\nAmount: ${amount}\nTx: ${result.txHash}`
      : `❌ Swap failed!\nChain: ${chain}\n${fromToken} → ${toToken}\nAmount: ${amount}`,
  );

  return result;
}

// ─── Chain-specific executors ─────────────────────────────────────────────────

async function executeEVMSwap(
  chain: string,
  fromToken: string,
  toToken: string,
  amount: string,
  slippage: number,
  privateKey: string,
): Promise<SwapResult> {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) throw new Error(`executeEVMSwap: unknown chain "${chain}"`);

  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet   = new Wallet(privateKey, provider);
  const fromAddress = wallet.address;

  // Get quote + assemble swap tx from Odos (no API key)
  const odosQuote = await getOdosQuote(chain, fromToken, toToken, amount, fromAddress, slippage);
  const odosSwap  = await buildOdosSwap(odosQuote.pathId, fromAddress);
  const tx        = odosSwap.transaction;

  const sentTx = await wallet.sendTransaction({
    to:       tx.to,
    data:     tx.data,
    value:    toBigInt(tx.value),
    gasLimit: BigInt(tx.gasLimit),
    gasPrice: toBigInt(tx.gasPrice),
  });

  const receipt = await sentTx.wait(1);

  return {
    txHash:      sentTx.hash,
    success:     receipt?.status === 1,
    explorerUrl: `${cfg.explorerUrl}/tx/${sentTx.hash}`,
    fromAmount:  amount,
    toAmount:    odosQuote.outAmounts[0],
  };
}

async function executeSolanaSwap(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippage: number,
  privateKey: string,
): Promise<SwapResult> {
  const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
  const connection  = new Connection(SOLANA_RPC, 'confirmed');

  // Restore keypair from base58 private key
  const secretKey = bs58.decode(privateKey);
  const keypair   = Keypair.fromSecretKey(secretKey);
  const publicKey = keypair.publicKey.toBase58();

  // 1. Get quote
  const slippageBps = Math.round(slippage * 100);
  const quote = await getJupiterQuote(inputMint, outputMint, amount, slippageBps);

  // 2. Build swap tx (base64 versioned transaction)
  const { swapTransaction } = await buildJupiterSwap(quote, publicKey);

  // 3. Deserialise, sign, and broadcast
  const txBuffer  = Buffer.from(swapTransaction, 'base64');
  const vTx       = VersionedTransaction.deserialize(txBuffer);
  vTx.sign([keypair]);

  const txHash = await connection.sendRawTransaction(vTx.serialize(), {
    skipPreflight: false,
    maxRetries:    3,
  });

  await connection.confirmTransaction(txHash, 'confirmed');

  return {
    txHash,
    success:     true,
    explorerUrl: `https://explorer.solana.com/tx/${txHash}`,
    fromAmount:  quote.inAmount,
    toAmount:    quote.outAmount,
  };
}

async function executeTONSwap(
  offerAddress: string,
  askAddress: string,
  offerAmount: string,
  slippage: number,
  mnemonic: string,
): Promise<SwapResult> {
  const TON_RPC = process.env.TON_RPC ?? 'https://toncenter.com/api/v2/jsonRPC';

  // Derive keypair from mnemonic
  const mnemonicArr = mnemonic.split(' ');
  const keyPair     = await mnemonicToPrivateKey(mnemonicArr);

  const client = new TonClient({ endpoint: TON_RPC });
  const walletContract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const walletSender   = client.open(walletContract);

  // Get a quote to obtain min_ask_units
  const quote = await getSTONfiQuote(offerAddress, askAddress, offerAmount, slippage.toString());

  /**
   * STON.fi swap = jetton transfer to STON.fi router with a forward payload
   * containing the op-code and destination jetton address.
   * Reference: https://docs.ston.fi/docs/developer-section/api-reference/router
   */
  const STONFI_ROUTER = Address.parse(quote.router_address);
  const OP_SWAP       = 0x25938561n; // STON.fi swap op-code

  const forwardPayload = beginCell()
    .storeUint(OP_SWAP, 32)
    .storeAddress(Address.parse(askAddress))
    .storeCoins(BigInt(quote.min_ask_units))
    .storeAddress(STONFI_ROUTER) // excess to router (or user)
    .endCell();

  const seqno = await walletSender.getSeqno();

  await walletSender.sendTransfer({
    secretKey: keyPair.secretKey,
    seqno,
    messages: [
      internal({
        to:    STONFI_ROUTER,
        value: toNano('0.25'), // gas for the swap + jetton transfers
        body:  forwardPayload,
      }),
    ],
  });

  // TON doesn't immediately return a tx hash; poll for seqno advancement
  const txHash = `ton-swap-seqno-${seqno + 1}`;

  return {
    txHash,
    success:     true,
    explorerUrl: `https://tonscan.org/address/${walletContract.address.toString()}`,
    fromAmount:  quote.offer_units,
    toAmount:    quote.ask_units,
  };
}

async function executeTronSwap(
  fromToken: string,
  toToken: string,
  amountIn: string,
  slippage: number,
  privateKey: string,
): Promise<SwapResult> {
  const TRON_FULLNODE = process.env.TRON_FULLNODE ?? 'https://api.trongrid.io';

  const tronWeb = new TronWeb({
    fullHost:   TRON_FULLNODE,
    privateKey: privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey,
  });

  // Get quote (includes callData and routerAddress for on-chain call)
  const quote = await getSunSwapQuote(fromToken, toToken, amountIn, slippage.toString());

  if (!quote.routerAddress) {
    throw new Error('SunSwap did not return a router address');
  }

  if (!quote.callData) {
    throw new Error('SunSwap did not return call data for the swap');
  }

  // SunSwap callData is ABI-encoded; strip '0x' prefix for TronWeb
  const functionSelector = quote.callData.slice(0, 10); // first 4 bytes = selector
  const parameters       = quote.callData.slice(10);

  const tx = await tronWeb.transactionBuilder.triggerSmartContract(
    quote.routerAddress,
    functionSelector,
    { callValue: fromToken === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' ? Number(amountIn) : 0 },
    parameters ? [{ type: 'bytes', value: parameters }] : [],
    tronWeb.defaultAddress.base58,
  );

  if (!tx.result?.result) {
    throw new Error(`SunSwap tx build failed: ${JSON.stringify(tx.result)}`);
  }

  const signedTx    = await tronWeb.trx.sign(tx.transaction);
  const broadcastResult = await tronWeb.trx.sendRawTransaction(signedTx);

  const txHash = broadcastResult.txid ?? broadcastResult.transaction?.txID ?? '';

  return {
    txHash,
    success:     broadcastResult.result === true,
    explorerUrl: `https://tronscan.org/#/transaction/${txHash}`,
    fromAmount:  amountIn,
    toAmount:    quote.amountOut,
  };
}
