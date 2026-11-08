import test from 'node:test';
import assert from 'node:assert/strict';
import { firstSpendableLot } from '../dist/wallet/rollover.service.js';
import { pageOptions, summarizeLots } from '../dist/wallet/wallet.service.js';

test('page validation bounds limits and rejects ambiguous query arguments', () => {
  assert.equal(pageOptions().limit, 20);
  assert.equal(pageOptions(undefined, '100').limit, 100);
  for (const limit of ['0','101','1.5',['1','2'],'']) {
    assert.throws(() => pageOptions(undefined, limit), error => error.getStatus() === 400);
  }
  assert.throws(() => pageOptions('broken'), error => error.getResponse().code === 'INVALID_PAGE');
});

test('debt offsets positive credits and cannot produce negative spendable credit', () => {
  const normal = { lotId: 'a', remaining: '2', expiresAt: null, expired: false };
  const liability = { ...normal, lotId: 'b', remaining: '-3' };
  assert.deepEqual(summarizeLots([normal, liability]),
    { normal: 2, debt: -3, rollover: 0, totalSpendable: 0, rolloverLots: [] });
});

test('selection skips expired and consumed lots and applies outstanding debt', () => {
  const base = {lotId:'normal', remaining:'1', expiresAt:null, expired:false};
  const rollover = {...base, lotId:'rollover', expiresAt:new Date('2090-01-01Z')};
  const lots = [{...rollover,expired:true},{...rollover,remaining:'0'},rollover,base];
  assert.equal(firstSpendableLot(lots).lotId,'rollover');
  assert.equal(firstSpendableLot([...lots,{...base,remaining:'-2'}]),null);
  assert.equal(firstSpendableLot([]),null);
});
