import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creditDelta, movementLabels, sessionLabels, walletTime } from './wallet.ts';

test('ledger shows signed credit units and distinct spend, debt, refunds and expiry labels', () => {
  assert.deepEqual(
    [creditDelta(4), creditDelta(-1), creditDelta(1)],
    ['+4 credits', '-1 credit', '+1 credit'],
  );
  assert.equal(Object.keys(movementLabels).length, 10);
  assert.equal(new Set(Object.values(movementLabels)).size, 10);
  assert.equal(movementLabels.DEBT, 'Payment debt');
  assert.equal(movementLabels.NO_SHOW_ROLLOVER, 'Mentor no-show award');
  assert.equal(sessionLabels.no_show_mentee, 'Mentee no-show');
  assert.equal(sessionLabels.completed, 'Completed');
});
test('expiry uses the viewer date, seconds and actual offset at a repeated clock time', () => {
  const at = (iso: string) => walletTime(iso, 'Europe/London');
  assert.match(at('2026-10-25T00:30:05Z'), /1:30:05.*GMT\+1/);
  assert.match(at('2026-10-25T01:30:05Z'), /1:30:05.*GMT(?:\+0)?$/);
  assert.match(walletTime('2026-01-15T03:30:00Z', 'America/Los_Angeles'), /Jan 14, 2026.*7:30:00/);
});
