// Unit tests for the signed scoped-token layer (server/tokens.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, mintToken } from '../server/tokens.js';

const secret = 'test-secret';

test('sign/verify round-trips a payload', () => {
  const p = verify(sign({ d: 'doc1', r: 'reviewer', iat: 1 }, secret), secret);
  assert.equal(p.d, 'doc1');
  assert.equal(p.r, 'reviewer');
});

test('a tampered signature fails', () => {
  const t = sign({ d: 'doc1', r: 'reviewer' }, secret);
  assert.equal(verify(t.split('.')[0] + '.deadbeef', secret), null);
});

test('a forged body with a stolen signature fails', () => {
  const t = sign({ d: 'doc1', r: 'reviewer' }, secret);
  const forgedBody = Buffer.from(JSON.stringify({ d: 'docX', r: 'reviewer' })).toString('base64url');
  assert.equal(verify(forgedBody + '.' + t.split('.')[1], secret), null);
});

test('the wrong secret fails', () => {
  assert.equal(verify(sign({ d: 'doc1' }, secret), 'other-secret'), null);
});

test('expiry is enforced', () => {
  const t = mintToken('doc1', 'reviewer', secret, 1000, 1000); // iat 1000, exp 2000
  assert.ok(verify(t, secret, 1500), 'valid before exp');
  assert.equal(verify(t, secret, 3000), null, 'rejected after exp');
});

test('no ttl means no expiry', () => {
  const p = verify(mintToken('doc1', 'reviewer', secret, 0), secret);
  assert.equal(p.exp, undefined);
  assert.equal(p.d, 'doc1');
});

test('agent role is preserved; unknown roles fall back to reviewer', () => {
  assert.equal(verify(mintToken('d', 'agent', secret, 0), secret).r, 'agent');
  assert.equal(verify(mintToken('d', 'whatever', secret, 0), secret).r, 'reviewer');
});

test('garbage input returns null instead of throwing', () => {
  for (const bad of ['', 'nodot', null, undefined, 'a.b.c']) assert.equal(verify(bad, secret), null);
});
