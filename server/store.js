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

// The rid is the reviewer's anonymous browser identity — internal queue-scoping
// state, not something every other reader of a comment should see. Strips it
// from the RETURNED shape only; storage (and the queue's per-rid scoping) keeps it.
const pubAuthor = (a) => { if (!a) return a; const { rid, ...pub } = a; return pub; };

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
    comments: (d.comments || []).map((c) => ({
      ...c,
      author: pubAuthor(c.author),
      replies: (c.replies || []).map((r) => ({ ...r, author: pubAuthor(r.author) })),
      resolved: resolveAnchor(c.anchor, currentBlocks),
    })),
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

// Net invariant: Object.keys(doc.reviews) ⊆ doc.reviewerIds. A per-rid review
// marker is only meaningful for a rid the doc still tracks membership for; once
// bindRid's cap evicts a rid, any reviews[rid] left behind is a dead orphan.
function pruneReviews(doc) {
  if (!doc.reviews) return;
  const ids = new Set(doc.reviewerIds || []);
  for (const rid of Object.keys(doc.reviews)) {
    if (!ids.has(rid)) delete doc.reviews[rid];
  }
}

// A doc remembers which anonymous browser identities (rids) have opened it —
// that membership is what scopes the per-person queue. Capped drop-oldest so a
// public link can't grow the record without bound. Returns true if it changed.
const MAX_REVIEWER_IDS = 50;
function bindRid(doc, rid) {
  if (!Array.isArray(doc.reviewerIds)) doc.reviewerIds = [];
  if (doc.reviewerIds.includes(rid)) return false;
  doc.reviewerIds.push(rid);
  while (doc.reviewerIds.length > MAX_REVIEWER_IDS) doc.reviewerIds.shift();
  pruneReviews(doc); // the 50-cap just evicted a rid — its marker goes with it
  return true;
}

// Bind a browser identity to a document ("you are what you've opened"). Written
// via putRecord directly — NOT writeDoc — because binding is not content
// activity and must not bump updatedAt. No-op when already bound.
export async function bindReviewer(id, rid) {
  if (!rid) return;
  const doc = await readDoc(id);
  if (!doc) return;
  if (!bindRid(doc, rid)) return;
  await backend.putRecord(id, doc);
}

// Any human write action is an implicit "I've seen this version" — it advances
// the review marker the queue derives its states from (see reviewQueue). The
// legacy/global marker always moves; when the author carries a rid, their
// per-person marker moves too (and the write itself binds them to the doc —
// writeDoc persists it along with the content change).
function markHumanReview(doc, author) {
  if (author?.identity !== 'human') return;
  const mark = { version: doc.currentVersion, at: Date.now() };
  doc.review = mark;
  if (author.rid) {
    doc.reviews = doc.reviews || {};
    doc.reviews[author.rid] = mark;
    bindRid(doc, author.rid);
    pruneReviews(doc);
  }
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
  markHumanReview(doc, author);
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
  markHumanReview(doc, author);
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

export async function setStatus(id, commentId, status, author) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const c = doc.comments.find((x) => x.id === commentId);
  if (!c) return null;
  c.status = status;
  markHumanReview(doc, author);
  await writeDoc(doc);
  return c;
}

// Whether this anonymous browser identity has claimed this doc by opening its
// reviewer link before (see bindReviewer). Membership + the signed rid cookie
// is what lets the queue's many docs work with a single-slot doc-token cookie.
export async function isBoundReviewer(id, rid) {
  if (!rid) return false;
  const doc = await readDoc(id);
  return !!(doc && Array.isArray(doc.reviewerIds) && doc.reviewerIds.includes(rid));
}

// Explicitly mark a document reviewed up to its current version (the queue's
// "Done" button). Same markers the implicit human-write path sets: the
// legacy/global one always, plus the caller's per-person one when a rid is given.
export async function markReviewed(id, { rid } = {}) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const mark = { version: doc.currentVersion, at: Date.now() };
  doc.review = mark;
  if (rid) {
    doc.reviews = doc.reviews || {};
    doc.reviews[rid] = mark;
    bindRid(doc, rid); // the Done button is also "you've opened this doc" (was missing — orphan reviews[rid])
    pruneReviews(doc);
  }
  await writeDoc(doc);
  return { doc_id: id, reviewed_version: doc.currentVersion };
}

// --- "agent waiting now" pulse ---
// Lives in a single shared meta key (agent_waits: { [docId]: msEpoch}), NOT the
// doc record. The old approach did a full-record read-modify-write on every
// /wait poll; on KV a concurrent comment writeDoc landing inside that window
// was silently clobbered. Keeping the stamp out of doc storage removes that
// lost-update window entirely, and skipping the write when the stamp is still
// fresh cuts the write rate ~40x for a busy poller.
const AGENT_WAIT_STAMP_SKIP_MS = 30 * 1000;
// A stamp within this window means the agent is blocked on the reviewer right
// now (polls re-stamp well inside it); also the prune threshold for the map.
const AGENT_WAIT_FRESH_MS = 120 * 1000;

async function readAgentWaits() {
  const raw = await backend.getMeta?.('agent_waits');
  return (raw && typeof raw === 'object') ? raw : {}; // corrupt/missing → treat as empty
}

export async function noteAgentWait(id) {
  const map = await readAgentWaits();
  const now = Date.now();
  if (map[id] && now - map[id] < AGENT_WAIT_STAMP_SKIP_MS) return; // still fresh — skip the write
  map[id] = now;
  for (const k of Object.keys(map)) {
    if (now - map[k] > AGENT_WAIT_FRESH_MS) delete map[k];
  }
  // Two pollers stamping the same doc at once can overwrite each other's value
  // momentarily — harmless (both are "now enough"), and not worth a lock for.
  await backend.putMeta?.('agent_waits', map);
}

// The reviewer's triage list: one row per document with whose turn it is and
// since when. Derived on read from the same listRecords() scan stats() uses —
// only the review markers are persisted on the doc; the agent-wait pulse comes
// from the separate agent_waits meta map (one read for the whole call).
//
// Without opts.rid this is the global (owner) view — scope 'all'. With a rid it
// is that person's view — scope 'mine': only docs they've opened (reviewerIds),
// their own review marker (doc.reviews[rid]), and only the threads that involve
// them. A thread involves a rid if any of its messages carries that rid, OR its
// ROOT comment's author has no rid — a root rule, not a "every human message"
// one, so a legacy human-rootless thread AND an agent-initiated thread both
// stay everyone's even after one bound reviewer replies into them.
export async function reviewQueue({ rid } = {}) {
  const all = await backend.listRecords();
  const recs = rid ? all.filter((d) => Array.isArray(d.reviewerIds) && d.reviewerIds.includes(rid)) : all;
  const now = Date.now();
  const waits = await readAgentWaits();
  const items = recs.map((d) => {
    const comments = Array.isArray(d.comments) ? d.comments : [];
    const versions = Array.isArray(d.versions) ? d.versions : [];
    const reviewedVersion = rid ? (d.reviews?.[rid]?.version || 0) : (d.review?.version || 0);
    const current = d.currentVersion || 0;
    // A thread's "last message" is the comment itself until someone replies.
    const last = (c) => (Array.isArray(c.replies) && c.replies.length ? c.replies[c.replies.length - 1] : c);
    const involves = (c) => {
      const msgs = [c, ...(Array.isArray(c.replies) ? c.replies : [])];
      if (msgs.some((m) => m.author?.rid === rid)) return true;
      return !c.author?.rid; // root rule: no rid on the thread's own root → shared with everyone
    };
    const open = comments.filter((c) => c.status === 'open').filter((c) => !rid || involves(c));
    const agentLast = open.filter((c) => last(c).author?.identity === 'agent');
    const humanLast = open.filter((c) => last(c).author?.identity !== 'agent');

    // First match wins: an unseen version always outranks thread state.
    let state, waitingSince;
    if (current > reviewedVersion) {
      state = 'awaiting_review';
      const oldestUnseen = versions.find((v) => v.v > reviewedVersion);
      waitingSince = oldestUnseen ? oldestUnseen.createdAt || 0 : d.updatedAt || 0;
    } else if (agentLast.length) {
      state = 'needs_reply';
      waitingSince = Math.max(...agentLast.map((c) => last(c).createdAt || 0));
    } else if (humanLast.length) {
      state = 'waiting_on_agent';
      waitingSince = Math.max(...humanLast.map((c) => last(c).createdAt || 0));
    } else {
      state = 'clear';
      waitingSince = d.updatedAt || 0;
    }
    return {
      doc_id: d.id,
      title: d.title || d.id,
      version: current,
      state,
      open_comments: open.length,
      unseen_versions: Math.max(0, current - reviewedVersion),
      last_published_at: versions.length ? versions[versions.length - 1].createdAt || 0 : 0,
      waiting_since: waitingSince,
      agent_waiting: !!(waits[d.id] && now - waits[d.id] < AGENT_WAIT_FRESH_MS),
      updated_at: d.updatedAt || 0,
    };
  });
  // Ball-with-the-reviewer first, oldest wait first (triage order); then the
  // agent's-turn and settled docs, both newest activity first.
  const rank = { awaiting_review: 0, needs_reply: 0, waiting_on_agent: 1, clear: 2 };
  items.sort((a, b) => rank[a.state] - rank[b.state]
    || (rank[a.state] === 0 ? a.waiting_since - b.waiting_since : b.updated_at - a.updated_at));
  return { generated_at: now, scope: rid ? 'mine' : 'all', items };
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
