// JSON-file storage backend: one record file per doc + out-of-row HTML files,
// all writes atomic (tmp + fsync + rename). The default backend for local dev.
//
// It implements the small primitive interface the domain layer (store.js) needs:
//   init(opts) · getRecord(id) · putRecord(id, doc) · getHtml(id, v) ·
//   putHtml(id, v, html) · listRecords()
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let DATA_DIR = './data';
const safe = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
const docPath = (id) => path.join(DATA_DIR, safe(id) + '.json');
const htmlPath = (id, v) => path.join(DATA_DIR, safe(id), 'v' + v + '.html');
const decisionHtmlPath = (id, v) => path.join(DATA_DIR, safe(id), 'v' + v + '.decision.html');
// Meta lives in a subdir so listRecords (top-level *.json only) never sees it.
const metaPath = (key) => path.join(DATA_DIR, '.meta', safe(key) + '.json');

export function init(opts = {}) {
  DATA_DIR = (opts && opts.dir) || opts || './data';
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeFileAtomic(p, data) {
  const tmp = p + '.tmp-' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  fsyncDir(path.dirname(p)); // make the rename itself durable (best effort)
}
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* some platforms reject dir fsync — non-fatal */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } }
}

export async function getRecord(id) {
  try { return JSON.parse(fs.readFileSync(docPath(id), 'utf8')); }
  catch { return null; }
}
export async function putRecord(id, doc) {
  writeFileAtomic(docPath(id), JSON.stringify(doc, null, 2));
}
export async function getHtml(id, v) {
  try { return fs.readFileSync(htmlPath(id, v), 'utf8'); }
  catch { return null; }
}
export async function putHtml(id, v, html) {
  const p = htmlPath(id, v);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, html || '');
}
// The optional interactive decision-widget payload for a version (parallel to
// getHtml/putHtml; stored alongside the review HTML).
export async function getDecisionHtml(id, v) {
  try { return fs.readFileSync(decisionHtmlPath(id, v), 'utf8'); }
  catch { return null; }
}
export async function putDecisionHtml(id, v, html) {
  const p = decisionHtmlPath(id, v);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, html || '');
}
export async function listRecords() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    // One malformed file must not take down the whole index.
    try { out.push(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))); } catch { /* skip */ }
  }
  return out;
}

// Small key/value config store (e.g. the self-provisioned signing secret).
export async function getMeta(key) {
  try { return JSON.parse(fs.readFileSync(metaPath(key), 'utf8')).v; }
  catch { return null; }
}
export async function putMeta(key, value) {
  const p = metaPath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify({ v: value }));
}
// No incrWithTtl: the JSON backend is local/single-user, so create isn't rate
// limited (store.rateLimit treats a missing primitive as "always allowed").
