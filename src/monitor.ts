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
  outcome: string;
  normalizedOutcome?: TradeOutcome;
  outcomeIndex?: number | null;
  asset?: string | null;
  marketTitle?: string;
  marketConditionId?: string;
  slotStart?: string;
  realizedPnlTarget?: number;
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
    const tokenId = String(
      apiTrade.asset ??
      apiTrade.asset_id ??
      apiTrade.tokenId ??
      apiTrade.token_id ??
      ''
    ).trim();
    const rawOutcome = this.detectRawOutcome(apiTrade, tokenId);
    const normalizedOutcome = this.detectNormalizedOutcome(apiTrade, tokenId, rawOutcome);
    const outcomeIndex = this.parseOutcomeIndex(apiTrade);
    const realizedPnlTarget = this.parseOptionalNumber(
      apiTrade.realizedPnl ??
      apiTrade.realized_pnl ??
      apiTrade.closedPnl ??
      apiTrade.closed_pnl ??
      apiTrade.pnl ??
      apiTrade.profit
    );

    return {
      txHash: apiTrade.transactionHash || apiTrade.id || `trade-${apiTrade.timestamp}`,
      timestamp: apiTrade.timestamp * 1000,
      market: marketConditionId,
      tokenId,
      side: this.normalizeAction(apiTrade.side),
      price: this.parseNumber(apiTrade.price),
      size: this.parseNumber(
        apiTrade.usdcSize ??
        apiTrade.usdc_size ??
        apiTrade.size ??
        apiTrade.amount
      ),
      outcome: rawOutcome,
      normalizedOutcome,
      outcomeIndex,
      asset: tokenId || null,
      ...(marketTitle ? { marketTitle } : {}),
      ...(marketConditionId ? { marketConditionId } : {}),
      ...(slotStart ? { slotStart } : {}),
      ...(realizedPnlTarget !== undefined ? { realizedPnlTarget } : {}),
    };
  }

  private normalizeAction(value: any): 'BUY' | 'SELL' {
    return String(value ?? '').trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  }

  private normalizeOutcome(value: any): TradeOutcome {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized === 'YES' || normalized === 'UP' || normalized === 'LONG' || normalized === 'TRUE') {
      return 'YES';
    }
    if (normalized === 'NO' || normalized === 'DOWN' || normalized === 'SHORT' || normalized === 'FALSE') {
      return 'NO';
    }
    return 'UNKNOWN';
  }

  private detectRawOutcome(apiTrade: any, tokenId: string): string {
    const directCandidates = [
      apiTrade?.outcome,
      apiTrade?.outcomeName,
      apiTrade?.outcome_name,
      apiTrade?.tokenOutcome,
      apiTrade?.token_outcome,
      apiTrade?.positionSide,
      apiTrade?.position_side,
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    const embeddedRawOutcome = this.detectRawOutcomeFromEmbeddedMarket(apiTrade, tokenId);
    if (embeddedRawOutcome !== 'UNKNOWN') {
      return embeddedRawOutcome;
    }

    return 'UNKNOWN';
  }

  private detectNormalizedOutcome(
    apiTrade: any,
    tokenId: string,
    rawOutcome: string
  ): TradeOutcome {
    const directNormalized = this.normalizeOutcome(rawOutcome);
    if (directNormalized !== 'UNKNOWN') {
      return directNormalized;
    }

    const embeddedTokenOutcome = this.detectOutcomeFromEmbeddedMarket(apiTrade, tokenId);
    if (embeddedTokenOutcome !== 'UNKNOWN') {
      return embeddedTokenOutcome;
    }

    const outcomeIndex = Number(
      apiTrade?.outcomeIndex ??
      apiTrade?.outcome_index ??
      apiTrade?.tokenOutcomeIndex ??
      apiTrade?.token_outcome_index
    );
    if (Number.isFinite(outcomeIndex)) {
      if (outcomeIndex === 0) {
        return 'YES';
      }
      if (outcomeIndex === 1) {
        return 'NO';
      }
    }

    // The activity API does not consistently expose tokenId -> YES/NO mappings,
    // so we explicitly fall back to UNKNOWN when the response is ambiguous.
    return 'UNKNOWN';
  }

  private parseOutcomeIndex(apiTrade: any): number | null {
    const value = Number(
      apiTrade?.outcomeIndex ??
      apiTrade?.outcome_index ??
      apiTrade?.tokenOutcomeIndex ??
      apiTrade?.token_outcome_index
    );

    return Number.isFinite(value) ? value : null;
  }

  private detectOutcomeFromEmbeddedMarket(apiTrade: any, tokenId: string): TradeOutcome {
    if (!tokenId) {
      return 'UNKNOWN';
    }

    const embeddedTokens = Array.isArray(apiTrade?.tokens) ? apiTrade.tokens : [];
    const tokenMatch = embeddedTokens.find((token: any) => {
      const candidate =
        token?.token_id ??
        token?.tokenId ??
        token?.asset_id ??
        token?.assetId ??
        '';
      return String(candidate).trim() === tokenId;
    });
    if (tokenMatch?.outcome) {
      return this.normalizeOutcome(tokenMatch.outcome);
    }

    const tokenIds = this.parseStringArray(apiTrade?.clobTokenIds ?? apiTrade?.tokenIds);
    const outcomes = this.parseStringArray(apiTrade?.outcomes);
    if (tokenIds.length > 0 && tokenIds.length === outcomes.length) {
      const outcomeIndex = tokenIds.findIndex((candidate) => candidate === tokenId);
      if (outcomeIndex >= 0) {
        return this.normalizeOutcome(outcomes[outcomeIndex]);
      }
    }

    return 'UNKNOWN';
  }

  private detectRawOutcomeFromEmbeddedMarket(apiTrade: any, tokenId: string): string {
    if (!tokenId) {
      return 'UNKNOWN';
    }

    const embeddedTokens = Array.isArray(apiTrade?.tokens) ? apiTrade.tokens : [];
    const tokenMatch = embeddedTokens.find((token: any) => {
      const candidate =
        token?.token_id ??
        token?.tokenId ??
        token?.asset_id ??
        token?.assetId ??
        '';
      return String(candidate).trim() === tokenId;
    });
    if (typeof tokenMatch?.outcome === 'string' && tokenMatch.outcome.trim()) {
      return tokenMatch.outcome.trim();
    }

    const tokenIds = this.parseStringArray(apiTrade?.clobTokenIds ?? apiTrade?.tokenIds);
    const outcomes = this.parseStringArray(apiTrade?.outcomes);
    if (tokenIds.length > 0 && tokenIds.length === outcomes.length) {
      const outcomeIndex = tokenIds.findIndex((candidate) => candidate === tokenId);
      if (outcomeIndex >= 0) {
        return String(outcomes[outcomeIndex] || 'UNKNOWN').trim() || 'UNKNOWN';
      }
    }

    return 'UNKNOWN';
  }

  private parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry));
    }

    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((entry) => String(entry));
        }
      } catch {
        return [];
      }
    }

    return [];
  }

  private parseOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private parseNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
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
