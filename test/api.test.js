// P0 HTTP integration tests — spins up the real server on a temp data dir and
// exercises auth, publish, comments, the cookie flow, and the long-poll gate.
// Run: npm test   (node --test)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8900 + (process.pid % 90);
const BASE = `http://localhost:${PORT}`;
const AK = 'test-agent-key', RT = 'test-reviewer-token';
let child, dir;

const A = (extra) => ({ authorization: 'Bearer ' + AK, 'content-type': 'application/json', 'x-agent-session': 't', ...extra });
const R = (extra) => ({ authorization: 'Bearer ' + RT, 'content-type': 'application/json', ...extra });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-api-'));
  child = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, AGENT_API_KEY: AK, REVIEWER_TOKEN: RT, PUBLIC_BASE_URL: BASE },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { try { child.kill(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('health is public', async () => {
  assert.equal((await fetch(BASE + '/api/health')).status, 200);
});

test('no token → 401', async () => {
  assert.equal((await fetch(BASE + '/api/docs')).status, 401);
});

test('agent publish create → 200 with url + created', async () => {
  const r = await fetch(BASE + '/api/docs/rep/publish', { method: 'POST', headers: A(), body: JSON.stringify({ html: '<h1>Hi</h1><p>Body</p>', title: 'Rep' }) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.version, 1);
  assert.equal(j.created, true);
  assert.match(j.url, /\/d\/rep\?token=/);
});

test('reviewer cannot publish → 403', async () => {
  assert.equal((await fetch(BASE + '/api/docs/rep/publish', { method: 'POST', headers: R(), body: JSON.stringify({ html: '<p>x</p>' }) })).status, 403);
});

test('publish missing html → 400', async () => {
  assert.equal((await fetch(BASE + '/api/docs/rep/publish', { method: 'POST', headers: A(), body: '{}' })).status, 400);
});

test('invalid doc_id → 400', async () => {
  assert.equal((await fetch(BASE + '/api/docs/Bad_Id/publish', { method: 'POST', headers: A(), body: JSON.stringify({ html: '<p>x</p>' }) })).status, 400);
});

test('oversized html → 413', async () => {
  const big = '<p>' + 'x'.repeat(2 * 1024 * 1024 + 10) + '</p>';
  assert.equal((await fetch(BASE + '/api/docs/big/publish', { method: 'POST', headers: A(), body: JSON.stringify({ html: big }) })).status, 413);
});

test('comment create + agent get roundtrip carries block_type', async () => {
  const v = await (await fetch(BASE + '/api/docs/rep', { headers: R() })).json();
  const bid = (v.html.match(/data-block-id="([^"]+)"/) || [])[1];
  const cr = await fetch(BASE + '/api/docs/rep/comments', { method: 'POST', headers: R(), body: JSON.stringify({ anchor: { block_id: bid, block_text: 'Body', quote: 'Body', block_type: 'p' }, body: 'fix this' }) });
  assert.equal(cr.status, 200);
  const got = await (await fetch(BASE + '/api/docs/rep/comments?status=open', { headers: A() })).json();
  assert.equal(got.threads.length, 1);
  assert.equal(got.threads[0].anchor.block_type, 'p');
});

test('comment on a missing doc → 404 (not 500)', async () => {
  assert.equal((await fetch(BASE + '/api/docs/nope/comments', { method: 'POST', headers: R(), body: JSON.stringify({ anchor: {}, body: 'x' }) })).status, 404);
});

test('magic link → 302, httpOnly cookie, token stripped', async () => {
  const r = await fetch(BASE + '/d/rep?token=' + RT, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/d/rep');
  assert.match(r.headers.get('set-cookie') || '', /margin_token=.*HttpOnly/i);
});

test('cookie authenticates the API', async () => {
  assert.equal((await fetch(BASE + '/api/docs/rep', { headers: { cookie: 'margin_token=' + RT } })).status, 200);
});

test('wait long-poll returns a newly-posted comment', async () => {
  const waitP = fetch(BASE + '/api/docs/rep/wait', { headers: A() }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 250));
  await fetch(BASE + '/api/docs/rep/comments', { method: 'POST', headers: R(), body: JSON.stringify({ anchor: {}, body: 'late comment' }) });
  const out = await waitP;
  assert.equal(out.timed_out, false);
  assert.ok(out.threads.length >= 1);
});

// --- dynamic per-document tokens ---
let scopedToken;

test('link endpoint mints a doc-scoped reviewer token', async () => {
  const r = await fetch(BASE + '/api/docs/rep/link', { method: 'POST', headers: A(), body: JSON.stringify({}) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.url, /\/d\/rep\?token=/);
  scopedToken = decodeURIComponent(j.url.split('token=')[1]);
});

test('a doc-scoped token opens its own doc (200) but not another (403)', async () => {
  const own = await fetch(BASE + '/api/docs/rep', { headers: { authorization: 'Bearer ' + scopedToken } });
  assert.equal(own.status, 200);
  const other = await fetch(BASE + '/api/docs/some-other-doc', { headers: { authorization: 'Bearer ' + scopedToken } });
  assert.equal(other.status, 403);
});

test('a doc-scoped token sees only its doc in the index; the owner sees all', async () => {
  await fetch(BASE + '/api/docs/another/publish', { method: 'POST', headers: A(), body: JSON.stringify({ html: '<p>a</p>' }) });
  const scopedIdx = await (await fetch(BASE + '/api/docs', { headers: { authorization: 'Bearer ' + scopedToken } })).json();
  assert.equal(scopedIdx.docs.length, 1);
  assert.equal(scopedIdx.docs[0].id, 'rep');
  const ownerIdx = await (await fetch(BASE + '/api/docs', { headers: R() })).json();
  assert.ok(ownerIdx.docs.length >= 2);
});

test('an expiring link can be minted', async () => {
  const j = await (await fetch(BASE + '/api/docs/rep/link', { method: 'POST', headers: A(), body: JSON.stringify({ expires_in_days: 7 }) })).json();
  assert.ok(j.expires_at && j.expires_at > Date.now());
});

// --- analytics (owner-only) ---
test('stats needs auth → 401', async () => {
  assert.equal((await fetch(BASE + '/api/stats')).status, 401);
});

test('a doc-scoped token cannot read global stats → 403', async () => {
  assert.equal((await fetch(BASE + '/api/stats', { headers: { authorization: 'Bearer ' + scopedToken } })).status, 403);
});

test('owner reads stats: totals + activity + daily series + recent docs', async () => {
  const r = await fetch(BASE + '/api/stats', { headers: R() });
  assert.equal(r.status, 200);
  const j = await r.json();
  // At least the docs created in earlier tests (rep, another) are counted.
  assert.ok(j.totals.documents >= 2, 'counts documents');
  assert.ok(j.totals.versions >= j.totals.documents, 'versions ≥ documents');
  assert.ok(j.totals.comments >= 1, 'counts comments left earlier');
  assert.ok(j.totals.agent_sessions >= 1, 'counts distinct agent sessions');
  assert.equal(j.totals.open_comments + j.totals.resolved_comments, j.totals.comments);
  assert.equal(j.daily.length, 14, '14-day series');
  assert.ok(Array.isArray(j.recent) && j.recent.length >= 1);
  assert.ok(j.recent[0].id && typeof j.recent[0].updated_at === 'number');
});

test('the analytics page is served at /analytics', async () => {
  const r = await fetch(BASE + '/analytics');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(await r.text(), /Analytics/);
});
