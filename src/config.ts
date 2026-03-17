import dotenv from 'dotenv';
import { logger } from './logger.js';

dotenv.config();

export type AuthMode = 'EOA' | 'PROXY';
export type SignatureType = 0 | 1 | 2;

export interface AppConfig {
  SIMULATION_MODE: boolean;
  targetWallet: string;
  signerPrivateKey: string;
  polymarketGeoToken: string;
  rpcUrl: string;
  chainId: number;
  auth: {
    mode: AuthMode;
    signatureType?: SignatureType;
    funderAddress: string;
  };
  contracts: {
    exchange: string;
    ctf: string;
    usdc: string;
    negRiskAdapter: string;
    negRiskExchange: string;
  };
  trading: {
    positionSizeMultiplier: number;
    maxTradeSize: number;
    minTradeSize: number;
    slippageTolerance: number;
    orderType: 'LIMIT' | 'GTC' | 'FOK' | 'FAK';
    orderTypeFallback: 'GTC' | 'NONE';
    copySells: boolean;
    autoRedeem: boolean;
    autoSellThreshold: number;
    redeemIntervalMs: number;
  };
  risk: {
    maxSessionNotional: number;
    maxPerMarketNotional: number;
  };
  run: {
    exitAfterFirstSellCopy: boolean;
  };
  monitoring: {
    pollInterval: number;
    useWebSocket: boolean;
    useUserChannel: boolean;
    wsAssetIds: string[];
    wsMarketIds: string[];
  };
}

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseFloatOrDefault(value: string | undefined, fallback: string): number {
  const parsed = Number.parseFloat(value ?? fallback);
  if (Number.isNaN(parsed)) {
    return Number.parseFloat(fallback);
  }
  return parsed;
}

function parseIntOrDefault(value: string | undefined, fallback: string): number {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (Number.isNaN(parsed)) {
    return Number.parseInt(fallback, 10);
  }
  return parsed;
}

function parseAuthMode(value?: string): AuthMode {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) {
    return 'EOA';
  }
  if (normalized === 'EOA' || normalized === 'PROXY') {
    return normalized;
  }
  throw new Error(`Invalid AUTH_MODE: ${value}. Expected EOA or PROXY.`);
}

function parseSignatureType(value?: string): SignatureType | undefined {
  if (!value || value.trim() === '') {
    return undefined;
  }

  if (value === '0' || value === '1' || value === '2') {
    return Number.parseInt(value, 10) as SignatureType;
  }

  throw new Error(`Invalid SIGNATURE_TYPE: ${value}. Expected 0, 1, or 2.`);
}

function resolveSignerPrivateKey(env: NodeJS.ProcessEnv): string {
  return (
    env.SIGNER_PRIVATE_KEY ||
    env.EXECUTION_WALLET_PRIVATE_KEY ||
    env.PRIVATE_KEY ||
    ''
  ).trim();
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authMode = parseAuthMode(env.AUTH_MODE);
  const signatureType = parseSignatureType(env.SIGNATURE_TYPE);

  return {
    SIMULATION_MODE: env.SIMULATION_MODE === 'true',
    targetWallet: (env.TARGET_WALLET || '').trim(),
    signerPrivateKey: resolveSignerPrivateKey(env),
    polymarketGeoToken: env.POLYMARKET_GEO_TOKEN || '',
    rpcUrl: env.RPC_URL || 'https://polygon.drpc.org',
    chainId: 137,
    auth: {
      mode: authMode,
      signatureType,
      funderAddress: (env.FUNDER_ADDRESS || '').trim(),
    },
    contracts: {
      exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
      ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
      usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
      negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
    },
    trading: {
      positionSizeMultiplier: parseFloatOrDefault(env.POSITION_MULTIPLIER, '0.05'),
      maxTradeSize: parseFloatOrDefault(env.MAX_TRADE_SIZE, '5'),
      minTradeSize: parseFloatOrDefault(env.MIN_TRADE_SIZE, '1.10'),
      slippageTolerance: parseFloatOrDefault(env.SLIPPAGE_TOLERANCE, '0.02'),
      orderType: (env.ORDER_TYPE || 'GTC') as 'LIMIT' | 'GTC' | 'FOK' | 'FAK',
      orderTypeFallback: (env.ORDER_TYPE_FALLBACK || 'GTC') as 'GTC' | 'NONE',
      copySells: env.COPY_SELLS === 'true',
      autoRedeem: env.AUTO_REDEEM !== 'false',
      autoSellThreshold: parseFloatOrDefault(env.AUTO_SELL_THRESHOLD, '0.88'),
      redeemIntervalMs: parseIntOrDefault(env.REDEEM_INTERVAL_MS, '30000'),
    },
    risk: {
      maxSessionNotional: parseFloatOrDefault(env.MAX_SESSION_NOTIONAL, '0'),
      maxPerMarketNotional: parseFloatOrDefault(env.MAX_PER_MARKET_NOTIONAL, '0'),
    },
    run: {
      exitAfterFirstSellCopy: env.EXIT_AFTER_FIRST_SELL_COPY === 'true',
    },
    monitoring: {
      pollInterval: parseIntOrDefault(env.POLL_INTERVAL, '2000'),
      useWebSocket: env.USE_WEBSOCKET !== 'false',
      useUserChannel: env.USE_USER_CHANNEL === 'true',
      wsAssetIds: parseCsv(env.WS_ASSET_IDS),
      wsMarketIds: parseCsv(env.WS_MARKET_IDS),
    },
  };
}

export const config = createConfig();

export function validateConfig(candidate: AppConfig = config): void {
  if (!candidate.targetWallet) {
    throw new Error('Missing required config: targetWallet');
  }

  if (!candidate.signerPrivateKey && !candidate.SIMULATION_MODE) {
    throw new Error(
      'Missing required signer private key. Set SIGNER_PRIVATE_KEY or PRIVATE_KEY.'
    );
  }

  if (candidate.auth.mode === 'PROXY' && !candidate.SIMULATION_MODE) {
    if (!candidate.auth.funderAddress) {
      throw new Error('Missing required config for PROXY mode: FUNDER_ADDRESS');
    }

    if (candidate.auth.signatureType === undefined) {
      throw new Error(
        'Missing required config for PROXY mode: SIGNATURE_TYPE (set 1 for POLY_PROXY or 2 for GNOSIS_SAFE).'
      );
    }

    if (candidate.auth.signatureType === 0) {
      throw new Error('PROXY mode requires SIGNATURE_TYPE to be 1 or 2.');
    }
  }

  const signatureType = candidate.auth.signatureType ?? 0;
  const funderLabel =
    candidate.auth.mode === 'PROXY'
      ? candidate.auth.funderAddress
      : 'resolved from signer wallet';

  if (
    candidate.trading.autoSellThreshold <= 0 ||
    candidate.trading.autoSellThreshold >= 1
  ) {
    throw new Error(
      `AUTO_SELL_THRESHOLD must be between 0 and 1 (exclusive). Received ${candidate.trading.autoSellThreshold}.`
    );
  }

  if (candidate.trading.redeemIntervalMs < 1000) {
    throw new Error(
      `REDEEM_INTERVAL_MS must be at least 1000ms. Received ${candidate.trading.redeemIntervalMs}.`
    );
  }

  logger.info('API credentials will be derived/generated from the configured signer at startup');
  logger.info('Configuration validated');
  logger.info(`   Auth mode: ${candidate.auth.mode}`);
  logger.info(`   Signature type: ${signatureType}`);
  logger.info(`   Funder setting: ${funderLabel}`);
  logger.info(`   Simulation mode: ${candidate.SIMULATION_MODE ? 'enabled' : 'disabled'}`);
  logger.info(`   Auto redeem enabled: ${candidate.trading.autoRedeem ? 'yes' : 'no'}`);
  logger.info(`   Auto sell threshold: ${candidate.trading.autoSellThreshold}`);
  logger.info(`   Redeem interval: ${candidate.trading.redeemIntervalMs}ms`);

  if (candidate.SIMULATION_MODE) {
    logger.warn('SIMULATION_MODE is enabled. No live order placement will be performed.');
  }

  if (candidate.trading.autoRedeem && candidate.auth.mode === 'PROXY') {
    logger.warn(
      'AUTO_REDEEM is enabled in PROXY mode. Auto-sell still works, but on-chain redeem requires the token-holding wallet to submit the transaction directly.'
    );
  }
}
