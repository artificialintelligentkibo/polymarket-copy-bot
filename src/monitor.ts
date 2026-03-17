import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureLogsDirectory } from './trade-logger.js';

export type TradeOutcome = 'YES' | 'NO' | 'UNKNOWN';

export interface Trade {
  txHash: string;
  timestamp: number;
  market: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  outcome: TradeOutcome;
  marketTitle?: string;
  marketConditionId?: string;
  slotStart?: string;
}

export class TradeMonitor {
  private lastProcessedTimestamp: number = 0;
  private processedTradeIds: Set<string> = new Set();

  async initialize(): Promise<void> {
    await ensureLogsDirectory();
    if (config.SIMULATION_MODE) {
      console.log('🚀 SIMULATION MODE ACTIVE — no real trades');
    }
    this.lastProcessedTimestamp = Date.now();
    logger.info(`📊 Monitor initialized at ${new Date(this.lastProcessedTimestamp).toISOString()}`);
    logger.info(`   Will copy trades that occur AFTER this time`);
  }
  
  private async fetchTradesFromDataApi(): Promise<Trade[]> {
    try {
      const startSeconds = Math.floor(this.lastProcessedTimestamp / 1000) + 1;
      const response = await axios.get(
        'https://data-api.polymarket.com/activity',
        {
          params: {
            user: config.targetWallet.toLowerCase(),
            type: 'TRADE',
            limit: 100,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC',
            start: startSeconds,
          },
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (Array.isArray(response.data)) {
        return response.data.map(this.parseDataApiTrade.bind(this));
      }

      return [];
    } catch (error: any) {
      logger.warn(`⚠️  Could not fetch trades: ${error.message || 'Unknown error'}`);
      return [];
    }
  }

  private parseDataApiTrade(apiTrade: any): Trade {
    const marketTitle = this.extractMarketTitle(apiTrade);
    const marketConditionId = String(apiTrade.conditionId || apiTrade.market || '').trim();
    const slotStart = this.extractSlotStart(apiTrade, marketTitle);

    return {
      txHash: apiTrade.transactionHash || apiTrade.id || `trade-${apiTrade.timestamp}`,
      timestamp: apiTrade.timestamp * 1000,
      market: marketConditionId,
      tokenId: apiTrade.asset,
      side: apiTrade.side.toUpperCase() as 'BUY' | 'SELL',
      price: parseFloat(apiTrade.price),
      size: parseFloat(apiTrade.usdcSize || apiTrade.size),
      outcome: this.normalizeOutcome(apiTrade.outcome),
      ...(marketTitle ? { marketTitle } : {}),
      ...(marketConditionId ? { marketConditionId } : {}),
      ...(slotStart ? { slotStart } : {}),
    };
  }

  private normalizeOutcome(value: any): TradeOutcome {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized === 'YES' || normalized === 'NO') {
      return normalized;
    }
    return 'UNKNOWN';
  }
  
  async pollForNewTrades(callback: (trade: Trade) => Promise<void>): Promise<void> {
    try {
      const trades = await this.fetchTradesFromDataApi();

      if (trades.length === 0) {
        return;
      }

      const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);

      let newTradesCount = 0;

      for (const trade of sortedTrades) {
        const tradeId = trade.txHash;

        if (this.processedTradeIds.has(tradeId)) {
          continue;
        }

        if (trade.timestamp <= this.lastProcessedTimestamp) {
          continue;
        }

        this.processedTradeIds.add(tradeId);
        this.lastProcessedTimestamp = Math.max(this.lastProcessedTimestamp, trade.timestamp);
        newTradesCount++;

        logger.info(`🎯 New trade detected: ${trade.side} ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
        logger.info(`   Time: ${new Date(trade.timestamp).toISOString()}`);
        await callback(trade);
      }

      if (newTradesCount > 0) {
        logger.info(`🔍 Processed ${newTradesCount} new trade(s)`);
      }
    } catch (error: any) {
      logger.error(`❌ Error polling for trades:`, error.message);
    }
  }

  pruneProcessedHashes(): void {
    if (this.processedTradeIds.size > 10000) {
      const entries = Array.from(this.processedTradeIds);
      this.processedTradeIds = new Set(entries.slice(-5000));
    }
  }

  private extractMarketTitle(apiTrade: any): string | undefined {
    const candidates = [
      apiTrade?.marketTitle,
      apiTrade?.title,
      apiTrade?.question,
      apiTrade?.market_question,
      apiTrade?.event_title,
      apiTrade?.slug,
    ];

    return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim();
  }

  private extractSlotStart(apiTrade: any, marketTitle?: string): string | undefined {
    const directCandidate = apiTrade?.slotStart || apiTrade?.slot_start || apiTrade?.startTime;
    if (typeof directCandidate === 'string' && directCandidate.trim()) {
      return directCandidate.trim();
    }

    if (!marketTitle) {
      return undefined;
    }

    const match = marketTitle.match(/\b\d{1,2}:\d{2}(?:AM|PM)\b/i);
    return match?.[0]?.toUpperCase();
  }
}
