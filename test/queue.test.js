// Review queue — the reviewer's triage list. Store-level tests drive
// server/store.js directly over the JSON backend (like store.test.js); the API
// tests spin up two real servers (like api.test.js / owner-auth.test.js): one
// with keys for the token flows, one with MARGIN_OWNER_PASSWORD for the /queue
// page's Basic-auth gate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../server/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = { identity: 'agent', name: 'Claude', session_id: 't' };
const human = { identity: 'human', name: 'Orr' };

// Server A: token auth (owner master + agent key). Server B: owner password
// only. Server C: STORE=memory (the KV code path, which has the atomic
// counter /api/queue's rate limit needs) with a tiny MARGIN_QUEUE_MAX.
const PORT_A = 8600 + (process.pid % 90);
const PORT_B = 8500 + (process.pid % 90);
const PORT_C = 8300 + (process.pid % 90);
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
const BASE_C = `http://localhost:${PORT_C}`;
const AK = 'test-agent-key', RT = 'test-reviewer-token', PW = 'sekret-owner-pass';
const A = (extra) => ({ authorization: 'Bearer ' + AK, 'content-type': 'application/json', 'x-agent-session': 't', ...extra });
const R = (extra) => ({ authorization: 'Bearer ' + RT, 'content-type': 'application/json', ...extra });
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');

let storeDir, dirA, dirB, childA, childB, childC;

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start: ' + base);
}

before(async () => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-queue-store-'));
  await store.init(storeDir);
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-queue-api-'));
  childA = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT_A), DATA_DIR: dirA, AGENT_API_KEY: AK, REVIEWER_TOKEN: RT, PUBLIC_BASE_URL: BASE_A },
    stdio: 'ignore',
  });
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-queue-owner-'));
  childB = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    // No AGENT_API_KEY / REVIEWER_TOKEN — the password is the only owner credential.
    env: { PATH: process.env.PATH, PORT: String(PORT_B), DATA_DIR: dirB, PUBLIC_BASE_URL: BASE_B, MARGIN_OWNER_PASSWORD: PW },
    stdio: 'ignore',
  });
  childC = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    // No DATA_DIR needed — STORE=memory keeps everything in an in-process Redis mock.
    env: { PATH: process.env.PATH, PORT: String(PORT_C), PUBLIC_BASE_URL: BASE_C, STORE: 'memory', MARGIN_QUEUE_MAX: '3', MARGIN_QUEUE_WINDOW: '300' },
    stdio: 'ignore',
  });
  await Promise.all([waitUp(BASE_A), waitUp(BASE_B), waitUp(BASE_C)]);
});
after(() => {
  for (const c of [childA, childB, childC]) { try { c.kill(); } catch { /* */ } }
  for (const d of [storeDir, dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

const item = (q, id) => q.items.find((i) => i.doc_id === id);

// ---- store-level: state derivation ----

test('fresh publish → awaiting_review, 1 unseen version, first in the queue', async () => {
  await store.publish('q1', { title: 'One', html: '<p>alpha</p>', author: agent });
  const q = await store.reviewQueue();
  assert.equal(q.items[0].doc_id, 'q1');
  assert.equal(q.items[0].state, 'awaiting_review');
  assert.equal(q.items[0].unseen_versions, 1);
});

test('a human comment implicitly marks reviewed → waiting_on_agent', async () => {
  await store.addComment('q1', { anchor: {}, body: 'thoughts', author: human });
  const doc = await store.getDoc('q1');
  assert.equal(doc.review?.version, 1, 'human write set the review marker');
  const it = item(await store.reviewQueue(), 'q1');
  assert.equal(it.state, 'waiting_on_agent');
  assert.equal(it.open_comments, 1);
});

test('an agent re-publish outranks thread state → awaiting_review again', async () => {
  await store.publish('q1', { html: '<p>alpha revised</p>', author: agent });
  const it = item(await store.reviewQueue(), 'q1');
  assert.equal(it.state, 'awaiting_review');
  assert.equal(it.unseen_versions, 1, 'reviewed v1, now at v2');
});

test('agent reply on an open thread → needs_reply; human reply → waiting_on_agent', async () => {
  await store.publish('q2', { title: 'Two', html: '<p>beta</p>', author: agent });
  const c = await store.addComment('q2', { anchor: {}, body: 'please fix', author: human });
  assert.equal(item(await store.reviewQueue(), 'q2').state, 'waiting_on_agent');
  await store.addReply('q2', c.id, { body: 'done, take a look', author: agent });
  assert.equal(item(await store.reviewQueue(), 'q2').state, 'needs_reply');
  await store.addReply('q2', c.id, { body: 'still off', author: human });
  assert.equal(item(await store.reviewQueue(), 'q2').state, 'waiting_on_agent');
});

test('human resolves the only open thread at the current version → clear', async () => {
  const doc = await store.getDoc('q2');
  await store.setStatus('q2', doc.comments[0].id, 'resolved', human);
  const it = item(await store.reviewQueue(), 'q2');
  assert.equal(it.state, 'clear');
  assert.equal(it.open_comments, 0);
});

test('markReviewed clears an awaiting_review doc', async () => {
  await store.publish('q3', { title: 'Three', html: '<p>gamma</p>', author: agent });
  assert.equal(item(await store.reviewQueue(), 'q3').state, 'awaiting_review');
  const r = await store.markReviewed('q3');
  assert.deepEqual(r, { doc_id: 'q3', reviewed_version: 1 });
  assert.equal(item(await store.reviewQueue(), 'q3').state, 'clear');
  assert.equal(await store.markReviewed('nope'), null);
});

test('noteAgentWait never touches the doc record; agent_waiting still surfaces via reviewQueue', async () => {
  const before = await store.getDoc('q3');
  await store.noteAgentWait('q3');
  const after = await store.getDoc('q3');
  assert.deepEqual(after, before, 'the stamp lives in a separate meta map, not the doc record');
  assert.equal(item(await store.reviewQueue(), 'q3').agent_waiting, true);
});

test('sorting: reviewer-ball items come before agent-ball and clear items', async () => {
  // q1 is awaiting_review; q4 is waiting_on_agent; q2/q3 are clear.
  await store.publish('q4', { title: 'Four', html: '<p>delta</p>', author: agent });
  await store.addComment('q4', { anchor: {}, body: 'note', author: human });
  const q = await store.reviewQueue();
  const rank = { awaiting_review: 0, needs_reply: 0, waiting_on_agent: 1, clear: 2 };
  for (let i = 1; i < q.items.length; i++) {
    assert.ok(rank[q.items[i - 1].state] <= rank[q.items[i].state], 'grouped in triage order');
  }
  assert.ok(q.items.findIndex((i) => i.doc_id === 'q1') < q.items.findIndex((i) => i.doc_id === 'q4'));
  assert.ok(q.items.findIndex((i) => i.doc_id === 'q4') < q.items.findIndex((i) => i.doc_id === 'q2'));
});

// ---- API-level: auth + endpoints ----

let scopedToken;

test('GET /api/queue with no auth → 200, empty personal queue (the page is public)', async () => {
  const r = await fetch(BASE_A + '/api/queue');
  assert.equal(r.status, 200);
  const q = await r.json();
  assert.ok(typeof q.generated_at === 'number');
  assert.equal(q.scope, 'mine');
  assert.deepEqual(q.items, []);
});

test('GET /api/queue as a doc-scoped reviewer: no rid → empty; a rid that opened the doc → exactly that doc', async () => {
  await fetch(BASE_A + '/api/docs/qd1/publish', { method: 'POST', headers: A(), body: JSON.stringify({ html: '<p>hello</p>', title: 'QD1' }) });
  const j = await (await fetch(BASE_A + '/api/docs/qd1/link', { method: 'POST', headers: A(), body: '{}' })).json();
  scopedToken = decodeURIComponent(j.url.split('token=')[1]);
  // Bare token, no rid cookie: the personal queue has nothing to show.
  const bare = await (await fetch(BASE_A + '/api/queue', { headers: { authorization: 'Bearer ' + scopedToken } })).json();
  assert.equal(bare.scope, 'mine');
  assert.deepEqual(bare.items, []);
  // Opening the magic link mints the rid cookie and binds the doc to it.
  const redir = await fetch(BASE_A + '/d/qd1?token=' + encodeURIComponent(scopedToken), { redirect: 'manual' });
  assert.equal(redir.status, 302);
  const rid = redir.headers.getSetCookie().find((c) => c.startsWith('margin_rid='));
  assert.ok(rid, 'magic link set a margin_rid cookie');
  const q = await (await fetch(BASE_A + '/api/queue', { headers: { cookie: rid.split(';')[0] } })).json();
  assert.equal(q.scope, 'mine');
  assert.deepEqual(q.items.map((i) => i.doc_id), ['qd1']);
});

test('GET /api/queue with the owner master token → 200 with every doc (scope all)', async () => {
  const r = await fetch(BASE_A + '/api/queue', { headers: R() });
  assert.equal(r.status, 200);
  const q = await r.json();
  assert.ok(typeof q.generated_at === 'number');
  assert.equal(q.scope, 'all');
  const it = item(q, 'qd1');
  assert.equal(it.state, 'awaiting_review');
  assert.equal(it.version, 1);
});

test('POST /api/docs/:id/reviewed as a doc-scoped reviewer → 200 and the queue clears', async () => {
  const r = await fetch(BASE_A + '/api/docs/qd1/reviewed', { method: 'POST', headers: { authorization: 'Bearer ' + scopedToken } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { doc_id: 'qd1', reviewed_version: 1 });
  const q = await (await fetch(BASE_A + '/api/queue', { headers: R() })).json();
  assert.equal(item(q, 'qd1').state, 'clear');
});

test('POST /api/docs/:id/reviewed with an agent token → 403 (agents never clear the queue)', async () => {
  const r = await fetch(BASE_A + '/api/docs/qd1/reviewed', { method: 'POST', headers: A() });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'only a reviewer can mark a document reviewed');
});

test('/wait as a reviewer does NOT set agent_waiting; as an agent it does', async () => {
  await fetch(BASE_A + '/api/docs/qwait/publish', { method: 'POST', headers: A(), body: JSON.stringify({ html: '<p>x</p>', title: 'Wait' }) });
  const link = await (await fetch(BASE_A + '/api/docs/qwait/link', { method: 'POST', headers: A(), body: '{}' })).json();
  const reviewerTok = decodeURIComponent(link.url.split('token=')[1]);

  // Fire /wait and give the handler a moment to run its pre-loop stamp check —
  // no need to wait out the full long-poll window either way.
  const fireWait = (headers) => fetch(BASE_A + '/api/docs/qwait/wait', { headers }).catch(() => {});
  fireWait({ authorization: 'Bearer ' + reviewerTok });
  await new Promise((r) => setTimeout(r, 200));
  let q = await (await fetch(BASE_A + '/api/queue', { headers: R() })).json();
  assert.equal(item(q, 'qwait').agent_waiting, false, 'a reviewer hitting /wait must not fake agent presence');

  fireWait(A());
  await new Promise((r) => setTimeout(r, 200));
  q = await (await fetch(BASE_A + '/api/queue', { headers: R() })).json();
  assert.equal(item(q, 'qwait').agent_waiting, true, 'an agent hitting /wait sets the pulse');
});

test('the /queue page is public; /queue?all=1 is the owner Basic escape hatch', async () => {
  const open = await fetch(BASE_A + '/queue');
  assert.equal(open.status, 200);
  assert.match(open.headers.get('content-type') || '', /text\/html/);
  assert.match(await open.text(), /Review queue/);
  // Plain /queue never challenges, even with MARGIN_OWNER_PASSWORD set.
  const plain = await fetch(BASE_B + '/queue');
  assert.equal(plain.status, 200);
  assert.match(await plain.text(), /Review queue/);
  // ?all=1 (the owner's forced global view) raises the same challenge as /analytics.
  const denied = await fetch(BASE_B + '/queue?all=1');
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate') || '', /^Basic realm=/i);
  const ok = await fetch(BASE_B + '/queue?all=1', { headers: { authorization: basic('owner', PW) } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Review queue/);
});

test('GET /api/queue is rate-limited per IP (MARGIN_QUEUE_MAX)', async () => {
  // Server C: STORE=memory (has the atomic counter rateLimit needs) + MARGIN_QUEUE_MAX=3.
  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(BASE_C + '/api/queue')).status, 200, `request ${i + 1} of 3 is allowed`);
  }
  const fourth = await fetch(BASE_C + '/api/queue');
  assert.equal(fourth.status, 429);
  assert.equal((await fourth.json()).error, 'rate limited');
});
