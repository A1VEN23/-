/**
 * gem-twa — Main signer router
 *
 * Single entry-point that delegates wallet operations to per-chain modules.
 * All 16 supported chains are wired here.
 */

import * as bip39 from 'bip39';

import type { Chain, WalletData, TxParams, TxResult, GasEstimate } from './types';

// EVM (6 chains)
import {
  generateEVMWallet,
  sendEVMTransaction,
  validateEVMAddress,
  estimateEVMGas,
} from './chains/evm';

// Non-EVM chains
import { generateSolanaWallet, sendSOL,     validateSolanaAddress  } from './chains/solana';
import { generateTONWallet,    sendTON,     validateTONAddress     } from './chains/ton';
import { generateTronWallet,   sendTRX,     validateTronAddress    } from './chains/tron';
import { generateBitcoinWallet, sendBTC,    validateBTCAddress     } from './chains/bitcoin';
import { generateCosmosWallet, sendATOM,    validateCosmosAddress  } from './chains/cosmos';
import { generateXRPWallet,    sendXRP,     validateXRPAddress     } from './chains/xrp';
import { generateLTCWallet,    sendLTC,     validateLTCAddress     } from './chains/litecoin';
import { generateDOGEWallet,   sendDOGE,    validateDOGEAddress    } from './chains/dogecoin';
import { generateAptosWallet,  sendAPT,     validateAptosAddress   } from './chains/aptos';
import { generateNEARWallet,   sendNEAR,    validateNEARAddress    } from './chains/near';

// ---------------------------------------------------------------------------
// Chain configuration registry (all 16 networks)
// ---------------------------------------------------------------------------

export interface ChainConfig {
  chainId?:    number;
  rpcUrl:      string;
  nativeCoin:  string;
  decimals:    number;
  explorerUrl: string;
  coingeckoId: string;
}

export const CHAIN_CONFIG: Record<Chain, ChainConfig> = {
  // ── EVM ──────────────────────────────────────────────────────────────────
  ethereum: {
    chainId:     1,
    rpcUrl:      'https://eth.llamarpc.com',
    nativeCoin:  'ETH',
    decimals:    18,
    explorerUrl: 'https://etherscan.io',
    coingeckoId: 'ethereum',
  },
  bsc: {
    chainId:     56,
    rpcUrl:      'https://bsc-dataseed1.binance.org',
    nativeCoin:  'BNB',
    decimals:    18,
    explorerUrl: 'https://bscscan.com',
    coingeckoId: 'binancecoin',
  },
  polygon: {
    chainId:     137,
    rpcUrl:      'https://polygon-rpc.com',
    nativeCoin:  'MATIC',
    decimals:    18,
    explorerUrl: 'https://polygonscan.com',
    coingeckoId: 'matic-network',
  },
  arbitrum: {
    chainId:     42161,
    rpcUrl:      'https://arb1.arbitrum.io/rpc',
    nativeCoin:  'ETH',
    decimals:    18,
    explorerUrl: 'https://arbiscan.io',
    coingeckoId: 'ethereum',
  },
  optimism: {
    chainId:     10,
    rpcUrl:      'https://mainnet.optimism.io',
    nativeCoin:  'ETH',
    decimals:    18,
    explorerUrl: 'https://optimistic.etherscan.io',
    coingeckoId: 'ethereum',
  },
  base: {
    chainId:     8453,
    rpcUrl:      'https://mainnet.base.org',
    nativeCoin:  'ETH',
    decimals:    18,
    explorerUrl: 'https://basescan.org',
    coingeckoId: 'ethereum',
  },

  // ── Non-EVM ──────────────────────────────────────────────────────────────
  solana: {
    rpcUrl:      'https://api.mainnet-beta.solana.com',
    nativeCoin:  'SOL',
    decimals:    9,
    explorerUrl: 'https://explorer.solana.com',
    coingeckoId: 'solana',
  },
  ton: {
    rpcUrl:      'https://toncenter.com/api/v2/jsonRPC',
    nativeCoin:  'TON',
    decimals:    9,
    explorerUrl: 'https://tonscan.org',
    coingeckoId: 'the-open-network',
  },
  tron: {
    rpcUrl:      'https://api.trongrid.io',
    nativeCoin:  'TRX',
    decimals:    6,
    explorerUrl: 'https://tronscan.org',
    coingeckoId: 'tron',
  },
  bitcoin: {
    rpcUrl:      'https://blockstream.info/api',
    nativeCoin:  'BTC',
    decimals:    8,
    explorerUrl: 'https://blockstream.info',
    coingeckoId: 'bitcoin',
  },
  cosmos: {
    chainId:     118,
    rpcUrl:      'https://cosmos-rpc.publicnode.com:443',
    nativeCoin:  'ATOM',
    decimals:    6,
    explorerUrl: 'https://www.mintscan.io/cosmos',
    coingeckoId: 'cosmos',
  },
  xrp: {
    rpcUrl:      'wss://xrplcluster.com',
    nativeCoin:  'XRP',
    decimals:    6,
    explorerUrl: 'https://livenet.xrpl.org',
    coingeckoId: 'ripple',
  },
  litecoin: {
    rpcUrl:      'https://api.bitaps.com/ltc/v1/blockchain',
    nativeCoin:  'LTC',
    decimals:    8,
    explorerUrl: 'https://litecoinspace.org',
    coingeckoId: 'litecoin',
  },
  dogecoin: {
    rpcUrl:      'https://api.bitaps.com/doge/v1/blockchain',
    nativeCoin:  'DOGE',
    decimals:    8,
    explorerUrl: 'https://dogechain.info',
    coingeckoId: 'dogecoin',
  },
  aptos: {
    rpcUrl:      'https://fullnode.mainnet.aptoslabs.com/v1',
    nativeCoin:  'APT',
    decimals:    8,
    explorerUrl: 'https://explorer.aptoslabs.com',
    coingeckoId: 'aptos',
  },
  near: {
    rpcUrl:      'https://rpc.mainnet.near.org',
    nativeCoin:  'NEAR',
    decimals:    24,
    explorerUrl: 'https://nearblocks.io',
    coingeckoId: 'near',
  },
};

// EVM chain names used to delegate to the EVM module
const EVM_CHAINS = new Set<Chain>([
  'ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base',
]);

// ---------------------------------------------------------------------------
// generateMnemonic
// ---------------------------------------------------------------------------

/**
 * Generate a fresh cryptographically-secure 24-word BIP-39 mnemonic.
 */
export async function generateMnemonic(): Promise<string> {
  return bip39.generateMnemonic(256);
}

// ---------------------------------------------------------------------------
// generateWallet
// ---------------------------------------------------------------------------

/**
 * Generate (or restore) a wallet for the given chain.
 *
 * @param chain     Target blockchain.
 * @param mnemonic  Optional BIP-39 mnemonic to restore an existing wallet.
 */
export async function generateWallet(chain: Chain, mnemonic?: string): Promise<WalletData> {
  if (EVM_CHAINS.has(chain)) {
    return generateEVMWallet(chain, mnemonic);
  }

  switch (chain) {
    case 'solana':   return generateSolanaWallet(mnemonic);
    case 'ton':      return generateTONWallet(mnemonic);
    case 'tron':     return generateTronWallet(mnemonic);
    case 'bitcoin':  return generateBitcoinWallet(mnemonic);
    case 'cosmos':   return generateCosmosWallet(mnemonic);
    case 'xrp':      return generateXRPWallet(mnemonic);
    case 'litecoin': return generateLTCWallet(mnemonic);
    case 'dogecoin': return generateDOGEWallet(mnemonic);
    case 'aptos':    return generateAptosWallet(mnemonic);
    case 'near':     return generateNEARWallet(mnemonic);
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

// ---------------------------------------------------------------------------
// sendTransaction
// ---------------------------------------------------------------------------

/**
 * Broadcast a transaction on the specified chain.
 *
 * @param chain      Target blockchain.
 * @param params     Transaction parameters (to, amount, data, gas overrides…).
 * @param privateKey Chain-specific private key string (WalletData.privateKey).
 */
export async function sendTransaction(
  chain: Chain,
  params: TxParams,
  privateKey: string,
): Promise<TxResult> {
  const { to, amount, data } = params;

  if (EVM_CHAINS.has(chain)) {
    return sendEVMTransaction(chain, params, privateKey);
  }

  switch (chain) {
    case 'solana':
      return sendSOL(to, amount, privateKey);

    case 'ton':
      return sendTON(to, amount, privateKey, data);

    case 'tron':
      return sendTRX(to, amount, privateKey);

    case 'bitcoin':
      return sendBTC(to, amount, privateKey);

    case 'cosmos':
      return sendATOM(to, amount, privateKey, data);

    case 'xrp': {
      // destinationTag can be passed via data as a numeric string
      const destinationTag = data ? parseInt(data, 10) : undefined;
      return sendXRP(to, amount, privateKey, isNaN(destinationTag!) ? undefined : destinationTag);
    }

    case 'litecoin':
      return sendLTC(to, amount, privateKey);

    case 'dogecoin':
      return sendDOGE(to, amount, privateKey);

    case 'aptos':
      return sendAPT(to, amount, privateKey);

    case 'near':
      return sendNEAR(to, amount, privateKey);

    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

// ---------------------------------------------------------------------------
// validateAddress
// ---------------------------------------------------------------------------

/**
 * Validate whether `address` is a well-formed address for the given chain.
 * Does NOT check whether the address has funds or exists on-chain.
 */
export async function validateAddress(chain: Chain, address: string): Promise<boolean> {
  try {
    if (EVM_CHAINS.has(chain)) {
      return validateEVMAddress(address);
    }

    switch (chain) {
      case 'solana':   return validateSolanaAddress(address);
      case 'ton':      return validateTONAddress(address);
      case 'tron':     return validateTronAddress(address);
      case 'bitcoin':  return validateBTCAddress(address);
      case 'cosmos':   return validateCosmosAddress(address);
      case 'xrp':      return validateXRPAddress(address);
      case 'litecoin': return validateLTCAddress(address);
      case 'dogecoin': return validateDOGEAddress(address);
      case 'aptos':    return validateAptosAddress(address);
      case 'near':     return validateNEARAddress(address);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// getGasEstimate
// ---------------------------------------------------------------------------

/**
 * Estimate transaction fees for the given chain.
 *
 * EVM chains return full EIP-1559 data.
 * Non-EVM chains return a fixed or chain-queried estimate.
 *
 * @param chain       Target blockchain.
 * @param params      Draft transaction parameters used for EVM estimation.
 * @param fromAddress Sender address (required for EVM nonce lookup).
 */
export async function getGasEstimate(
  chain: Chain,
  params: TxParams,
  fromAddress: string,
): Promise<GasEstimate> {
  // EVM chains — delegate to the EVM estimator
  if (EVM_CHAINS.has(chain)) {
    return estimateEVMGas(chain, params, fromAddress);
  }

  // Non-EVM chains — return sensible static estimates
  const staticEstimates: Record<string, GasEstimate> = {
    solana: {
      gasLimit:            '1',
      gasPrice:            '5000',        // lamports
      estimatedFeeNative:  '0.000005',    // SOL
    },
    ton: {
      gasLimit:            '1',
      gasPrice:            '10000000',    // nanoTON
      estimatedFeeNative:  '0.01',        // TON
    },
    tron: {
      gasLimit:            '1',
      gasPrice:            '1000',        // sun
      estimatedFeeNative:  '1',           // TRX (bandwidth/energy)
    },
    bitcoin: {
      gasLimit:            '1',
      gasPrice:            '2000',        // satoshis flat fee
      estimatedFeeNative:  '0.00002',     // BTC
    },
    cosmos: {
      gasLimit:            '80000',
      gasPrice:            '0.025',       // uatom per gas
      estimatedFeeNative:  '0.002',       // ATOM
    },
    xrp: {
      gasLimit:            '1',
      gasPrice:            '12',          // drops
      estimatedFeeNative:  '0.000012',    // XRP
    },
    litecoin: {
      gasLimit:            '1',
      gasPrice:            '100000',      // litoshis flat fee
      estimatedFeeNative:  '0.001',       // LTC
    },
    dogecoin: {
      gasLimit:            '1',
      gasPrice:            '1000000',     // koinus flat fee
      estimatedFeeNative:  '1',           // DOGE
    },
    aptos: {
      gasLimit:            '2000',
      gasPrice:            '100',         // octas per gas unit
      estimatedFeeNative:  '0.0002',      // APT
    },
    near: {
      gasLimit:            '300000000000000', // TGAS
      gasPrice:            '100000000',       // yoctoNEAR per gas
      estimatedFeeNative:  '0.0001',          // NEAR
    },
  };

  const estimate = staticEstimates[chain];
  if (!estimate) throw new Error(`Gas estimation not supported for chain: ${chain}`);

  return estimate;
}
