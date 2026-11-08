import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthController } from '../dist/health.controller.js';

test('a responding database reports healthy', async () => {
  const controller = new HealthController({ query: async sql => assert.equal(sql, 'SELECT 1') });
  const report = await controller.health();
  assert.equal(report.status, 'ok');
  assert.equal(report.database, 'up');
  assert.ok(report.version);
});

test('a database failure produces a bounded, non-sensitive 503 response', async () => {
  const controller = new HealthController({ query: async () => { throw Error('private detail'); } });
  await assert.rejects(controller.health(), error => {
    assert.equal(error.getStatus(), 503);
    assert.equal(error.getResponse().database, 'down');
    assert.ok(!JSON.stringify(error.getResponse()).includes('private detail'));
    return true;
  });
});
