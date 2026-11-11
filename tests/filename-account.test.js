import test from 'node:test';
import assert from 'node:assert/strict';
import { filenameAccountMasks } from '../server-dist/filename-account.js';

test('filename matching uses complete account-number tokens and excludes date and path evidence', () => {
  for (const name of ['1234.csv', 'checking_991234.qfx', 'History_for_Account_X11111234.csv', 'Account_1234 (1).csv']) assert.deepEqual(filenameAccountMasks(name), ['1234'], name);
  assert.deepEqual(filenameAccountMasks('Account_2026.csv'), ['2026']);
  assert.deepEqual(filenameAccountMasks('accounts_1234_5678.csv'), ['1234','5678']);
  for (const name of ['activity_2026.csv','activity_20261110.csv','activity_11102026.csv','activity_2026-11-10.csv','activity_11-10-2026.csv','activity_2026_11_10.csv','History20261110.csv','1234/activity.csv','C:\\1234\\activity.csv','account_12345_extra.csv']) {
    const result=filenameAccountMasks(name);
    if(name==='account_12345_extra.csv') assert.deepEqual(result,['2345'],'Never find 1234 inside a longer account number');
    else assert.deepEqual(result,[],name);
  }
});
