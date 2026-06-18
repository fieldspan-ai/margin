// KV backend tests — exercise the full store domain over an in-memory Redis mock
// (the same ops @upstash/redis provides), so the serverless path is verified
// without real infrastructure.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/store.js';
import { createMemoryRedis } from '../server/store/memory-redis.js';

const agent = { identity: 'agent', name: 'Claude' };
const human = { identity: 'human', name: 'Orr' };

before(async () => { await store.init(null, { kv: true, client: createMemoryRedis() }); });

test('kv: publish + getDocView round-trips through Redis', async () => {
  const r = await store.publish('kdoc', { html: '<h1>Hi</h1><p>Body</p>', title: 'K', author: agent });
  assert.equal(r.version, 1);
  const view = await store.getDocView('kdoc');
  assert.equal(view.version, 1);
  assert.match(view.html, /Hi/);
  assert.match(view.html, /data-block-id/);
});

test('kv: comments persist, fingerprint, and filter by status', async () => {
  await store.publish('kdoc2', { html: '<p>Margin is 76 percent</p>', author: agent });
  const bid = (await store.getDoc('kdoc2')).currentBlocks[0].id;
  const c = await store.addComment('kdoc2', { anchor: { block_id: bid, block_text: 'Margin is 76 percent', quote: '76' }, body: 'note', author: human });
  assert.ok((await store.getDoc('kdoc2')).comments.find((x) => x.id === c.id).anchor.block_fingerprint);
  await store.setStatus('kdoc2', c.id, 'resolved');
  assert.equal((await store.getComments('kdoc2', { status: 'open' })).threads.length, 0);
  assert.equal((await store.getComments('kdoc2', { status: 'resolved' })).threads.length, 1);
});

test('kv: listDocs returns newest-first from the index sorted-set', async () => {
  await store.publish('kA', { html: '<p>a</p>', title: 'A', author: agent });
  await store.publish('kB', { html: '<p>b</p>', title: 'B', author: agent });
  const docs = await store.listDocs();
  const ids = docs.map((d) => d.id);
  assert.ok(ids.includes('kA') && ids.includes('kB'));
  for (let i = 1; i < docs.length; i++) assert.ok(docs[i - 1].updatedAt >= docs[i].updatedAt, 'newest-first');
});

test('kv: re-anchoring works across a republish (block ids carried)', async () => {
  const r1 = await store.publish('kdoc3', { html: '<h2>Report</h2><p>Revenue up 18 percent this year</p>', author: agent });
  const bid = (await store.getDoc('kdoc3')).currentBlocks[1].id;
  await store.addComment('kdoc3', { anchor: { block_id: bid, block_text: 'Revenue up 18 percent this year', quote: '18' }, body: 'cite?', author: human });
  await store.publish('kdoc3', { html: '<h2>Report</h2><h2>Report</h2><p>Revenue up 18 percent this year</p>', author: agent });
  const view = await store.getDocView('kdoc3');
  const com = view.comments[0];
  assert.equal(com.resolved.block_id, bid, 'duplicate-heading insert keeps the comment on the revenue paragraph');
  assert.equal(com.resolved.soft, false);
});
