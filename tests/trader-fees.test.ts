import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFeeRateBps } from '../src/trader.js';

test('normalizeFeeRateBps keeps numeric fee rates unchanged', () => {
  assert.equal(normalizeFeeRateBps(1000), 1000);
  assert.equal(normalizeFeeRateBps(0), 0);
});

test('normalizeFeeRateBps parses string fee rates', () => {
  assert.equal(normalizeFeeRateBps('1000'), 1000);
  assert.equal(normalizeFeeRateBps(' 250 '), 250);
});

test('normalizeFeeRateBps extracts fee rates from object payloads', () => {
  assert.equal(normalizeFeeRateBps({ fee_rate_bps: '1000' }), 1000);
  assert.equal(normalizeFeeRateBps({ feeRateBps: 500 }), 500);
});

test('normalizeFeeRateBps falls back to 0 for unknown payloads', () => {
  assert.equal(normalizeFeeRateBps(undefined), 0);
  assert.equal(normalizeFeeRateBps(null), 0);
  assert.equal(normalizeFeeRateBps({}), 0);
  assert.equal(normalizeFeeRateBps('not-a-number'), 0);
});
