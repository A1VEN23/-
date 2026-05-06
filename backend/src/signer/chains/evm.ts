import {
  ethers,
  Mnemonic,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  Contract,
  ContractFactory,
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  toBigInt,
} from 'ethers';
import * as bip39 from 'bip39';
import type { Chain, WalletData, TxParams, TxResult, GasEstimate } from '../types';

// ---------------------------------------------------------------------------
// Chain registry
// ---------------------------------------------------------------------------

export interface EVMChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  symbol: string;
  decimals: number;
}

export const EVM_CHAINS: Record<string, EVMChainConfig> = {
  ethereum: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    symbol: 'ETH',
    decimals: 18,
  },
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    rpcUrl: 'https://bsc-dataseed1.binance.org',
    explorerUrl: 'https://bscscan.com',
    symbol: 'BNB',
    decimals: 18,
  },
  polygon: {
    chainId: 137,
    name: 'Polygon Mainnet',
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    symbol: 'MATIC',
    decimals: 18,
  },
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum One',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    symbol: 'ETH',
    decimals: 18,
  },
  optimism: {
    chainId: 10,
    name: 'Optimism',
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    symbol: 'ETH',
    decimals: 18,
  },
  base: {
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    symbol: 'ETH',
    decimals: 18,
  },
};

// Minimal ERC-20 ABI (transfer + balanceOf + decimals)
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getChainConfig(chain: string): EVMChainConfig {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) {
    throw new Error(`Unsupported EVM chain: ${chain}`);
  }
  return cfg;
}

function getProvider(chain: string): JsonRpcProvider {
  const cfg = getChainConfig(chain);
  return new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
}

function buildExplorerTxUrl(chain: string, txHash: string): string {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return txHash;
  return `${cfg.explorerUrl}/tx/${txHash}`;
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

/**
 * Generate a new EVM wallet (Ethereum-compatible).
 * If `mnemonic` is provided the existing seed phrase is used for derivation.
 */
export async function generateEVMWallet(mnemonic?: string): Promise<WalletData> {
  const phrase = mnemonic ?? bip39.generateMnemonic(256);

  if (!bip39.validateMnemonic(phrase)) {
    throw new Error('Invalid mnemonic phrase');
  }

  const derivationPath = "m/44'/60'/0'/0/0";
  const hdNode = HDNodeWallet.fromPhrase(phrase, undefined, derivationPath);

  return {
    address: hdNode.address,
    privateKey: hdNode.privateKey,
    publicKey: hdNode.publicKey,
    mnemonic: phrase,
    chain: 'ethereum',
    derivationPath,
  };
}

// ---------------------------------------------------------------------------
// Native token transfer
// ---------------------------------------------------------------------------

/**
 * Send a native token transfer on any EVM-compatible chain.
 */
export async function sendEVMTransaction(
  chain: string,
  params: TxParams,
  privateKey: string
): Promise<TxResult> {
  const provider = getProvider(chain);
  const wallet = new Wallet(privateKey, provider);

  // Build the transaction object
  const tx: ethers.TransactionRequest = {
    to: params.to,
    value: toBigInt(params.amount),
  };

  if (params.data) tx.data = params.data;
  if (params.nonce !== undefined) tx.nonce = params.nonce;
  if (params.gasLimit) tx.gasLimit = toBigInt(params.gasLimit);

  // EIP-1559 fees take priority over legacy gasPrice
  if (params.maxFeePerGas) {
    tx.maxFeePerGas = toBigInt(params.maxFeePerGas);
    tx.maxPriorityFeePerGas = toBigInt(
      params.maxPriorityFeePerGas ?? params.maxFeePerGas
    );
  } else if (params.gasPrice) {
    tx.gasPrice = toBigInt(params.gasPrice);
  }

  const sentTx = await wallet.sendTransaction(tx);
  const receipt = await sentTx.wait(1);

  return {
    txHash: sentTx.hash,
    success: receipt?.status === 1,
    blockNumber: receipt?.blockNumber,
    explorerUrl: buildExplorerTxUrl(chain, sentTx.hash),
    raw: receipt,
  };
}

// ---------------------------------------------------------------------------
// ERC-20 transfer
// ---------------------------------------------------------------------------

/**
 * Send an ERC-20 token transfer.
 * `params.amount` is in the token's smallest unit (e.g. USDC has 6 decimals).
 */
export async function sendERC20(
  chain: string,
  tokenAddress: string,
  params: TxParams,
  privateKey: string
): Promise<TxResult> {
  const provider = getProvider(chain);
  const wallet = new Wallet(privateKey, provider);
  const token = new Contract(tokenAddress, ERC20_ABI, wallet);

  // Resolve overrides
  const overrides: ethers.Overrides = {};
  if (params.gasLimit) overrides.gasLimit = toBigInt(params.gasLimit);
  if (params.maxFeePerGas) {
    overrides.maxFeePerGas = toBigInt(params.maxFeePerGas);
    overrides.maxPriorityFeePerGas = toBigInt(
      params.maxPriorityFeePerGas ?? params.maxFeePerGas
    );
  } else if (params.gasPrice) {
    overrides.gasPrice = toBigInt(params.gasPrice);
  }
  if (params.nonce !== undefined) overrides.nonce = params.nonce;

  const sentTx = await token.transfer(
    params.to,
    toBigInt(params.amount),
    overrides
  );
  const receipt = await sentTx.wait(1);

  return {
    txHash: sentTx.hash,
    success: receipt?.status === 1,
    blockNumber: receipt?.blockNumber,
    explorerUrl: buildExplorerTxUrl(chain, sentTx.hash),
    raw: receipt,
  };
}

// ---------------------------------------------------------------------------
// Gas estimation
// ---------------------------------------------------------------------------

/**
 * Estimate gas for a transaction.
 * Returns both legacy `gasPrice` and EIP-1559 fields when available.
 */
export async function getEVMGasEstimate(
  chain: string,
  params: TxParams,
  fromAddress: string
): Promise<GasEstimate> {
  const provider = getProvider(chain);

  const txReq: ethers.TransactionRequest = {
    from: fromAddress,
    to: params.to,
    value: toBigInt(params.amount),
  };
  if (params.data) txReq.data = params.data;

  const [gasLimit, feeData] = await Promise.all([
    provider.estimateGas(txReq),
    provider.getFeeData(),
  ]);

  const gasPrice = feeData.gasPrice ?? 0n;
  const maxFeePerGas = feeData.maxFeePerGas ?? undefined;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? undefined;

  // Use EIP-1559 maxFeePerGas for total fee estimate when available
  const effectiveGasPrice = maxFeePerGas ?? gasPrice;
  const estimatedFeeWei = gasLimit * effectiveGasPrice;

  const result: GasEstimate = {
    gasLimit: gasLimit.toString(),
    gasPrice: gasPrice.toString(),
    estimatedFeeNative: formatEther(estimatedFeeWei),
  };

  if (maxFeePerGas !== undefined) {
    result.maxFeePerGas = maxFeePerGas.toString();
  }
  if (maxPriorityFeePerGas !== undefined) {
    result.maxPriorityFeePerGas = maxPriorityFeePerGas.toString();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

/**
 * Validate an EVM (checksummed or lowercase) address.
 */
export function validateEVMAddress(address: string): boolean {
  try {
    return isAddress(address);
  } catch {
    return false;
  }
}
