import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import { createConfig, validateConfig } from '../src/config.js';
import {
  createExecutionContext,
  getAllowanceCheckAddress,
  getBalanceCheckAddress,
  getPositionCheckAddress,
} from '../src/execution-context.js';

const LEGACY_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SIGNER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f094538f5d71ad5e7b5c4c4f9f7f7c2f1d6f4e90';
const EXECUTION_PRIVATE_KEY =
  '0x8b3a350cf5c34c9194ca9a9c0f3f76fb1b0c7b97d9f1df59fe2f25b98e65ce6d';
const TARGET_WALLET = '0x0000000000000000000000000000000000000001';
const FUNDER_ADDRESS = '0x1111111111111111111111111111111111111111';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TARGET_WALLET,
    RPC_URL: 'https://polygon-rpc.com',
    ...overrides,
  };
}

test('legacy PRIVATE_KEY config defaults to EOA mode', () => {
  const cfg = createConfig(baseEnv({ PRIVATE_KEY: LEGACY_PRIVATE_KEY }));
  validateConfig(cfg);

  const context = createExecutionContext(cfg);
  const expectedSigner = ethers.utils.getAddress(new ethers.Wallet(LEGACY_PRIVATE_KEY).address);

  assert.equal(cfg.auth.mode, 'EOA');
  assert.equal(context.signatureType, 0);
  assert.equal(context.signerAddress, expectedSigner);
  assert.equal(context.funderAddress, expectedSigner);
  assert.equal(getBalanceCheckAddress(context), expectedSigner);
  assert.equal(getAllowanceCheckAddress(context), expectedSigner);
  assert.equal(getPositionCheckAddress(context), expectedSigner);
});

test('SIGNER_PRIVATE_KEY takes precedence over PRIVATE_KEY', () => {
  const cfg = createConfig(
    baseEnv({
      PRIVATE_KEY: LEGACY_PRIVATE_KEY,
      SIGNER_PRIVATE_KEY: SIGNER_PRIVATE_KEY,
    })
  );
  validateConfig(cfg);

  const context = createExecutionContext(cfg);
  const expectedSigner = ethers.utils.getAddress(new ethers.Wallet(SIGNER_PRIVATE_KEY).address);

  assert.equal(context.signerAddress, expectedSigner);
  assert.equal(context.funderAddress, expectedSigner);
});

test('EXECUTION_WALLET_PRIVATE_KEY is accepted as a legacy-compatible alias', () => {
  const cfg = createConfig(
    baseEnv({
      EXECUTION_WALLET_PRIVATE_KEY: EXECUTION_PRIVATE_KEY,
    })
  );
  validateConfig(cfg);

  const context = createExecutionContext(cfg);
  const expectedSigner = ethers.utils.getAddress(new ethers.Wallet(EXECUTION_PRIVATE_KEY).address);

  assert.equal(context.signerAddress, expectedSigner);
  assert.equal(context.funderAddress, expectedSigner);
});

test('proxy mode resolves signer and funder separately for all address-sensitive checks', () => {
  const cfg = createConfig(
    baseEnv({
      AUTH_MODE: 'PROXY',
      SIGNATURE_TYPE: '2',
      SIGNER_PRIVATE_KEY: SIGNER_PRIVATE_KEY,
      FUNDER_ADDRESS,
    })
  );
  validateConfig(cfg);

  const context = createExecutionContext(cfg);
  const expectedSigner = ethers.utils.getAddress(new ethers.Wallet(SIGNER_PRIVATE_KEY).address);
  const expectedFunder = ethers.utils.getAddress(FUNDER_ADDRESS);

  assert.equal(cfg.auth.mode, 'PROXY');
  assert.equal(context.signatureType, 2);
  assert.equal(context.signerAddress, expectedSigner);
  assert.equal(context.funderAddress, expectedFunder);
  assert.equal(getBalanceCheckAddress(context), expectedFunder);
  assert.equal(getAllowanceCheckAddress(context), expectedFunder);
  assert.equal(getPositionCheckAddress(context), expectedFunder);
});

test('proxy mode requires an explicit non-EOA signature type', () => {
  const missingSignatureType = createConfig(
    baseEnv({
      AUTH_MODE: 'PROXY',
      SIGNER_PRIVATE_KEY: SIGNER_PRIVATE_KEY,
      FUNDER_ADDRESS,
    })
  );

  assert.throws(
    () => validateConfig(missingSignatureType),
    /SIGNATURE_TYPE/
  );

  const invalidSignatureType = createConfig(
    baseEnv({
      AUTH_MODE: 'PROXY',
      SIGNATURE_TYPE: '0',
      SIGNER_PRIVATE_KEY: SIGNER_PRIVATE_KEY,
      FUNDER_ADDRESS,
    })
  );

  assert.throws(
    () => validateConfig(invalidSignatureType),
    /SIGNATURE_TYPE to be 1 or 2/
  );
});
