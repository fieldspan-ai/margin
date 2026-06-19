// Vercel KV / Upstash Redis storage backend — for the serverless deploy.
//
// Same primitive interface as backend-json. Documents and comments live as KV
// records, an index sorted-set keeps listDocs newest-first, and version HTML is
// stored as KV values (move large HTML to Vercel Blob in a follow-up). Stateless
// per request, which is what serverless wants.
//
// Tests inject a fake client via init({ client }); production builds one from the
// environment with @upstash/redis. Both the Vercel KV naming (KV_REST_API_URL /
// KV_REST_API_TOKEN) and the native Upstash naming (UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN) are accepted.
let redis = null;

const safe = (id) => String(id).replace(/[^a-zA-Z0-9_:-]/g, '_');
const K = {
  doc: (id) => 'doc:' + safe(id),
  html: (id, v) => 'doc:' + safe(id) + ':html:v' + v,
  decision: (id, v) => 'doc:' + safe(id) + ':decision:v' + v,
  index: 'docs:index',
  meta: (key) => 'meta:' + safe(key),
  rl: (key) => 'rl:' + safe(key),
};

export async function init(opts = {}) {
  if (opts && opts.client) { redis = opts.client; return; }
  let Redis;
  try { ({ Redis } = await import('@upstash/redis')); }
  catch { throw new Error('STORE=kv needs the @upstash/redis package — run: npm i @upstash/redis'); }
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('STORE=kv needs KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) in the environment');
  }
  redis = new Redis({ url, token });
}

// @upstash/redis returns parsed objects for JSON-ish values; tolerate both.
function parse(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export async function getRecord(id) {
  return parse(await redis.get(K.doc(id)));
}
export async function putRecord(id, doc) {
  await redis.set(K.doc(id), JSON.stringify(doc));
  await redis.zadd(K.index, { score: doc.updatedAt || Date.now(), member: safe(id) });
}
export async function getHtml(id, v) {
  const h = await redis.get(K.html(id, v));
  return h == null ? null : String(h);
}
export async function putHtml(id, v, html) {
  await redis.set(K.html(id, v), html || '');
}
// The optional interactive decision-widget payload for a version (parallel to
// getHtml/putHtml).
export async function getDecisionHtml(id, v) {
  const h = await redis.get(K.decision(id, v));
  return h == null ? null : String(h);
}
export async function putDecisionHtml(id, v, html) {
  await redis.set(K.decision(id, v), html || '');
}
export async function listRecords() {
  const ids = await redis.zrange(K.index, 0, -1, { rev: true });
  if (!ids || !ids.length) return [];
  const vals = await redis.mget(...ids.map((i) => 'doc:' + i));
  return (vals || []).map(parse).filter(Boolean);
}

// Small key/value config store (e.g. the self-provisioned signing secret).
// Kept out of the docs index so it never shows up as a document.
export async function getMeta(key) {
  const r = parse(await redis.get(K.meta(key)));
  return r ? r.v : null;
}
export async function putMeta(key, value) {
  await redis.set(K.meta(key), JSON.stringify({ v: value }));
}

// Atomic counter with a TTL — backs the per-IP create rate limit. Returns the
// post-increment count; the window resets when the key expires.
export async function incrWithTtl(key, ttlSec) {
  const n = await redis.incr(K.rl(key));
  if (n === 1) await redis.expire(K.rl(key), ttlSec);
  return n;
}
