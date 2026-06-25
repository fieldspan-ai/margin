// Owner password (HTTP Basic Auth) — the native login that gates the analytics
// dashboard. Spins up a server with MARGIN_OWNER_PASSWORD set and proves the
// browser-native challenge + that valid credentials act as an owner-master
// credential for /analytics and /api/stats.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8700 + (process.pid % 90);
const BASE = `http://localhost:${PORT}`;
const PW = 'sekret-owner-pass';
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
let child, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-owner-'));
  child = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    // No AGENT_API_KEY / REVIEWER_TOKEN — the password is the only owner credential.
    env: { PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dir, PUBLIC_BASE_URL: BASE, MARGIN_OWNER_PASSWORD: PW },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { try { child.kill(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('/analytics with no credentials → 401 + Basic challenge (browser shows its dialog)', async () => {
  const r = await fetch(BASE + '/analytics');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') || '', /^Basic realm=/i);
});

test('/analytics with a wrong password → 401', async () => {
  const r = await fetch(BASE + '/analytics', { headers: { authorization: basic('owner', 'nope') } });
  assert.equal(r.status, 401);
});

test('/analytics with the owner password → 200 (the dashboard shell)', async () => {
  const r = await fetch(BASE + '/analytics', { headers: { authorization: basic('owner', PW) } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  assert.match(await r.text(), /Analytics/);
});

test('/api/stats accepts the owner password (the auto-attached Basic credential)', async () => {
  const r = await fetch(BASE + '/api/stats', { headers: { authorization: basic('owner', PW) } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.totals && typeof j.totals.documents === 'number');
  assert.equal(j.daily.length, 14);
});

test('/api/stats without the password → 401 (owner credential required)', async () => {
  assert.equal((await fetch(BASE + '/api/stats')).status, 401);
});

test('the owner password is owner-master scope: full read + the docs index, but not publish', async () => {
  // Open-create a doc (agent-first: no credential needed).
  const created = await (await fetch(BASE + '/api/docs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html: '<p>hi</p>', title: 'Owned' }),
  })).json();
  // The owner password sees it in the global index and can read the doc view.
  const idx = await (await fetch(BASE + '/api/docs', { headers: { authorization: basic('owner', PW) } })).json();
  assert.ok(idx.docs.some((d) => d.id === created.doc_id), 'owner sees the doc in the index');
  assert.equal((await fetch(BASE + '/api/docs/' + created.doc_id, { headers: { authorization: basic('owner', PW) } })).status, 200);
  // Publishing stays agent-only — the owner master is refused, exactly like REVIEWER_TOKEN.
  const pub = await fetch(BASE + '/api/docs/' + created.doc_id + '/publish', {
    method: 'POST', headers: { authorization: basic('owner', PW), 'content-type': 'application/json' },
    body: JSON.stringify({ html: '<p>x</p>' }),
  });
  assert.equal(pub.status, 403);
});
