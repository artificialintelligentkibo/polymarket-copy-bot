import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { config } from './config.js';
import type { ExecutionContext } from './execution-context.js';
import { logger } from './logger.js';

const CTF_REDEEM_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
] as const;

interface PolymarketClientOptions {
  provider: ethers.providers.JsonRpcProvider;
  signerWallet: ethers.Wallet;
  executionContext: ExecutionContext;
  getClobClient: () => ClobClient;
  getTrackedMarketId?: (tokenId: string) => string | undefined;
  getGasOverrides?: () => Promise<ethers.providers.TransactionRequest>;
}

export class PolymarketClient {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly signerWallet: ethers.Wallet;
  private readonly executionContext: ExecutionContext;
  private readonly getClobClient: () => ClobClient;
  private readonly getTrackedMarketId?: (tokenId: string) => string | undefined;
  private readonly getGasOverrides?: () => Promise<ethers.providers.TransactionRequest>;
  private readonly ctf: ethers.Contract;

  constructor(options: PolymarketClientOptions) {
    this.provider = options.provider;
    this.signerWallet = options.signerWallet;
    this.executionContext = options.executionContext;
    this.getClobClient = options.getClobClient;
    this.getTrackedMarketId = options.getTrackedMarketId;
    this.getGasOverrides = options.getGasOverrides;
    this.ctf = new ethers.Contract(config.contracts.ctf, CTF_REDEEM_ABI, this.provider);
  }

  async getMarket(conditionId: string): Promise<any | null> {
    try {
      return await this.getClobClient().getMarket(conditionId);
    } catch (error: any) {
      logger.warn(
        `Could not fetch market metadata for ${conditionId}: ${error?.message || 'Unknown error'}`
      );
      return null;
    }
  }

  async isMarketResolved(conditionId: string): Promise<boolean> {
    const market = await this.getMarket(conditionId);
    const marketResolved = this.parseResolvedFromMarket(market);

    try {
      const payoutDenominator = await this.ctf.payoutDenominator(conditionId);
      const onChainResolved = !ethers.BigNumber.from(payoutDenominator).isZero();

      if (
        marketResolved !== undefined &&
        marketResolved !== onChainResolved
      ) {
        logger.warn(
          `Resolution mismatch for ${conditionId}: market API=${marketResolved}, on-chain=${onChainResolved}`
        );
      }

      return onChainResolved;
    } catch (error: any) {
      logger.warn(
        `Could not confirm on-chain resolution for ${conditionId}: ${error?.message || 'Unknown error'}`
      );
      return marketResolved === true;
    }
  }

  async getBestBidPrice(tokenId: string): Promise<number> {
    const orderbook = await this.getClobClient().getOrderBook(tokenId);
    return Number(orderbook?.bids?.[0]?.price || 0);
  }

  canDirectlyRedeem(): boolean {
    return (
      this.executionContext.funderAddress.toLowerCase() ===
      this.executionContext.signerAddress.toLowerCase()
    );
  }

  async redeem(tokenId: string, amount: number): Promise<void> {
    if (amount <= 0) {
      logger.info(`   Redeem skipped for ${tokenId}: amount is <= 0`);
      return;
    }

    if (!this.canDirectlyRedeem()) {
      throw new Error(
        `Auto redeem is not supported for signer ${this.executionContext.signerAddress} and funder ${this.executionContext.funderAddress}. The token-holding wallet must submit redeemPositions directly.`
      );
    }

    const conditionId = await this.getConditionIdForToken(tokenId);
    const resolved = await this.isMarketResolved(conditionId);
    if (!resolved) {
      throw new Error(`Market ${conditionId} is not resolved yet`);
    }

    const outcomeSlotCountRaw = await this.ctf.getOutcomeSlotCount(conditionId);
    const outcomeSlotCount = ethers.BigNumber.from(outcomeSlotCountRaw).toNumber();
    if (outcomeSlotCount <= 0) {
      throw new Error(`Invalid outcome slot count for market ${conditionId}: ${outcomeSlotCount}`);
    }

    const indexSets = Array.from({ length: outcomeSlotCount }, (_, index) =>
      ethers.BigNumber.from(1).shl(index)
    );

    const txOverrides = this.getGasOverrides ? await this.getGasOverrides() : undefined;

    logger.info(
      `   Redeeming resolved position ${tokenId} (${amount.toFixed(4)} tracked shares) for market ${conditionId}`
    );

    const tx = await this.ctf
      .connect(this.signerWallet)
      .redeemPositions(
        config.contracts.usdc,
        ethers.constants.HashZero,
        conditionId,
        indexSets,
        txOverrides
      );

    logger.info(`   Redeem tx submitted: ${tx.hash}`);
    await tx.wait();
    logger.info(`   Redeem tx confirmed: ${tx.hash}`);
  }

  private async getConditionIdForToken(tokenId: string): Promise<string> {
    const trackedMarketId = this.getTrackedMarketId?.(tokenId);
    if (trackedMarketId) {
      return trackedMarketId;
    }

    const orderbook = await this.getClobClient().getOrderBook(tokenId);
    const conditionId = String(orderbook?.market || '').trim();
    if (!conditionId) {
      throw new Error(`Could not resolve condition ID for token ${tokenId}`);
    }

    return conditionId;
  }

  private parseResolvedFromMarket(market: any): boolean | undefined {
    if (!market || typeof market !== 'object') {
      return undefined;
    }

    if (typeof market.resolved === 'boolean') {
      return market.resolved;
    }

    const statusCandidates = [
      market.umaResolutionStatus,
      market.resolutionStatus,
      market.marketStatus,
      market.status,
    ];

    for (const candidate of statusCandidates) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const normalized = candidate.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized.includes('resolved') || normalized.includes('final')) {
        return true;
      }
      if (
        normalized.includes('open') ||
        normalized.includes('active') ||
        normalized.includes('pending') ||
        normalized.includes('unresolved')
      ) {
        return false;
      }
    }

    if (typeof market.closed === 'boolean' && typeof market.acceptingOrders === 'boolean') {
      return market.closed && market.acceptingOrders === false;
    }

    return undefined;
  }
}
