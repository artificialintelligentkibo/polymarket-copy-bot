import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { config } from './config.js';
import { createExecutionContext } from './execution-context.js';
import { logger } from './logger.js';

dotenv.config();

const HOST = 'https://clob.polymarket.com';

async function main(): Promise<void> {
  const apiKey = process.env.POLYMARKET_USER_API_KEY || process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_USER_SECRET || process.env.POLYMARKET_SECRET;
  const passphrase =
    process.env.POLYMARKET_USER_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE;

  if (!config.signerPrivateKey) {
    throw new Error('Missing SIGNER_PRIVATE_KEY or PRIVATE_KEY in .env');
  }
  if (!apiKey || !secret || !passphrase) {
    throw new Error(
      'Missing POLYMARKET_USER_API_KEY / POLYMARKET_USER_SECRET / POLYMARKET_USER_PASSPHRASE in .env'
    );
  }

  const signer = new Wallet(config.signerPrivateKey);
  const executionContext = createExecutionContext(config);
  const client = new ClobClient(
    HOST,
    config.chainId,
    signer,
    { key: apiKey, secret, passphrase },
    executionContext.signatureType,
    executionContext.funderAddress,
    config.polymarketGeoToken || undefined
  );

  const result: any = await client.getApiKeys();
  if (result?.error || result?.status >= 400) {
    throw new Error(result?.error || `API returned status ${result?.status}`);
  }

  logger.info('Static API credentials are valid for the configured execution context');
  logger.info(`   Auth mode: ${executionContext.authMode}`);
  logger.info(`   Signer address: ${executionContext.signerAddress}`);
  logger.info(`   Funder address: ${executionContext.funderAddress}`);
  logger.info(`   Signature type: ${executionContext.signatureType}`);
  logger.info(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  logger.error('API credential validation failed:', error.message || error);
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('unauthorized/invalid api key')) {
    logger.error('   Hint: Builder dashboard keys are not user trading credentials.');
    logger.error('   Generate user credentials from the signer private key with: npm run generate-api-creds');
  }
  process.exit(1);
});
