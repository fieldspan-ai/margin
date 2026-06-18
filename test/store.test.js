// P0 tests for the storage domain layer (server/store.js) over the JSON backend.
// Run: npm test   (node --test)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../server/store.js';

let dir;
before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-store-')); await store.init(dir); });
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const agent = { identity: 'agent', name: 'Claude', session_id: 't' };
const human = { identity: 'human', name: 'Orr' };

test('publish create then update bumps the version and carries comments', async () => {
  const r1 = await store.publish('doc1', { title: 'T', html: '<p>Hello world</p>', author: agent });
  assert.equal(r1.version, 1);
  const bid = (await store.getDoc('doc1')).currentBlocks[0].id;
  await store.addComment('doc1', { anchor: { block_id: bid, block_text: 'Hello world', quote: 'Hello' }, body: 'note', author: human });
  const r2 = await store.publish('doc1', { html: '<p>Hello world revised</p>', author: agent });
  assert.equal(r2.version, 2);
  const view = await store.getDocView('doc1');
  assert.equal(view.version, 2);
  assert.equal(view.comments.length, 1, 'comment survives a republish');
  assert.ok(view.comments[0].resolved, 'comment carries a server-resolved anchor');
});

test('addComment persists the anchor and a server fingerprint', async () => {
  await store.publish('doc2', { html: '<p>Alpha block</p>', author: agent });
  const bid = (await store.getDoc('doc2')).currentBlocks[0].id;
  const c = await store.addComment('doc2', { anchor: { block_id: bid, block_text: 'Alpha block', quote: 'Alpha' }, body: 'b', author: human });
  const raw = (await store.getDoc('doc2')).comments.find((x) => x.id === c.id);
  assert.equal(raw.anchor.block_id, bid);
  assert.ok(raw.anchor.block_fingerprint, 'server snapshots an authoritative fingerprint');
});

test('getComments status filter (open / resolved / all)', async () => {
  await store.publish('doc3', { html: '<p>x</p>', author: agent });
  await store.addComment('doc3', { anchor: {}, body: 'open one', author: human });
  const c2 = await store.addComment('doc3', { anchor: {}, body: 'to resolve', author: human });
  await store.setStatus('doc3', c2.id, 'resolved');
  assert.equal((await store.getComments('doc3', { status: 'open' })).threads.length, 1);
  assert.equal((await store.getComments('doc3', { status: 'resolved' })).threads.length, 1);
  assert.equal((await store.getComments('doc3', {})).threads.length, 2);
});

test('listDocs sorts newest-first, counts open comments, survives a malformed file', async () => {
  await store.publish('doc4', { title: 'Four', html: '<p>y</p>', author: agent });
  await store.addComment('doc4', { anchor: {}, body: 'open', author: human });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const docs = await store.listDocs();
  assert.ok(!docs.some((d) => d === null), 'malformed file is skipped, not crashed on');
  const d4 = docs.find((d) => d.id === 'doc4');
  assert.equal(d4.openComments, 1);
  for (let i = 1; i < docs.length; i++) assert.ok(docs[i - 1].updatedAt >= docs[i].updatedAt, 'newest-first');
});

test('getDocView tolerates a legacy doc missing versions/comments (inline html)', async () => {
  fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify({ id: 'legacy', title: 'Legacy', currentVersion: 1, versions: [{ v: 1, html: '<p>old inline</p>' }] }));
  const v = await store.getDocView('legacy');
  assert.equal(v.version, 1);
  assert.match(v.html, /old inline/);
  assert.deepEqual(v.comments, []);
});

test('atomic writes leave no temp files and produce valid json', async () => {
  await store.publish('doc5', { html: '<p>z</p>', author: agent });
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'doc5.json'), 'utf8'));
  assert.equal(raw.id, 'doc5');
});

test('html is stored out-of-row, not inline in the doc json', async () => {
  await store.publish('doc6', { html: '<p>big content here</p>', author: agent });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'doc6.json'), 'utf8'));
  assert.ok(raw.versions.every((v) => typeof v.html !== 'string'), 'no inline html in the json');
  assert.ok(fs.existsSync(path.join(dir, 'doc6', 'v1.html')), 'html lives in its own file');
});
