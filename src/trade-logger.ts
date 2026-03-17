import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import type { TradeOutcome } from './monitor.js';

const LOGS_DIRECTORY = path.resolve(process.cwd(), 'logs');
const CACHE_WINDOW_MS = 60_000;
const NET_POSITION_LOG_INTERVAL_MS = 10_000;
const ACTIVE_POSITION_EPSILON = 0.0001;
const BINANCE_SYMBOLS = {
  BTC: 'BTC/USDT',
  ETH: 'ETH/USDT',
  SOL: 'SOL/USDT',
  XRP: 'XRP/USDT',
} as const;

type CryptoSymbol = keyof typeof BINANCE_SYMBOLS;

export interface CryptoPricesAtTime {
  BTC: number;
  ETH: number;
  SOL: number;
  XRP: number;
}

export interface SimulatedTradeLogPayload {
  timestamp_ms: number;
  market_title: string;
  market_condition_id: string;
  slot_start: string;
  action: 'BUY' | 'SELL';
  outcome: string;
  outcomeIndex: number | null;
  asset: string | null;
  resolved_outcome?: TradeOutcome;
  token_price: number;
  shares: number;
  usdc_amount: number;
  target_tx_hash_or_id: string;
  mid_price_orderbook: number;
  realized_pnl_target: number;
  simulated_pnl_if_closed_now: number;
  is_copy_from_target: boolean;
}

interface SimulatedTradeLogRecord extends SimulatedTradeLogPayload {
  crypto_prices_at_time: CryptoPricesAtTime;
  net_position_yes: number;
  net_position_no: number;
}

interface MarketNetPositionState {
  marketTitle: string;
  slotStart: string;
  yes: number;
  no: number;
  updatedAt: number;
}

interface OhlcvCapableExchange {
  loadMarkets(): Promise<unknown>;
  fetchOHLCV(
    symbol: string,
    timeframe?: string,
    since?: number,
    limit?: number
  ): Promise<Array<[number, number, number, number, number, number]>>;
}

const cryptoPriceCache = new Map<number, CryptoPricesAtTime>();
const marketNetPositions = new Map<string, MarketNetPositionState>();
let exchangePromise: Promise<OhlcvCapableExchange> | undefined;
let netPositionReporter: ReturnType<typeof setInterval> | undefined;

export async function ensureLogsDirectory(): Promise<string> {
  await mkdir(LOGS_DIRECTORY, { recursive: true });
  if (config.SIMULATION_MODE) {
    ensureNetPositionReporterStarted();
  }
  return LOGS_DIRECTORY;
}

export async function getCryptoPrices(timestampMs: number): Promise<CryptoPricesAtTime> {
  const minuteBucket = Math.floor(timestampMs / CACHE_WINDOW_MS) * CACHE_WINDOW_MS;
  const cached = cryptoPriceCache.get(minuteBucket);
  if (cached) {
    return cached;
  }

  try {
    const exchange = await getBinanceExchange();
    const entries = await Promise.all(
      (Object.entries(BINANCE_SYMBOLS) as Array<[CryptoSymbol, string]>).map(
        async ([symbolKey, symbol]) => {
          const price = await fetchCandleClose(exchange, symbol, minuteBucket);
          return [symbolKey, price] as const;
        }
      )
    );

    const snapshot = Object.fromEntries(entries) as CryptoPricesAtTime;
    cryptoPriceCache.set(minuteBucket, snapshot);
    pruneOldPriceCache(minuteBucket);
    return snapshot;
  } catch (error: any) {
    logger.warn(
      `Could not fetch CCXT crypto prices for ${new Date(timestampMs).toISOString()}: ${error?.message || 'Unknown error'}`
    );
    const fallback = emptyCryptoPrices();
    cryptoPriceCache.set(minuteBucket, fallback);
    pruneOldPriceCache(minuteBucket);
    return fallback;
  }
}

export async function logSimulatedTrade(payload: SimulatedTradeLogPayload): Promise<void> {
  await ensureLogsDirectory();

  const { resolved_outcome, ...serializablePayload } = payload;
  const normalizedOutcome = normalizeOutcome(payload.resolved_outcome ?? payload.outcome);
  const rawOutcome = String(payload.outcome || 'UNKNOWN').trim() || 'UNKNOWN';
  const netPosition = applyTradeToNetPositions({
    ...payload,
    outcome: rawOutcome,
    resolved_outcome: normalizedOutcome,
  });
  const crypto_prices_at_time = await getCryptoPrices(payload.timestamp_ms);

  const record: SimulatedTradeLogRecord = {
    ...serializablePayload,
    outcome: rawOutcome,
    outcomeIndex: payload.outcomeIndex ?? null,
    asset: payload.asset ?? null,
    token_price: roundTo(payload.token_price, 6),
    shares: roundTo(payload.shares, 4),
    usdc_amount: roundTo(payload.usdc_amount, 2),
    mid_price_orderbook: roundTo(payload.mid_price_orderbook, 6),
    realized_pnl_target: roundTo(payload.realized_pnl_target, 2),
    simulated_pnl_if_closed_now: roundTo(payload.simulated_pnl_if_closed_now, 2),
    net_position_yes: roundTo(netPosition.yes, 4),
    net_position_no: roundTo(netPosition.no, 4),
    crypto_prices_at_time,
  };

  await appendToJSONL(record);
}

function ensureNetPositionReporterStarted(): void {
  if (netPositionReporter) {
    return;
  }

  netPositionReporter = setInterval(() => {
    const activeSlots = Array.from(marketNetPositions.entries())
      .filter(([, state]) => hasActiveExposure(state))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt);

    if (activeSlots.length === 0) {
      console.log('[simulation net] active slots: none');
      return;
    }

    const summary = activeSlots
      .map(([marketConditionId, state]) => {
        const label = truncateLabel(state.marketTitle || marketConditionId);
        return `${label} [${state.slotStart}] YES=${roundTo(state.yes, 4)} NO=${roundTo(state.no, 4)}`;
      })
      .join(' | ');

    console.log(`[simulation net] active slots: ${summary}`);
  }, NET_POSITION_LOG_INTERVAL_MS);

  netPositionReporter.unref?.();
}

function hasActiveExposure(state: MarketNetPositionState): boolean {
  return (
    Math.abs(state.yes) > ACTIVE_POSITION_EPSILON ||
    Math.abs(state.no) > ACTIVE_POSITION_EPSILON
  );
}

function truncateLabel(value: string): string {
  const normalized = String(value || '').trim();
  if (normalized.length <= 64) {
    return normalized;
  }
  return `${normalized.slice(0, 61)}...`;
}

function applyTradeToNetPositions(
  payload: SimulatedTradeLogPayload
): MarketNetPositionState {
  const marketConditionId = payload.market_condition_id || 'UNKNOWN';
  const existing = marketNetPositions.get(marketConditionId);
  const state: MarketNetPositionState = {
    marketTitle: payload.market_title || existing?.marketTitle || marketConditionId,
    slotStart: payload.slot_start || existing?.slotStart || 'UNKNOWN',
    yes: existing?.yes || 0,
    no: existing?.no || 0,
    updatedAt: payload.timestamp_ms,
  };

  const signedShares = payload.action === 'BUY' ? payload.shares : -payload.shares;
  const normalizedOutcome = normalizeOutcome(payload.resolved_outcome ?? payload.outcome);
  if (normalizedOutcome === 'YES') {
    state.yes += signedShares;
  } else if (normalizedOutcome === 'NO') {
    state.no += signedShares;
  } else {
    // The activity API is inconsistent about tokenId -> YES/NO mappings, so keep
    // UNKNOWN trades out of per-outcome net exposure math until we can classify them.
  }

  marketNetPositions.set(marketConditionId, state);
  return state;
}

async function appendToJSONL(record: SimulatedTradeLogRecord): Promise<void> {
  const filePath = path.join(
    LOGS_DIRECTORY,
    `trades_${new Date(record.timestamp_ms).toISOString().slice(0, 10)}.jsonl`
  );

  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function emptyCryptoPrices(): CryptoPricesAtTime {
  return {
    BTC: 0,
    ETH: 0,
    SOL: 0,
    XRP: 0,
  };
}

async function getBinanceExchange(): Promise<OhlcvCapableExchange> {
  if (!exchangePromise) {
    exchangePromise = import('ccxt').then(async (ccxtModule) => {
      const ExchangeCtor = (
        ccxtModule as unknown as {
          binance: new (options?: object) => OhlcvCapableExchange;
        }
      ).binance;
      const exchange = new ExchangeCtor({
        enableRateLimit: true,
        options: {
          defaultType: 'spot',
        },
      });
      await exchange.loadMarkets();
      return exchange;
    });
  }

  return exchangePromise;
}

async function fetchCandleClose(
  exchange: OhlcvCapableExchange,
  symbol: string,
  minuteBucket: number
): Promise<number> {
  const candles = await exchange.fetchOHLCV(symbol, '1m', minuteBucket, 1);
  const directClose = extractClosePrice(candles[0]);
  if (directClose > 0) {
    return directClose;
  }

  const fallbackCandles = await exchange.fetchOHLCV(
    symbol,
    '1m',
    minuteBucket - CACHE_WINDOW_MS,
    2
  );
  const exactFallback = fallbackCandles.find((entry) => entry?.[0] === minuteBucket);
  const fallbackClose = extractClosePrice(exactFallback ?? fallbackCandles.at(-1));
  if (fallbackClose > 0) {
    return fallbackClose;
  }

  throw new Error(`No Binance OHLCV candle returned for ${symbol} @ ${minuteBucket}`);
}

function extractClosePrice(
  candle?: [number, number, number, number, number, number]
): number {
  const close = Number(candle?.[4] ?? 0);
  return Number.isFinite(close) && close > 0 ? close : 0;
}

function pruneOldPriceCache(latestBucket: number): void {
  for (const bucket of cryptoPriceCache.keys()) {
    if (latestBucket - bucket > CACHE_WINDOW_MS * 10) {
      cryptoPriceCache.delete(bucket);
    }
  }
}

function normalizeOutcome(value: unknown): TradeOutcome {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'YES' || normalized === 'UP' || normalized === 'LONG' || normalized === 'TRUE') {
    return 'YES';
  }
  if (normalized === 'NO' || normalized === 'DOWN' || normalized === 'SHORT' || normalized === 'FALSE') {
    return 'NO';
  }
  return 'UNKNOWN';
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}
