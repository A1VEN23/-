export type Chain =
  | 'ethereum'
  | 'bsc'
  | 'polygon'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'solana'
  | 'ton'
  | 'tron'
  | 'bitcoin'
  | 'cosmos'
  | 'xrp'
  | 'litecoin'
  | 'dogecoin'
  | 'aptos'
  | 'near';

export interface WalletData {
  address: string;
  privateKey: string;
  publicKey: string;
  mnemonic?: string;
  chain: Chain;
  /** Derivation path used to derive this wallet */
  derivationPath?: string;
}

export interface TxParams {
  to: string;
  /** Amount in the chain's native smallest unit (wei, lamports, etc.) unless noted */
  amount: string;
  /** Optional memo / data field */
  data?: string;
  /** Optional gas limit override (EVM) */
  gasLimit?: string;
  /** Optional gas price override in wei (EVM legacy) */
  gasPrice?: string;
  /** Optional EIP-1559 max fee per gas in wei */
  maxFeePerGas?: string;
  /** Optional EIP-1559 max priority fee per gas in wei */
  maxPriorityFeePerGas?: string;
  /** Optional nonce override (EVM) */
  nonce?: number;
}

export interface TxResult {
  txHash: string;
  /** Whether the tx was successfully broadcast (does NOT mean confirmed) */
  success: boolean;
  /** Block number / slot in which the tx was included (if known) */
  blockNumber?: number;
  /** Explorer URL for the transaction */
  explorerUrl?: string;
  /** Any extra chain-specific metadata */
  raw?: unknown;
}

export interface GasEstimate {
  /** Estimated gas units */
  gasLimit: string;
  /** Gas price in native smallest unit (wei, etc.) */
  gasPrice: string;
  /** EIP-1559 max fee per gas (EVM only) */
  maxFeePerGas?: string;
  /** EIP-1559 max priority fee per gas (EVM only) */
  maxPriorityFeePerGas?: string;
  /** Total estimated fee in the chain's native unit (e.g. ETH, not wei) */
  estimatedFeeNative: string;
}
