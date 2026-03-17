import { ethers } from 'ethers';
import type { AppConfig, AuthMode, SignatureType } from './config.js';

export interface ExecutionContext {
  authMode: AuthMode;
  signatureType: SignatureType;
  signerAddress: string;
  funderAddress: string;
  balanceCheckAddress: string;
  allowanceCheckAddress: string;
  positionCheckAddress: string;
}

function normalizeAddress(value: string, fieldName: string): string {
  try {
    return ethers.utils.getAddress(value);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
}

export function getActiveSignatureType(config: AppConfig): SignatureType {
  if (config.auth.signatureType !== undefined) {
    return config.auth.signatureType;
  }

  if (config.auth.mode === 'EOA') {
    return 0;
  }

  if (config.SIMULATION_MODE) {
    return 0;
  }

  throw new Error(
    'PROXY mode requires SIGNATURE_TYPE to be set explicitly (1 for POLY_PROXY or 2 for GNOSIS_SAFE).'
  );
}

export function resolveSignerAddress(config: AppConfig): string {
  if (!config.signerPrivateKey && config.SIMULATION_MODE) {
    return ethers.constants.AddressZero;
  }

  try {
    const wallet = new ethers.Wallet(config.signerPrivateKey);
    return ethers.utils.getAddress(wallet.address);
  } catch {
    throw new Error('Invalid signer private key configured in SIGNER_PRIVATE_KEY/PRIVATE_KEY');
  }
}

export function resolveFunderAddress(config: AppConfig, signerAddress?: string): string {
  if (config.SIMULATION_MODE && !config.auth.funderAddress) {
    return ethers.constants.AddressZero;
  }

  if (config.auth.mode === 'PROXY') {
    return normalizeAddress(config.auth.funderAddress, 'FUNDER_ADDRESS');
  }

  return signerAddress ? normalizeAddress(signerAddress, 'signer address') : resolveSignerAddress(config);
}

export function getExecutionMode(context: ExecutionContext): AuthMode {
  return context.authMode;
}

export function getBalanceCheckAddress(context: ExecutionContext): string {
  return context.balanceCheckAddress;
}

export function getAllowanceCheckAddress(context: ExecutionContext): string {
  return context.allowanceCheckAddress;
}

export function getPositionCheckAddress(context: ExecutionContext): string {
  return context.positionCheckAddress;
}

export function createExecutionContext(config: AppConfig): ExecutionContext {
  const signerAddress = resolveSignerAddress(config);
  const funderAddress = resolveFunderAddress(config, signerAddress);
  const signatureType = getActiveSignatureType(config);

  return {
    authMode: config.auth.mode,
    signatureType,
    signerAddress,
    funderAddress,
    balanceCheckAddress: funderAddress,
    allowanceCheckAddress: funderAddress,
    positionCheckAddress: funderAddress,
  };
}
