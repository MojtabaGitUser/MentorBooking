import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerConfig, WORKER_DEFAULTS } from '../dist/worker/worker-config.js';
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from '../dist/worker/outbox-dispatcher.service.js';
import { reminderKey, REMINDER_LEAD } from '../dist/worker/reminder.service.js';

test('worker configuration: defaults, valid overrides and fail-fast on invalid values', () => {
  assert.deepEqual(workerConfig({}), WORKER_DEFAULTS);
  assert.deepEqual(WORKER_DEFAULTS, { pollIntervalMs: 5000, batchSize: 100 });
  assert.deepEqual(workerConfig({ WORKER_POLL_INTERVAL_MS: '250', WORKER_BATCH_SIZE: '1000' }), { pollIntervalMs: 250, batchSize: 1000 });
  assert.deepEqual(workerConfig({ WORKER_POLL_INTERVAL_MS: '' }), WORKER_DEFAULTS);
  for (const env of [{ WORKER_POLL_INTERVAL_MS: '0' }, { WORKER_POLL_INTERVAL_MS: '249' }, { WORKER_POLL_INTERVAL_MS: '5s' },
    { WORKER_POLL_INTERVAL_MS: '-5' }, { WORKER_POLL_INTERVAL_MS: '1.5' }, { WORKER_BATCH_SIZE: '0' }, { WORKER_BATCH_SIZE: '1001' },
    { WORKER_BATCH_SIZE: 'all' }]) {
    assert.throws(() => workerConfig(env), /must be an integer/, JSON.stringify(env));
  }
});

test('delivery retries back off exponentially to a 5-minute cap within a bounded number of attempts', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8, 20].map(retryDelayMs), [5000, 10000, 20000, 40000, 300000, 300000, 300000]);
  assert.equal(MAX_DELIVERY_ATTEMPTS, 8);
});

test('reminder identity is deterministic and the lead is an elapsed hour', () => {
  assert.equal(reminderKey('abc'), 'reminder:abc:T-1h');
  assert.equal(REMINDER_LEAD, '1 hour');
});
