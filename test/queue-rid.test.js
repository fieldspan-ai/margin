// Per-person review queue — the anonymous browser identity (margin_rid).
// Cookie-jar "browsers" simulate two reviewers opening magic links against one
// agent-first server (open create, REVIEWER_TOKEN as the owner master for the
// global view). Store-level tests drive server/store.js directly (bindReviewer,
// like queue.test.js); token shape checks drive server/tokens.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../server/store.js';
import { mintToken, mintSession, verify, verifySession } from '../server/tokens.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8400 + (process.pid % 90);
const BASE = `http://localhost:${PORT}`;
const RT = 'qr-owner-master';
const J = { 'content-type': 'application/json' };
const agent = { identity: 'agent', name: 'Claude', session_id: 't' };
let child, dir, storeDir;

const tokenOf = (url) => decodeURIComponent(String(url).split('token=')[1] || '');
const item = (q, id) => q.items.find((i) => i.doc_id === id);

// A minimal cookie-jar "browser": opens magic links (302, redirect not
// followed), then carries the absorbed margin_* cookies on every later request
// — exactly what a phone browser does.
function browser() {
  const cookies = {};
  const hdr = () => (Object.keys(cookies).length
    ? { cookie: Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ') }
    : {});
  const absorb = (r) => {
    for (const sc of r.headers.getSetCookie()) {
      const kv = sc.split(';')[0];
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
  };
  return {
    cookies,
    async open(url) { const r = await fetch(url, { redirect: 'manual', headers: hdr() }); absorb(r); return r; },
    async queue() { return (await fetch(BASE + '/api/queue', { headers: hdr() })).json(); },
    async post(p, body) { return fetch(BASE + p, { method: 'POST', headers: { ...hdr(), ...J }, body: JSON.stringify(body || {}) }); },
  };
}

async function createDoc(title) {
  return (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ title, html: '<p>' + title + '</p>' }) })).json();
}

before(async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-qrid-store-'));
  await store.init(storeDir);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-qrid-api-'));
  child = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    // Agent-first (no AGENT_API_KEY) + the owner master for the global view.
    env: { PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dir, PUBLIC_BASE_URL: BASE, REVIEWER_TOKEN: RT },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  try { child.kill(); } catch { /* */ }
  for (const d of [storeDir, dir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

// Two reviewers ("browsers") and the docs they open, shared across the tests.
const A = browser(), B = browser();
let doc1, doc2, doc3, doc4;

test('opening a magic link sets margin_rid and binds the doc into that queue', async () => {
  doc1 = await createDoc('One');
  const r = await A.open(doc1.reviewer_url);
  assert.equal(r.status, 302);
  assert.ok(A.cookies.margin_rid, 'the 302 set a margin_rid cookie');
  assert.ok(A.cookies.margin_token, 'alongside the margin_token cookie');
  const q = await A.queue();
  assert.equal(q.scope, 'mine');
  assert.deepEqual(q.items.map((i) => i.doc_id), [doc1.doc_id]);
  assert.equal(q.items[0].state, 'awaiting_review');
});

test('two rids, two docs: each queue contains only its own doc', async () => {
  doc2 = await createDoc('Two');
  await B.open(doc2.reviewer_url);
  assert.notEqual(A.cookies.margin_rid, B.cookies.margin_rid, 'distinct identities');
  assert.deepEqual((await A.queue()).items.map((i) => i.doc_id), [doc1.doc_id]);
  assert.deepEqual((await B.queue()).items.map((i) => i.doc_id), [doc2.doc_id]);
});

test('per-person markers: A marks reviewed, B still sees awaiting_review', async () => {
  doc3 = await createDoc('Three');
  await A.open(doc3.reviewer_url);
  await B.open(doc3.reviewer_url);
  const r = await A.post('/api/docs/' + doc3.doc_id + '/reviewed');
  assert.equal(r.status, 200);
  assert.equal(item(await A.queue(), doc3.doc_id).state, 'clear');
  assert.equal(item(await B.queue(), doc3.doc_id).state, 'awaiting_review');
});

test("thread attribution: A's thread needs A's reply, not B's", async () => {
  // Catch B's marker up first so awaiting_review doesn't mask thread state.
  await B.post('/api/docs/' + doc3.doc_id + '/reviewed');
  const c = await (await A.post('/api/docs/' + doc3.doc_id + '/comments', { anchor: {}, body: 'tighten this' })).json();
  assert.ok(c.author.rid, 'the rid rides in the stored author');
  await fetch(`${BASE}/api/docs/${doc3.doc_id}/comments/${c.id}/replies`, {
    method: 'POST', headers: { ...J, authorization: 'Bearer ' + doc3.agent_token },
    body: JSON.stringify({ body: 'done, take a look' }),
  });
  assert.equal(item(await A.queue(), doc3.doc_id).state, 'needs_reply');
  assert.equal(item(await B.queue(), doc3.doc_id).state, 'clear', "someone else's thread is not B's turn");
});

test('legacy thread (no rid on any human message) involves every bound reviewer', async () => {
  doc4 = await createDoc('Four');
  await A.open(doc4.reviewer_url);
  await B.open(doc4.reviewer_url);
  await A.post('/api/docs/' + doc4.doc_id + '/reviewed');
  await B.post('/api/docs/' + doc4.doc_id + '/reviewed');
  // A pre-feature comment: a bare reviewer token with no cookies → no rid.
  const c = await (await fetch(`${BASE}/api/docs/${doc4.doc_id}/comments`, {
    method: 'POST', headers: { ...J, authorization: 'Bearer ' + tokenOf(doc4.reviewer_url) },
    body: JSON.stringify({ anchor: {}, body: 'old-style comment' }),
  })).json();
  assert.ok(!c.author.rid, 'no rid on the legacy author');
  await fetch(`${BASE}/api/docs/${doc4.doc_id}/comments/${c.id}/replies`, {
    method: 'POST', headers: { ...J, authorization: 'Bearer ' + doc4.agent_token },
    body: JSON.stringify({ body: 'replied' }),
  });
  assert.equal(item(await A.queue(), doc4.doc_id).state, 'needs_reply');
  assert.equal(item(await B.queue(), doc4.doc_id).state, 'needs_reply');
});

test('root rule: an agent-initiated thread stays shared with every bound reviewer after one reviewer replies', async () => {
  await store.publish('qroot1', { title: 'Root1', html: '<p>x</p>', author: agent });
  await store.bindReviewer('qroot1', 'rid-ra');
  await store.bindReviewer('qroot1', 'rid-rb');
  const c = await store.addComment('qroot1', { anchor: {}, body: 'agent note', author: agent }); // root has no rid
  await store.addReply('qroot1', c.id, { body: 'looks good', author: { identity: 'human', name: 'A', rid: 'rid-ra' } });
  const qa = await store.reviewQueue({ rid: 'rid-ra' });
  const qb = await store.reviewQueue({ rid: 'rid-rb' });
  assert.equal(item(qa, 'qroot1').open_comments, 1, 'A (who replied) still sees the thread');
  assert.equal(item(qb, 'qroot1').open_comments, 1, 'B still sees it too — the root had no rid');
});

test('root rule: a rid-rooted thread never involves a different rid', async () => {
  await store.publish('qroot2', { title: 'Root2', html: '<p>x</p>', author: agent });
  await store.bindReviewer('qroot2', 'rid-rc');
  await store.bindReviewer('qroot2', 'rid-rd');
  const c = await store.addComment('qroot2', { anchor: {}, body: 'C says', author: { identity: 'human', name: 'C', rid: 'rid-rc' } });
  await store.addReply('qroot2', c.id, { body: 'reply', author: agent });
  const qc = await store.reviewQueue({ rid: 'rid-rc' });
  const qd = await store.reviewQueue({ rid: 'rid-rd' });
  assert.equal(item(qc, 'qroot2').open_comments, 1, 'C (the root author) sees their own thread');
  assert.equal(item(qd, 'qroot2').open_comments, 0, "D never sees C's rooted thread");
});

test('bindReviewer: no updatedAt churn, idempotent, capped drop-oldest', async () => {
  await store.publish('qr1', { title: 'QR1', html: '<p>x</p>', author: agent });
  const prev = (await store.getDoc('qr1')).updatedAt;
  await store.bindReviewer('qr1', 'rid-a');
  await store.bindReviewer('qr1', 'rid-a'); // idempotent — no duplicate, no write
  let doc = await store.getDoc('qr1');
  assert.equal(doc.updatedAt, prev, 'binding is not content activity');
  assert.deepEqual(doc.reviewerIds, ['rid-a']);
  for (let i = 0; i < 60; i++) await store.bindReviewer('qr1', 'rid-' + i);
  doc = await store.getDoc('qr1');
  assert.equal(doc.reviewerIds.length, 50, 'cap respected');
  assert.ok(!doc.reviewerIds.includes('rid-a'), 'oldest binding dropped');
  assert.ok(doc.reviewerIds.includes('rid-59'), 'newest binding kept');
  assert.equal(doc.updatedAt, prev, 'still no updatedAt churn');
});

test('reviews-map bound: an evicted rid takes its markReviewed marker with it (no orphans)', async () => {
  await store.publish('qr2', { title: 'QR2', html: '<p>x</p>', author: agent });
  for (let i = 0; i < 50; i++) await store.bindReviewer('qr2', 'rid2-' + i); // exactly at the cap
  await store.markReviewed('qr2', { rid: 'rid2-0' });
  await store.markReviewed('qr2', { rid: 'rid2-1' });
  await store.markReviewed('qr2', { rid: 'rid2-2' });
  let doc = await store.getDoc('qr2');
  assert.equal(Object.keys(doc.reviews).length, 3);
  assert.ok(Object.keys(doc.reviews).length <= doc.reviewerIds.length, 'reviews stays inside reviewerIds membership');
  // 5 more bindings past the cap evict the oldest 5 rids — including the three just marked.
  for (let i = 50; i < 55; i++) await store.bindReviewer('qr2', 'rid2-' + i);
  doc = await store.getDoc('qr2');
  assert.equal(doc.reviewerIds.length, 50, 'still capped');
  assert.ok(['rid2-0', 'rid2-1', 'rid2-2'].every((r) => !doc.reviewerIds.includes(r)), 'those rids were evicted');
  const orphans = Object.keys(doc.reviews || {}).filter((rid) => !doc.reviewerIds.includes(rid));
  assert.deepEqual(orphans, [], 'no orphaned reviews[] markers after eviction');
  assert.ok(Object.keys(doc.reviews || {}).length <= doc.reviewerIds.length);
});

test('session tokens and doc tokens never cross-verify', () => {
  const secret = 'test-secret';
  const sess = mintSession(secret);
  const docTok = mintToken('d1', 'reviewer', secret, 0);
  assert.ok(verifySession(sess, secret)?.rid, 'a session verifies as a session');
  assert.ok(verify(docTok, secret), 'a doc token verifies as a doc token');
  assert.equal(verify(sess, secret), null, 'a session token is not a doc capability');
  assert.equal(verifySession(docTok, secret), null, 'a doc token is not a browser identity');
});

test("the owner master still gets scope 'all' with every doc", async () => {
  const q = await (await fetch(BASE + '/api/queue', { headers: { authorization: 'Bearer ' + RT } })).json();
  assert.equal(q.scope, 'all');
  for (const d of [doc1, doc2, doc3, doc4]) assert.ok(item(q, d.doc_id), 'owner sees ' + d.doc_id);
});

test('rid re-grants access to earlier docs (single-slot cookie fix)', async () => {
  const docA = await createDoc('RidA');
  const docB = await createDoc('RidB');
  const C = browser();
  // Open doc A's magic link (margin_token = A, margin_rid = C)
  await C.open(docA.reviewer_url);
  // Open doc B's magic link (margin_token = B now, margin_rid still C)
  await C.open(docB.reviewer_url);
  // POST /api/docs/<A>/reviewed with C's cookies (margin_token is B, but rid is bound to A)
  const r = await C.post('/api/docs/' + docA.doc_id + '/reviewed');
  assert.equal(r.status, 200, 'rid-bound browser can mark earlier doc reviewed despite single-slot token');
  // Verify the doc shows as 'clear' in the queue
  const q = await C.queue();
  assert.equal(item(q, docA.doc_id).state, 'clear', 'doc A marked clear via rid fallback');
});

test("rid-bound browser can read an earlier doc's view", async () => {
  const docA = await createDoc('ViewA');
  const docB = await createDoc('ViewB');
  const D = browser();
  // Open doc A, then doc B (margin_token now B, rid still bound to A)
  await D.open(docA.reviewer_url);
  await D.open(docB.reviewer_url);
  // GET /api/docs/<A> should work via rid fallback
  const r = await fetch(BASE + '/api/docs/' + docA.doc_id, {
    headers: D.cookies ? { cookie: Object.entries(D.cookies).map(([k, v]) => k + '=' + v).join('; ') } : {},
  });
  assert.equal(r.status, 200, 'rid-bound browser can read earlier doc');
  const view = await r.json();
  assert.equal(view.id, docA.doc_id);
});

test('an unbound rid grants nothing', async () => {
  const docA = await createDoc('UnboundA');
  const docB = await createDoc('UnboundB');
  const E = browser();
  // Open only doc B (rid is bound only to B, not A)
  await E.open(docB.reviewer_url);
  // Try to POST /api/docs/<A>/reviewed → should fail
  const r = await E.post('/api/docs/' + docA.doc_id + '/reviewed');
  assert.equal(r.status, 403, 'unbound rid cannot access unrelated doc');
});

test('garbage / unsigned / doc-token-valued margin_rid cookie is treated as anonymous (200, empty, no crash)', async () => {
  const doc = await createDoc('Garbage');
  const cases = [
    'not-a-token',
    'not-a-token.not-a-signature',
    tokenOf(doc.reviewer_url), // a valid DOC-scoped capability, not a session token
  ];
  for (const val of cases) {
    const r = await fetch(BASE + '/api/queue', { headers: { cookie: 'margin_rid=' + encodeURIComponent(val) } });
    assert.equal(r.status, 200, 'no crash for cookie value: ' + val);
    const q = await r.json();
    assert.equal(q.scope, 'mine');
    assert.deepEqual(q.items, [], 'garbage/foreign cookie grants no access');
  }
});
