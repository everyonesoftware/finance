import test from 'node:test';
import assert from 'node:assert/strict';
import { getBankEncryptionKey, encryptBankValue, decryptBankValue, UnsupportedBankDataFormatError } from '../server/bank-crypto.ts';

const secret = 'isolated-bank-crypto-secret-at-least-32-characters';
const stored = 'v1.ABEiM0RVZneImaq7.pXn/FM0sU0Rp5krby+cfPQ==.N6cYq+qc5awR/A5jWmDzc9fnXsT7pA96';

test('stable secret-derived key decrypts an existing v1 snapshot without provider settings', () => {
  const original = process.env.BETTER_AUTH_SECRET;
  try {
    process.env.BETTER_AUTH_SECRET = secret;
    const key = getBankEncryptionKey();
    assert.equal(key.toString('hex'),'585759469881fcc6ad5b6b7eb45950ae82c7ac6981eaa1a0f50cb0277e97cb08');
    assert.deepEqual(getBankEncryptionKey(),key);
    assert.equal(decryptBankValue(stored),'saved encrypted snapshot');
    process.env.BETTER_AUTH_SECRET += '-changed';
    assert.notDeepEqual(getBankEncryptionKey(),key);
    assert.throws(()=>decryptBankValue(stored),error=>!(error instanceof UnsupportedBankDataFormatError));
    delete process.env.BETTER_AUTH_SECRET;
    assert.throws(getBankEncryptionKey,/BETTER_AUTH_SECRET/);
    process.env.BETTER_AUTH_SECRET = 'short';
    assert.throws(getBankEncryptionKey,/BETTER_AUTH_SECRET/);
  } finally {
    if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = original;
  }
});

test('authenticated encryption round-trips private Unicode and empty values with random IVs', () => {
  const key = Buffer.alloc(32,7);
  for (const value of ['', 'private fixture 🔐 €', JSON.stringify({balance:123.45})]) {
    const encrypted = encryptBankValue(value,key);
    assert.match(encrypted,/^v1\./);
    assert.equal(decryptBankValue(encrypted,key),value);
    assert.notEqual(encryptBankValue(value,key),encrypted);
    assert.throws(()=>decryptBankValue(encrypted,Buffer.alloc(32,8)),error=>!(error instanceof UnsupportedBankDataFormatError));
  }
});

test('tampering with IV, authentication tag or ciphertext rejects without structural recovery', () => {
  const key = Buffer.alloc(32,7);
  const encrypted = encryptBankValue('private fixture',key);
  for (const index of [1,2,3]) {
    const parts = encrypted.split('.');
    const bytes = Buffer.from(parts[index],'base64');
    bytes[0] ^= 1;
    parts[index] = bytes.toString('base64');
    assert.throws(()=>decryptBankValue(parts.join('.'),key),error=>!(error instanceof UnsupportedBankDataFormatError));
  }
});

test('unsupported or malformed envelopes are rejected distinctly from authentication failure', () => {
  for (const value of ['opaque old data','v2.a.b.c','v1.@@@@.bad.bad','v1...','v1.AA==.AA==.AA==',stored+'.extra',stored.replace('ABEi','AB E i')]) {
    assert.throws(()=>decryptBankValue(value,Buffer.alloc(32,7)),UnsupportedBankDataFormatError);
  }
});
