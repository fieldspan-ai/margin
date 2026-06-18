// Agent-first auth — the server runs with NO pre-shared keys. An agent creates a
// document with no credential and gets back capability tokens; those tokens (and
// only those) grant access. Proves the self-provisioning + open-create path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8800 + (process.pid % 90);
const BASE = `http://localhost:${PORT}`;
let child, dir;

const tokenOf = (url) => decodeURIComponent(String(url).split('token=')[1] || '');

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-af-'));
  // No AGENT_API_KEY / REVIEWER_TOKEN / MARGIN_SECRET — fully keyless.
  child = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    env: { PORT: String(PORT), DATA_DIR: dir, PUBLIC_BASE_URL: BASE, PATH: process.env.PATH },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { try { child.kill(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const J = { 'content-type': 'application/json' };

test('create needs no credential and returns capability tokens', async () => {
  const r = await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ title: 'Report', html: '<h1>Hi</h1><p>Body</p>' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.doc_id && j.agent_token, 'returns a doc id + agent token');
  assert.equal(j.version, 1);
  assert.match(j.reviewer_url, /\/d\/.+\?token=/);
  // readable prefix + random suffix → not a guessable slug
  assert.match(j.doc_id, /^report-[0-9a-f]{16}$/);
});

test('create rejects missing html', async () => {
  assert.equal((await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: '{}' })).status, 400);
});

test('agent token revises its own doc; reviewer token cannot publish', async () => {
  const c = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>v1</p>' }) })).json();
  const agent = c.agent_token, reviewer = tokenOf(c.reviewer_url);
  const rev = await fetch(`${BASE}/api/docs/${c.doc_id}/publish`, { method: 'POST', headers: { ...J, authorization: 'Bearer ' + agent }, body: JSON.stringify({ html: '<p>v2</p>' }) });
  assert.equal((await rev.json()).version, 2);
  const bad = await fetch(`${BASE}/api/docs/${c.doc_id}/publish`, { method: 'POST', headers: { ...J, authorization: 'Bearer ' + reviewer }, body: JSON.stringify({ html: '<p>nope</p>' }) });
  assert.equal(bad.status, 403);
});

test('reviewer comments; agent reads them back', async () => {
  const c = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>review me</p>' }) })).json();
  const reviewer = tokenOf(c.reviewer_url);
  const post = await fetch(`${BASE}/api/docs/${c.doc_id}/comments`, { method: 'POST', headers: { ...J, authorization: 'Bearer ' + reviewer }, body: JSON.stringify({ anchor: {}, body: 'please cite' }) });
  assert.equal(post.status, 200);
  const got = await (await fetch(`${BASE}/api/docs/${c.doc_id}/comments?status=open`, { headers: { authorization: 'Bearer ' + c.agent_token } })).json();
  assert.equal(got.threads.length, 1);
  assert.equal(got.threads[0].body, 'please cite');
});

test("a doc's agent token cannot touch another doc", async () => {
  const a = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>a</p>' }) })).json();
  const b = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>b</p>' }) })).json();
  const cross = await fetch(`${BASE}/api/docs/${b.doc_id}`, { headers: { authorization: 'Bearer ' + a.agent_token } });
  assert.equal(cross.status, 403);
});

test('an agent capability can mint a reviewer link for its own doc, but a reviewer link cannot', async () => {
  const c = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>x</p>' }) })).json();
  const mint = await fetch(`${BASE}/api/docs/${c.doc_id}/link`, { method: 'POST', headers: { ...J, authorization: 'Bearer ' + c.agent_token }, body: '{}' });
  assert.equal(mint.status, 200);
  assert.match((await mint.json()).url, /\/d\/.+\?token=/);
  const denied = await fetch(`${BASE}/api/docs/${c.doc_id}/link`, { method: 'POST', headers: { ...J, authorization: 'Bearer ' + tokenOf(c.reviewer_url) }, body: '{}' });
  assert.equal(denied.status, 403);
});

test('a reviewer can remove their own comment; another identity cannot', async () => {
  const c = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>x</p>' }) })).json();
  const reviewer = tokenOf(c.reviewer_url);
  const post = await (await fetch(`${BASE}/api/docs/${c.doc_id}/comments`, { method: 'POST', headers: { ...J, authorization: 'Bearer ' + reviewer }, body: JSON.stringify({ anchor: {}, body: 'remove me' }) })).json();
  // the agent (different identity) cannot delete a human's comment
  const denied = await fetch(`${BASE}/api/docs/${c.doc_id}/comments/${post.id}/delete`, { method: 'POST', headers: { authorization: 'Bearer ' + c.agent_token } });
  assert.equal(denied.status, 403);
  // the author (reviewer) can, and it returns the body so the client can offer undo
  const ok = await fetch(`${BASE}/api/docs/${c.doc_id}/comments/${post.id}/delete`, { method: 'POST', headers: { authorization: 'Bearer ' + reviewer } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).body, 'remove me');
  const after = await (await fetch(`${BASE}/api/docs/${c.doc_id}/comments?status=all`, { headers: { authorization: 'Bearer ' + c.agent_token } })).json();
  assert.equal(after.threads.length, 0);
});

test('the self-provisioned signing secret persists across a restart', async () => {
  const c = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: J, body: JSON.stringify({ html: '<p>persist</p>' }) })).json();
  // Restart the server against the same data dir.
  child.kill(); await new Promise((r) => setTimeout(r, 300));
  child = spawn('node', ['server/server.js'], { cwd: ROOT, env: { PORT: String(PORT), DATA_DIR: dir, PUBLIC_BASE_URL: BASE, PATH: process.env.PATH }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 100)); }
  // The token minted before the restart still verifies → the secret was persisted, not regenerated.
  const view = await fetch(`${BASE}/api/docs/${c.doc_id}`, { headers: { authorization: 'Bearer ' + c.agent_token } });
  assert.equal(view.status, 200);
});
