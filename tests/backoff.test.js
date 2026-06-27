require('ts-node/register');

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateBackoffDelayMs } = require('../src/api/client');

test('calculateBackoffDelayMs applies exponential backoff per retry attempt', () => {
  const baseBackoffMs = 1_500;

  const delays = [0, 1, 2, 3].map((retryCount) => calculateBackoffDelayMs(baseBackoffMs, retryCount));

  assert.deepEqual(delays, [1_500, 3_000, 6_000, 12_000]);
});
