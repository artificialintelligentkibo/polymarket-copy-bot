import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

const LOGS_DIRECTORY = path.resolve(process.cwd(), 'logs');
const CACHE_WINDOW_MS = 60_000;
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
  side: 'YES' | 'NO' | 'UNKNOWN';
  token_price: number;
  shares: number;
  usdc_amount: number;
  target_tx_hash_or_id: string;
  simulated_pnl_if_closed_now: number;
  is_copy_from_target: boolean;
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
let exchangePromise: Promise<OhlcvCapableExchange> | undefined;

export async function ensureLogsDirectory(): Promise<string> {
  await mkdir(LOGS_DIRECTORY, { recursive: true });
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
  const crypto_prices_at_time = await getCryptoPrices(payload.timestamp_ms);
  const record = {
    ...payload,
    token_price: roundTo(payload.token_price, 6),
    shares: roundTo(payload.shares, 4),
    usdc_amount: roundTo(payload.usdc_amount, 2),
    simulated_pnl_if_closed_now: roundTo(payload.simulated_pnl_if_closed_now, 2),
    crypto_prices_at_time,
  };

  const filePath = path.join(
    LOGS_DIRECTORY,
    `trades_${new Date(payload.timestamp_ms).toISOString().slice(0, 10)}.jsonl`
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

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}
