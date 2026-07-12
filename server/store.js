// Margin storage — domain logic over a pluggable backend.
//
// The backend provides only primitives (get/put a doc record, get/put a version's
// HTML, list records); all the document logic — block-id reconciliation on
// publish, anchor resolution, comment fingerprinting — lives here and is
// backend-agnostic. The interface is async so a remote store (KV) drops in with
// no call-site changes.
//
//   STORE=kv     → Vercel KV / Upstash Redis (serverless)
//   STORE=memory → in-memory Redis (the real KV code path, no infra — local/CI)
//   default      → JSON files
import crypto from 'node:crypto';
import { processPublish, resolveAnchor } from './blocks.js';
import * as jsonBackend from './store/backend-json.js';
import * as kvBackend from './store/backend-kv.js';
import { createMemoryRedis } from './store/memory-redis.js';

let backend = jsonBackend;
const uid = (p) => (p || 'id') + '_' + crypto.randomBytes(5).toString('hex');

export async function init(dir, opts = {}) {
  // 'memory' runs the KV backend over an in-memory client — same code path as
  // production KV, no Upstash needed. A caller can also inject opts.client (tests).
  const mode = opts.kv ? 'kv' : (opts.memory ? 'memory' : process.env.STORE);
  if (mode === 'kv' || mode === 'memory' || opts.client) {
    backend = kvBackend;
    if (opts.client) await backend.init({ client: opts.client });
    else if (mode === 'memory') await backend.init({ client: createMemoryRedis() });
    else await backend.init(opts);
  } else {
    backend = jsonBackend;
    backend.init(dir);
  }
}

function normalize(d) {
  if (!d) return null;
  if (!Array.isArray(d.versions)) d.versions = [];
  if (!Array.isArray(d.comments)) d.comments = [];
  return d;
}
async function readDoc(id) { return normalize(await backend.getRecord(id)); }
async function writeDoc(doc) { doc.updatedAt = Date.now(); await backend.putRecord(doc.id, doc); return doc; }
// Read a version's HTML; fall back to legacy inline html for docs not yet migrated.
async function readHtml(id, v, versionObj) {
  const h = await backend.getHtml(id, v);
  if (h != null) return h;
  return (versionObj && typeof versionObj.html === 'string') ? versionObj.html : '';
}

// --- self-provisioning signing secret ---
// The server signs reviewer/agent links with this. If no MARGIN_SECRET is set in
// the environment, the server generates one on first use and persists it to the
// store, so an instance needs zero human-configured secrets to operate.
let cachedSecret = null;
export async function getSigningSecret() {
  if (cachedSecret) return cachedSecret;
  let s = (await backend.getMeta?.('signing_secret')) || null;
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await backend.putMeta?.('signing_secret', s);
  }
  cachedSecret = s;
  return s;
}

// Create a document under a server-assigned, unguessable id (agent-first: the
// caller never picks the id, so ids aren't enumerable). An optional human-readable
// hint becomes a slug prefix purely for legibility; the random suffix is the security.
export async function createDoc({ title, html, summary, author, idHint } = {}) {
  const slug = (idHint || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  let id;
  for (let i = 0; i < 6; i++) {
    const rand = crypto.randomBytes(8).toString('hex'); // 16 hex chars
    id = slug ? `${slug}-${rand}` : `d-${rand}`;
    if (!(await backend.getRecord(id))) break;
  }
  const r = await publish(id, { title, html, summary, author });
  return { docId: id, version: r.version };
}

// Per-key rate limit. Returns true if the action is allowed. Backends without an
// atomic counter (the JSON file backend, i.e. local single-user) never limit.
export async function rateLimit(key, max, windowSec) {
  if (typeof backend.incrWithTtl !== 'function') return true;
  const n = await backend.incrWithTtl(key, windowSec);
  return n <= max;
}

export async function listDocs() {
  const recs = await backend.listRecords();
  return recs.map((d) => ({
    id: d.id,
    title: d.title,
    version: d.currentVersion,
    updatedAt: d.updatedAt,
    owner: d.owner,
    openComments: (d.comments || []).filter((c) => c.status === 'open').length,
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id) {
  return readDoc(id);
}

// Reviewer-facing shape: latest HTML + version summaries + comments with their
// server-resolved display anchor (solid / soft / orphan).
export async function getDocView(id) {
  const d = await readDoc(id);
  if (!d) return null;
  const latest = d.versions[d.versions.length - 1];
  const html = latest ? await readHtml(id, latest.v, latest) : '';
  const currentBlocks = d.currentBlocks || [];
  return {
    id: d.id,
    title: d.title,
    owner: d.owner,
    version: d.currentVersion,
    html,
    versions: d.versions.map((v) => ({
      v: v.v, author: v.author, summary: v.summary, createdAt: v.createdAt,
    })),
    comments: (d.comments || []).map((c) => ({ ...c, resolved: resolveAnchor(c.anchor, currentBlocks) })),
    updatedAt: d.updatedAt,
  };
}

export async function publish(id, { title, html, author, summary }) {
  let doc = await readDoc(id);
  const now = Date.now();
  if (!doc) {
    doc = {
      id,
      title: title || id,
      owner: author || { identity: 'agent', name: 'agent' },
      currentVersion: 0,
      versions: [],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
  }
  if (title) doc.title = title;
  if (author) doc.owner = author;
  // Migrate any legacy inline-html versions out-of-row, then drop the inline copy.
  for (const ver of doc.versions) {
    if (typeof ver.html === 'string') {
      await backend.putHtml(id, ver.v, ver.html);
      delete ver.html;
    }
  }
  const v = doc.currentVersion + 1;
  // Assign stable, version-carried block ids and inject them into the markup.
  const proc = processPublish(doc.currentBlocks || [], html || '', doc.nextBlockNum || 1);
  await backend.putHtml(id, v, proc.html);
  doc.currentBlocks = proc.blocks;
  doc.nextBlockNum = proc.nextBlockNum;
  doc.versions.push({
    v,
    author: author || doc.owner,
    summary: summary || (v === 1 ? 'Initial publish' : 'Revised'),
    createdAt: now,
  });
  doc.currentVersion = v;
  await writeDoc(doc);
  return { docId: id, version: v };
}

export async function addComment(id, { anchor, body, author }) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const a = anchor || {};
  // Snapshot the server's authoritative normalized text for the anchored block so
  // resolveAnchor can later tell "unchanged" (solid) from "edited" (soft).
  const aid = a.block_id || a.block_mid;
  if (aid && Array.isArray(doc.currentBlocks)) {
    const cb = doc.currentBlocks.find((b) => b.id === aid);
    if (cb) a.block_fingerprint = cb.t;
  }
  const c = {
    id: uid('c'),
    anchor: a,
    body: body || '',
    author,
    status: 'open',
    version: doc.currentVersion,
    createdAt: Date.now(),
    replies: [],
  };
  doc.comments.push(c);
  await writeDoc(doc);
  return c;
}

export async function addReply(id, commentId, { body, author }) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const c = doc.comments.find((x) => x.id === commentId);
  if (!c) return null;
  const r = { id: uid('r'), body: body || '', author, createdAt: Date.now() };
  c.replies.push(r);
  await writeDoc(doc);
  return r;
}

// Remove a comment. Returns the deleted comment (so the caller can offer undo)
// or null if the doc/comment doesn't exist.
export async function deleteComment(id, commentId) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const i = doc.comments.findIndex((x) => x.id === commentId);
  if (i === -1) return null;
  const [removed] = doc.comments.splice(i, 1);
  await writeDoc(doc);
  return removed;
}

export async function setStatus(id, commentId, status) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const c = doc.comments.find((x) => x.id === commentId);
  if (!c) return null;
  c.status = status;
  await writeDoc(doc);
  return c;
}

// Aggregate usage analytics across every document — backend-agnostic (reads the
// same listRecords() the index uses). Returns snake_case wire fields. "Agent
// sessions" (distinct owner.session_id) is the closest thing to a unique-user
// count: agents own docs under a session identity, while reviewers are anonymous.
export async function stats({ days = 14, recent = 8 } = {}) {
  const recs = await backend.listRecords();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10); // UTC yyyy-mm-dd

  const totals = {
    documents: 0, versions: 0, comments: 0, open_comments: 0,
    resolved_comments: 0, replies: 0, agent_sessions: 0,
  };
  const activity = {
    docs_last_7d: 0, docs_last_30d: 0, comments_last_7d: 0,
    active_docs_7d: 0, last_activity: 0,
  };
  const sessions = new Set();
  // Pre-seed the last `days` buckets (oldest→newest) so quiet days render as zero.
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) buckets.set(dayKey(now - i * DAY), { docs: 0, comments: 0 });

  for (const d of recs) {
    totals.documents++;
    totals.versions += d.currentVersion || (Array.isArray(d.versions) ? d.versions.length : 0);
    const owner = d.owner || {};
    if (owner.session_id) sessions.add(String(owner.session_id));

    const created = d.createdAt
      || (Array.isArray(d.versions) && d.versions[0] && d.versions[0].createdAt)
      || d.updatedAt || now;
    if (now - created < 7 * DAY) activity.docs_last_7d++;
    if (now - created < 30 * DAY) activity.docs_last_30d++;
    if (d.updatedAt && now - d.updatedAt < 7 * DAY) activity.active_docs_7d++;
    if ((d.updatedAt || 0) > activity.last_activity) activity.last_activity = d.updatedAt || 0;
    const cb = buckets.get(dayKey(created)); if (cb) cb.docs++;

    for (const c of (d.comments || [])) {
      totals.comments++;
      if (c.status === 'resolved') totals.resolved_comments++; else totals.open_comments++;
      totals.replies += Array.isArray(c.replies) ? c.replies.length : 0;
      if (c.createdAt && now - c.createdAt < 7 * DAY) activity.comments_last_7d++;
      const bb = c.createdAt && buckets.get(dayKey(c.createdAt)); if (bb) bb.comments++;
    }
  }
  totals.agent_sessions = sessions.size;

  const daily = [...buckets.entries()].map(([date, v]) => ({ date, docs: v.docs, comments: v.comments }));
  const recentDocs = recs
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, recent)
    .map((d) => ({
      id: d.id,
      title: d.title || d.id,
      version: d.currentVersion || 0,
      comments: (d.comments || []).length,
      open_comments: (d.comments || []).filter((c) => c.status === 'open').length,
      updated_at: d.updatedAt || 0,
    }));

  return { totals, activity, daily, recent: recentDocs, generated_at: now };
}

// Agent-facing shape: just the threads it needs to act on.
export async function getComments(id, { status } = {}) {
  const doc = await readDoc(id);
  if (!doc) return null;
  let cs = doc.comments;
  if (status) cs = cs.filter((c) => c.status === status);
  return {
    docId: id,
    title: doc.title,
    version: doc.currentVersion,
    threads: cs.map((c) => {
      const blockId = c.anchor.block_id || c.anchor.block_mid || null;
      return {
        id: c.id,
        status: c.status,
        version: c.version,
        // 'document' = a file-level comment with no block anchor at all (left via
        // the viewer's "+ Comment" button); 'block' = anchored to a specific span.
        scope: blockId ? 'block' : 'document',
        anchor: { block_id: blockId, quote: c.anchor.quote || null, block_text: c.anchor.block_text || null, block_type: c.anchor.block_type || null },
        author: (c.author?.name || 'unknown') + ' (' + (c.author?.identity || '?') + ')',
        body: c.body,
        replies: c.replies.map((r) => ({ author: (r.author?.name || 'unknown') + ' (' + (r.author?.identity || '?') + ')', body: r.body })),
      };
    }),
  };
}
