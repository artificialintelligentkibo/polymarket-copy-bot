import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import * as fs from 'fs';
import { config } from './config.js';
import { createExecutionContext } from './execution-context.js';
import { logger } from './logger.js';

dotenv.config();

const HOST = 'https://clob.polymarket.com';

async function main(): Promise<void> {
  if (!config.signerPrivateKey) {
    throw new Error('Missing SIGNER_PRIVATE_KEY or PRIVATE_KEY in .env');
  }

  const signer = new Wallet(config.signerPrivateKey);
  const executionContext = createExecutionContext(config);
  const client = new ClobClient(
    HOST,
    config.chainId,
    signer,
    undefined,
    undefined,
    undefined,
    config.polymarketGeoToken || undefined
  );

  logger.info('Generating user API credentials');
  logger.info(`   Auth mode: ${executionContext.authMode}`);
  logger.info(`   Signer address: ${executionContext.signerAddress}`);
  logger.info(`   Funder address: ${executionContext.funderAddress}`);
  logger.info(`   Signature type: ${executionContext.signatureType}`);

  let creds = await client.deriveApiKey().catch(() => null);
  if (!creds || (creds as any).error) {
    creds = await client.createApiKey();
  }

  const apiKey = (creds as any)?.apiKey || (creds as any)?.key;
  const secret = (creds as any)?.secret;
  const passphrase = (creds as any)?.passphrase;

  if (!apiKey || !secret || !passphrase) {
    throw new Error('Could not generate API credentials');
  }

  const outputFile = '.polymarket-api-creds';
  const fileContents =
    `POLYMARKET_USER_API_KEY=${apiKey}\n` +
    `POLYMARKET_USER_SECRET=${secret}\n` +
    `POLYMARKET_USER_PASSPHRASE=${passphrase}\n`;

  fs.writeFileSync(outputFile, fileContents, { mode: 0o600 });

  logger.info(
    `API credentials were generated successfully and written to ${outputFile}. Handle them securely.`
  );
}

main().catch((error) => {
  logger.error('Failed to generate API credentials:', error.message || error);
  process.exit(1);
});
