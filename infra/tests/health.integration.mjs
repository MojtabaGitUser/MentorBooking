import test from 'node:test';
import assert from 'node:assert/strict';

test('running Nest API can query PostgreSQL', async () => {
  const response = await fetch('http://127.0.0.1:3001/health');
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.status, 'ok');
  assert.equal(report.database, 'up');
  assert.match(report.version, /^\d+\.\d+\.\d+/);
});
