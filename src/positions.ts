import { logger } from './logger.js';
import type { Trade } from './monitor.js';

export interface PositionState {
  tokenId: string;
  market: string;
  outcome: string;
  shares: number;
  notional: number;
  avgPrice: number;
  lastUpdated: number;
  resolved: boolean;
  redeemPending: boolean;
  redeemedShares: number;
  lastRedeemedAt?: number;
}

interface PositionSettlementHandlers {
  isMarketResolved?: (marketId: string) => Promise<boolean>;
  redeemPosition?: (tokenId: string, amount: number) => Promise<void>;
  getBestBidPrice?: (tokenId: string) => Promise<number>;
}

const MIN_POSITION_SHARES = 0.0001;
const MIN_POSITION_NOTIONAL = 0.01;

export class PositionTracker {
  private positions = new Map<string, PositionState>();
  private settlementHandlers: PositionSettlementHandlers = {};
  private readonly snapshotInterval: NodeJS.Timeout;

  constructor() {
    this.snapshotInterval = setInterval(() => {
      this.logOpenPositionsSnapshot();
    }, 30_000);
  }

  setSettlementHandlers(handlers: PositionSettlementHandlers): void {
    this.settlementHandlers = handlers;
  }

  loadFromClobPositions(positions: any[]): { loaded: number; skipped: number } {
    const nextPositions = new Map<string, PositionState>();
    let loaded = 0;
    let skipped = 0;

    for (const pos of positions || []) {
      const tokenId =
        pos?.asset_id ||
        pos?.token_id ||
        pos?.tokenId ||
        pos?.assetId ||
        (typeof pos?.asset === 'string' ? pos.asset : pos?.asset?.token_id);

      if (!tokenId) {
        skipped++;
        continue;
      }

      const existing = this.positions.get(tokenId);
      const market =
        pos?.condition_id ||
        pos?.conditionId ||
        pos?.market ||
        pos?.market_id ||
        existing?.market ||
        '';

      const outcome = pos?.outcome || pos?.side || existing?.outcome || 'YES';

      const shares = this.parseNumber(
        pos?.size ?? pos?.quantity ?? pos?.shares ?? pos?.balance ?? pos?.position
      );
      const notional = this.parseNumber(
        pos?.usdcValue ?? pos?.notional ?? pos?.usdc ?? pos?.value ?? pos?.collateral
      );
      const avgPrice =
        this.parseNumber(pos?.avgPrice ?? pos?.averagePrice ?? pos?.entryPrice ?? pos?.price) ||
        (shares > 0 ? Math.abs(notional / shares) : 0);

      if (shares < MIN_POSITION_SHARES || notional < MIN_POSITION_NOTIONAL) {
        skipped++;
        continue;
      }

      const redeemedShares = Math.min(existing?.redeemedShares || 0, shares);
      const state: PositionState = {
        tokenId,
        market,
        outcome,
        shares: Math.max(0, shares),
        notional: Math.max(0, notional),
        avgPrice,
        lastUpdated: Date.now(),
        resolved: existing?.resolved || false,
        redeemPending: false,
        redeemedShares,
        lastRedeemedAt: existing?.lastRedeemedAt,
      };

      nextPositions.set(tokenId, state);
      loaded++;
    }

    this.positions = nextPositions;
    return { loaded, skipped };
  }

  recordFill(params: {
    trade: Trade;
    notional: number;
    shares: number;
    price: number;
    side: 'BUY' | 'SELL';
  }): void {
    const { trade, notional, shares, price, side } = params;
    const key = trade.tokenId;
    const existing = this.positions.get(key);

    const sign = side === 'BUY' ? 1 : -1;
    const deltaShares = shares * sign;
    const deltaNotional = notional * sign;

    const nextShares = (existing?.shares || 0) + deltaShares;
    const nextNotional = (existing?.notional || 0) + deltaNotional;

    if (nextShares <= MIN_POSITION_SHARES || nextNotional <= MIN_POSITION_NOTIONAL) {
      this.positions.delete(key);
      return;
    }

    const updated: PositionState = {
      tokenId: trade.tokenId,
      market: trade.market,
      outcome: trade.outcome,
      shares: Math.max(0, nextShares),
      notional: Math.max(0, nextNotional),
      avgPrice: price > 0 ? price : existing?.avgPrice || 0,
      lastUpdated: Date.now(),
      resolved: side === 'BUY' ? false : existing?.resolved || false,
      redeemPending: false,
      redeemedShares: side === 'BUY' ? 0 : Math.min(existing?.redeemedShares || 0, Math.max(0, nextShares)),
      lastRedeemedAt: existing?.lastRedeemedAt,
    };

    this.positions.set(key, updated);
  }

  getPosition(tokenId: string): PositionState | undefined {
    const position = this.positions.get(tokenId);
    if (!position) {
      return undefined;
    }

    return {
      ...position,
      redeemedShares: Math.min(position.redeemedShares, position.shares),
    };
  }

  getSellableShares(tokenId: string): number {
    return this.getWinningShares(tokenId);
  }

  getWinningShares(tokenId: string): number {
    const position = this.positions.get(tokenId);
    if (!position) {
      return 0;
    }

    const remainingShares = position.shares - position.redeemedShares;
    return Math.max(0, remainingShares);
  }

  getOpenPositions(): PositionState[] {
    return Array.from(this.positions.values())
      .map((position) => this.getPosition(position.tokenId))
      .filter((position): position is PositionState => {
        if (!position) {
          return false;
        }

        return (
          !position.redeemPending &&
          this.getWinningShares(position.tokenId) > MIN_POSITION_SHARES
        );
      });
  }

  async isMarketResolved(marketId: string): Promise<boolean> {
    if (!this.settlementHandlers.isMarketResolved) {
      return false;
    }

    const resolved = await this.settlementHandlers.isMarketResolved(marketId);
    if (resolved) {
      for (const position of this.positions.values()) {
        if (position.market === marketId) {
          position.resolved = true;
          position.lastUpdated = Date.now();
        }
      }
    }

    return resolved;
  }

  async redeemPosition(tokenId: string, amount: number): Promise<void> {
    if (!this.settlementHandlers.redeemPosition) {
      throw new Error('Redeem handler is not configured');
    }

    const position = this.positions.get(tokenId);
    if (!position) {
      return;
    }

    const relatedPositions = Array.from(this.positions.values()).filter(
      (entry) => entry.market === position.market
    );

    for (const entry of relatedPositions) {
      entry.redeemPending = true;
      entry.resolved = true;
      entry.lastUpdated = Date.now();
    }

    try {
      await this.settlementHandlers.redeemPosition(tokenId, amount);
      const redeemedAt = Date.now();

      for (const entry of relatedPositions) {
        entry.redeemedShares = entry.shares;
        entry.redeemPending = false;
        entry.lastRedeemedAt = redeemedAt;
        entry.lastUpdated = redeemedAt;
        this.positions.delete(entry.tokenId);
      }

      logger.info(
        `Redeemed tracked position(s) for market ${position.market}; removed ${relatedPositions.length} cached position(s)`
      );
    } catch (error) {
      for (const entry of relatedPositions) {
        entry.redeemPending = false;
        entry.lastUpdated = Date.now();
      }
      throw error;
    }
  }

  async getBestBidPrice(tokenId: string): Promise<number> {
    if (!this.settlementHandlers.getBestBidPrice) {
      return 0;
    }

    return this.settlementHandlers.getBestBidPrice(tokenId);
  }

  getPositions(): PositionState[] {
    return Array.from(this.positions.values()).map((position) => ({
      ...position,
      redeemedShares: Math.min(position.redeemedShares, position.shares),
    }));
  }

  getNotional(tokenId: string): number {
    return this.positions.get(tokenId)?.notional || 0;
  }

  getTotalNotional(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.notional;
    }
    return total;
  }

  private parseNumber(value: any): number {
    const n = typeof value === 'string' ? parseFloat(value) : Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private logOpenPositionsSnapshot(): void {
    const openPositions = this.getOpenPositions();
    if (openPositions.length === 0) {
      logger.info('[positions] open positions snapshot: none');
      return;
    }

    const summary = openPositions
      .map(
        (position) =>
          `${position.market}:${position.outcome} shares=${position.shares.toFixed(4)} notional=${position.notional.toFixed(2)} avg=${position.avgPrice.toFixed(4)}`
      )
      .join(' | ');

    logger.info(`[positions] open positions snapshot (${openPositions.length}): ${summary}`);
  }
}
