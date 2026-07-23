// Margin — the HTTP request handler, shared by the local server and the
// Vercel serverless function.
//
// Two identities authenticate here:
//   - the AGENT publishes HTML and reads comments back, using AGENT_API_KEY
//   - the REVIEWER (you, on your phone) reads + comments, using REVIEWER_TOKEN
// The reviewer token rides in the magic link the agent hands you, so opening
// the link Just Works in a mobile browser.
//
// This module exports a single `handle(req, res)` that speaks the Node http
// (IncomingMessage/ServerResponse) contract, which is also exactly what a
// Vercel Node function receives. `server/server.js` wraps it in a long-running
// http server for local dev; `api/index.js` hands it straight to Vercel.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './config.js';
import * as store from './store.js';
import { verify as verifyToken, mintToken, mintSession, verifySession } from './tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env for local dev. On Vercel there is no .env file (config lives in the
// project's environment variables) so this is a no-op there.
loadDotenv(ROOT);

const PORT = parseInt(process.env.PORT || '8787', 10);
// Keys are OPTIONAL. Unset = agent-first mode: anyone can create a document via
// POST /api/docs and gets back a per-document capability token; no pre-shared
// secret. If set, AGENT_API_KEY is a global agent/host key and REVIEWER_TOKEN is
// the owner master (full read + the docs index) — both still honored.
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';
const REVIEWER_TOKEN = process.env.REVIEWER_TOKEN || '';
const AGENT_NAME = process.env.AGENT_NAME || 'Claude';
const REVIEWER_NAME = process.env.REVIEWER_NAME || 'Reviewer';
// Optional owner password. When set, the analytics dashboard (/analytics) and its
// data (/api/stats) accept HTTP Basic Auth as an owner-master credential — so the
// browser's own native login dialog gates the dashboard with no extra UI to build.
// Independent of AGENT_API_KEY / REVIEWER_TOKEN, so it works in agent-first mode too.
// Unset = disabled (the dashboard then falls back to the token gate, as before).
const OWNER_PASSWORD = process.env.MARGIN_OWNER_PASSWORD || '';
const OWNER_USER = process.env.MARGIN_OWNER_USER || 'owner';
const BASIC_REALM = 'Margin analytics';
// On Vercel, VERCEL_URL is the deployment host; PUBLIC_BASE_URL (a stable
// production domain) wins when set so reviewer links stay constant across deploys.
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`)
).replace(/\/$/, '');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || './data');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const ASSETS_DIR = path.join(VIEWER_DIR, 'assets');
// Static image assets bundled with the landing page (served at /assets/<name>).
const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml; charset=utf-8',
};
// 'kv' (Upstash/Vercel KV) and 'memory' (in-process Redis) both use the KV
// code path; anything else is the JSON file backend.
const STORE_KIND = process.env.STORE === 'kv' ? 'kv' : process.env.STORE === 'memory' ? 'memory' : 'json';
const USE_REMOTE = STORE_KIND !== 'json';

// Input limits / validation.
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // ~2MB of markup per version

// Dynamic-token signing secret. Resolved once per warm instance in ensureStore():
// env MARGIN_SECRET if set, else a random secret the store provisions and persists
// on first use (so no human ever has to configure one).
let SIGNING_SECRET = null;
const LINK_TTL_DAYS = parseFloat(process.env.MARGIN_LINK_TTL_DAYS || '0') || 0; // 0 = no expiry
const LINK_TTL_MS = LINK_TTL_DAYS > 0 ? LINK_TTL_DAYS * 24 * 60 * 60 * 1000 : 0;

// Open-create (agent-first) limits.
const CREATE_RATE_MAX = parseInt(process.env.MARGIN_CREATE_MAX || '30', 10);       // new docs ...
const CREATE_RATE_WINDOW_SEC = parseInt(process.env.MARGIN_CREATE_WINDOW || '3600', 10); // ... per IP per window

// /api/queue is public and does a full-store scan — limit refreshes per IP.
const QUEUE_RATE_MAX = parseInt(process.env.MARGIN_QUEUE_MAX || '120', 10);
const QUEUE_RATE_WINDOW_SEC = parseInt(process.env.MARGIN_QUEUE_WINDOW || '300', 10);

// Long-poll window for /wait. Keep it safely under the function's maxDuration
// (see vercel.json). On serverless there is no shared memory between the
// publisher and the waiter, so /wait polls the store instead of being notified.
const WAIT_MS = parseInt(process.env.MARGIN_WAIT_MS || '25000', 10);
const WAIT_POLL_MS = parseInt(process.env.MARGIN_WAIT_POLL_MS || '1500', 10);

// A key left at the literal "change-me" placeholder on a public URL is an open
// door (it grants the global/owner role). Unset keys are fine — that's just
// agent-first mode. The local server refuses to start on this; the handler 503s.
const usingDefaultKeys = AGENT_API_KEY.includes('change-me') || REVIEWER_TOKEN.includes('change-me');
const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?\/?$/.test(PUBLIC_BASE_URL);

export const config = { PORT, PUBLIC_BASE_URL, DATA_DIR, STORE_KIND, usingDefaultKeys, isLocalBase };

// --- lazy, cached store init + secret resolution (one per warm instance) ---
let storeReady = null;
function ensureStore() {
  if (!storeReady) {
    // store.init reads process.env.STORE to pick kv vs memory; JSON needs the dir.
    storeReady = (USE_REMOTE ? store.init(null) : store.init(DATA_DIR)).then(async () => {
      SIGNING_SECRET = process.env.MARGIN_SECRET || await store.getSigningSecret();
    });
  }
  return storeReady;
}

// --- auth ---
function parseCookies(str) {
  const o = {};
  (str || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function tokenFrom(req, u) {
  // Agent / curl: Authorization: Bearer or x-api-key. Reviewer browser: the
  // httpOnly margin_token cookie (the token is never exposed to page JS). The
  // ?token= query is accepted too, but the server immediately swaps it for the
  // cookie on page loads (see the viewer route) so it doesn't linger in history.
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']);
  const cookies = parseCookies(req.headers['cookie']);
  if (cookies.margin_token) return cookies.margin_token;
  if (u.searchParams.get('token')) return u.searchParams.get('token');
  return null;
}
// The anonymous reviewer identity — a signed session token in the margin_rid
// cookie (see tokens.mintSession). No accounts: the rid is just "this browser",
// and the per-person queue scopes to it. Returns the rid string or null.
function ridFrom(req) {
  const cookies = parseCookies(req.headers['cookie']);
  if (!cookies.margin_rid) return null;
  return verifySession(cookies.margin_rid, SIGNING_SECRET)?.rid || null;
}
// Five years: the queue should follow the browser for as long as the browser lives.
function ridCookie(sessionToken) {
  const secure = PUBLIC_BASE_URL.startsWith('https') ? '; Secure' : '';
  return `margin_rid=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=157680000${secure}`;
}
// Constant-time secret comparison (consistent with tokens.js verify). Hash both
// sides to a fixed length so neither length nor content leaks via timing.
function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}
// HTTP Basic Auth as an owner-master credential (gates the analytics dashboard).
// Only active when MARGIN_OWNER_PASSWORD is set; matches grant the same all-scope
// owner role as REVIEWER_TOKEN. The username defaults to 'owner'. Comparisons are
// constant-time (safeEqual hashes both sides to a fixed length).
function basicOwner(req) {
  if (!OWNER_PASSWORD) return null;
  const m = (req.headers['authorization'] || '').match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  if (safeEqual(user, OWNER_USER) && safeEqual(pass, OWNER_PASSWORD)) {
    return { role: 'owner', scope: 'all', author: { identity: 'human', name: REVIEWER_NAME } };
  }
  return null;
}
// Human identities (never agents) carry the anonymous browser identity when the
// margin_rid cookie is present, so their writes and review markers attribute to
// the person, not just "a human" (see store.reviewQueue's per-rid scoping).
function withRid(auth, req) {
  const rid = ridFrom(req);
  if (rid) auth.author.rid = rid;
  return auth;
}
function identify(req, u) {
  // The owner password (Basic Auth) is checked first — it uses the Authorization
  // header's Basic scheme, which tokenFrom (Bearer/x-api-key) never consumes.
  const b = basicOwner(req);
  if (b) return withRid(b, req);
  const t = tokenFrom(req, u);
  if (!t) return null;
  // If configured, the agent key is a global host secret: full access, can publish
  // and mint links. (Optional — unset in agent-first mode.)
  if (AGENT_API_KEY && safeEqual(t, AGENT_API_KEY)) {
    const session = req.headers['x-agent-session'] || 'session';
    return { role: 'agent', scope: 'all', author: { identity: 'agent', name: AGENT_NAME, session_id: String(session) } };
  }
  // If configured, the reviewer token is the OWNER master: full read + the index.
  if (REVIEWER_TOKEN && safeEqual(t, REVIEWER_TOKEN)) {
    return withRid({ role: 'owner', scope: 'all', author: { identity: 'human', name: REVIEWER_NAME } }, req);
  }
  // Otherwise: a signed, document-scoped capability (a per-doc reviewer link, or a
  // scoped agent token). It only grants its own document.
  const payload = verifyToken(t, SIGNING_SECRET);
  if (payload && payload.d) {
    const role = payload.r === 'agent' ? 'agent' : 'reviewer';
    if (role === 'agent') {
      const author = { identity: 'agent', name: AGENT_NAME, session_id: String(req.headers['x-agent-session'] || ('scoped:' + payload.d)) };
      return { role, scope: 'doc', doc: payload.d, author };
    }
    return withRid({ role, scope: 'doc', doc: payload.d, author: { identity: 'human', name: REVIEWER_NAME } }, req);
  }
  return null;
}
// A doc-scoped token may only touch its own document; all-scope (owner/agent) is unrestricted.
function canAccess(auth, docId) {
  return auth.scope === 'all' || (auth.scope === 'doc' && auth.doc === docId);
}

// --- helpers ---
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, x-agent-session',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}
function readBody(req) {
  // Vercel's Node runtime parses the request body and exposes it as req.body
  // (and consumes the stream). Prefer it when present; otherwise read the raw
  // stream ourselves (the local http server path).
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); } }
    if (typeof req.body === 'object') return Promise.resolve(req.body);
  }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// The reviewer link the agent hands you — the token rides along so the
// mobile browser Just Works. Returned from publish and echoed in views/list
// so the agent can reconstruct it on later turns.
function reviewerUrl(id, ttlMs) {
  const token = mintToken(id, 'reviewer', SIGNING_SECRET, ttlMs === undefined ? LINK_TTL_MS : ttlMs);
  return `${PUBLIC_BASE_URL}/d/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

// --- SSE live updates (best-effort; only delivers within one warm instance,
// so it's an instant-update nicety locally. On serverless the viewer falls back
// to polling — see viewer/index.html — which is what keeps it fresh there). ---
const clients = new Map(); // docId -> Set(res)
function subscribe(docId, res) {
  if (!clients.has(docId)) clients.set(docId, new Set());
  clients.get(docId).add(res);
}
function unsubscribe(docId, res) {
  clients.get(docId)?.delete(res);
}
function broadcast(docId, ev) {
  const set = clients.get(docId);
  if (!set) return;
  const data = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const r of set) { try { r.write(data); } catch { /* dropped */ } }
}

// Per-response nonce + the page's own CSP: the page's single inline <script>
// carries the nonce, so an injected <script> (no nonce) can't execute even if
// escaping ever regressed. Inline styles stay allowed because the rendered
// documents rely on them. __BASE_URL__ is substituted so links/commands point at
// the actual host (the hosted deploy in prod, localhost in dev). `fonts` widens
// style-src/font-src to Google Fonts (the landing uses the Fieldspan typefaces);
// the viewer stays locked down ('self' only).
// `headers` merges extra response headers into the 200 (e.g. the /queue page's
// Set-Cookie for a freshly-minted reviewer session).
function serveHtmlPage(res, file, { fallback, fonts, headers } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  let html;
  try { html = fs.readFileSync(path.join(VIEWER_DIR, file), 'utf8'); }
  catch {
    if (fallback) return fallback();
    res.writeHead(500, CORS); return res.end('page missing');
  }
  html = html.replaceAll('__BASE_URL__', PUBLIC_BASE_URL).replaceAll('__CSP_NONCE__', nonce);
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    fonts ? "style-src 'unsafe-inline' https://fonts.googleapis.com" : "style-src 'unsafe-inline'",
    fonts ? "font-src https://fonts.gstatic.com" : null,
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].filter(Boolean).join('; ');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, ...CORS, ...headers });
  res.end(html);
}
function serveViewer(res) { return serveHtmlPage(res, 'index.html'); }
// The public marketing + onboarding page (front door at /). Falls back to the
// viewer SPA if the file is somehow absent, so the app never hard-fails here.
function serveLanding(res) { return serveHtmlPage(res, 'landing.html', { fallback: () => serveViewer(res), fonts: true }); }

// A plain text asset (the downloadable skill, the installer script). Served from
// the viewer dir with __BASE_URL__ substituted so `curl -o` and `curl | sh` work.
function serveTextAsset(res, file, contentType) {
  let body;
  try { body = fs.readFileSync(path.join(VIEWER_DIR, file), 'utf8'); }
  catch { res.writeHead(404, CORS); return res.end('not found'); }
  body = body.replaceAll('__BASE_URL__', PUBLIC_BASE_URL);
  res.writeHead(200, { 'content-type': contentType, ...CORS });
  res.end(body);
}

// A bundled binary asset (landing-page images) from viewer/assets. Allow-listed
// by extension; the filename is constrained and the resolved path is verified to
// stay inside ASSETS_DIR, so /assets/../ and absolute paths can't escape.
function serveAsset(res, name) {
  const ext = path.extname(name).toLowerCase();
  const type = ASSET_TYPES[ext];
  const full = path.join(ASSETS_DIR, name);
  if (!type || !/^[a-zA-Z0-9._-]+$/.test(name) || !full.startsWith(ASSETS_DIR + path.sep)) {
    res.writeHead(404, CORS); return res.end('not found');
  }
  let buf;
  try { buf = fs.readFileSync(full); }
  catch { res.writeHead(404, CORS); return res.end('not found'); }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', ...CORS });
  res.end(buf);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handle(req, res) {
  try {
    await ensureStore();

    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = u.pathname.split('/').filter(Boolean); // e.g. ['api','docs',':id','comments']
    const method = req.method || 'GET';

    if (method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    // Refuse to serve with default keys on a public URL — a known token on a
    // public host is an open door to every document. (security floor)
    if (usingDefaultKeys && !isLocalBase) {
      return sendJSON(res, 503, { error: 'server misconfigured', hint: 'set strong AGENT_API_KEY and REVIEWER_TOKEN environment variables' });
    }

    // ---- non-API routes -> the viewer (SPA) ----
    if (parts[0] !== 'api') {
      // The site favicon (the Margin brand mark). Browsers also auto-request
      // /favicon.ico; serve the same SVG there so it shows without an .ico file.
      if (u.pathname === '/favicon.svg' || u.pathname === '/favicon.ico') {
        return serveTextAsset(res, 'favicon.svg', 'image/svg+xml; charset=utf-8');
      }
      // The downloadable skill + its one-line installer. Served as plain files so
      // `curl -o` / `curl | sh` Just Work; __BASE_URL__ is substituted to this host.
      if (u.pathname === '/skill.md') return serveTextAsset(res, 'skill/SKILL.md', 'text/markdown; charset=utf-8');
      if (u.pathname === '/install.sh') return serveTextAsset(res, 'install.sh', 'text/x-shellscript; charset=utf-8');
      if (u.pathname === '/llms.txt') return serveTextAsset(res, 'llms.txt', 'text/plain; charset=utf-8');
      // Bundled landing-page images (og/social card + in-page showcase).
      if (parts[0] === 'assets' && parts.length === 2) return serveAsset(res, parts[1]);
      // Owner analytics dashboard. Its data (/api/stats) is always owner-scoped.
      // When MARGIN_OWNER_PASSWORD is set we challenge the page navigation itself
      // with HTTP Basic Auth, so the browser shows its native login dialog and
      // then auto-attaches the credentials to the page's /api/stats fetch. With no
      // password set, the shell loads and falls back to the in-page token gate.
      if (u.pathname === '/analytics') {
        if (OWNER_PASSWORD && !(identify(req, u)?.scope === 'all')) {
          res.writeHead(401, {
            'www-authenticate': `Basic realm="${BASIC_REALM}", charset="UTF-8"`,
            'content-type': 'text/plain; charset=utf-8',
            ...CORS,
          });
          return res.end('Authentication required');
        }
        return serveHtmlPage(res, 'analytics.html', { fallback: () => serveViewer(res) });
      }
      // Magic link: ?token rides in the URL once, then we move it into an httpOnly
      // cookie and redirect to a clean URL so it never sits in history or reaches
      // page JS. (decision #2)
      const qtok = u.searchParams.get('token');
      if (qtok) {
        u.searchParams.delete('token');
        const qs = u.searchParams.toString();
        const headers = { location: u.pathname + (qs ? '?' + qs : ''), ...CORS };
        // Set the cookie for the owner master, the agent key, or any valid signed
        // (doc-scoped) token. An invalid token still gets stripped via the redirect.
        const payload = verifyToken(qtok, SIGNING_SECRET);
        const isValid = (REVIEWER_TOKEN && safeEqual(qtok, REVIEWER_TOKEN)) || (AGENT_API_KEY && safeEqual(qtok, AGENT_API_KEY)) || !!payload;
        if (isValid) {
          const secure = PUBLIC_BASE_URL.startsWith('https') ? '; Secure' : '';
          const cookies = [`margin_token=${encodeURIComponent(qtok)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`];
          // Opening a magic link is the moment a browser starts accumulating a
          // queue: ensure the anonymous reviewer identity (rid) exists, and bind
          // this doc to it ("you are what you've opened").
          let rid = ridFrom(req);
          if (!rid) {
            const sess = mintSession(SIGNING_SECRET);
            rid = verifySession(sess, SIGNING_SECRET).rid;
            cookies.push(ridCookie(sess));
          }
          if (payload && payload.d) await store.bindReviewer(payload.d, rid);
          headers['set-cookie'] = cookies.length > 1 ? cookies : cookies[0];
        }
        res.writeHead(302, headers);
        return res.end();
      }
      // Reviewer triage queue — PUBLIC: the page scopes itself to the visitor's
      // anonymous rid cookie (minted here if the browser doesn't have one yet).
      // Placed after the magic-link strip above so /queue?token=… lands the
      // httpOnly cookie (and redirects to a clean /queue) before the page is
      // served. Owner escape hatch: /queue?all=1 raises the same Basic challenge
      // as /analytics, so the owner can force the global view from a fresh browser.
      if (u.pathname === '/queue') {
        if (u.searchParams.get('all') === '1' && OWNER_PASSWORD && !(identify(req, u)?.scope === 'all')) {
          res.writeHead(401, {
            'www-authenticate': `Basic realm="${BASIC_REALM}", charset="UTF-8"`,
            'content-type': 'text/plain; charset=utf-8',
            ...CORS,
          });
          return res.end('Authentication required');
        }
        const headers = {};
        if (!ridFrom(req)) headers['set-cookie'] = ridCookie(mintSession(SIGNING_SECRET));
        return serveHtmlPage(res, 'queue.html', { fallback: () => serveViewer(res), headers });
      }
      // AI/agent user agents hitting the root get the machine-readable landing.
      if (u.pathname === '/' && /claude|anthropic|openai|chatgpt|python-httpx|python-requests/i.test(req.headers['user-agent'] || '')) {
        res.writeHead(302, { location: '/llms.txt', ...CORS });
        return res.end();
      }
      // Public landing page at the front door. An owner (global agent key or the
      // owner-master REVIEWER_TOKEN) still gets the viewer's docs index at '/';
      // everyone else — the whole public — gets the marketing + onboarding page.
      if (u.pathname === '/' || u.pathname === '/start' || u.pathname === '/get-started') {
        const auth = identify(req, u);
        if (!(auth && auth.scope === 'all')) return serveLanding(res);
      }
      return serveViewer(res); // '/d/:id', the owner index at '/', anything else
    }

    // ---- API ----
    if (parts[1] === 'health') return sendJSON(res, 200, { ok: true, name: 'margin', version: 1, store: STORE_KIND });

    // /api/docs  (POST) — open create (agent-first). No credential required: the
    // server assigns an unguessable id and returns capability tokens. The agent
    // keeps `agent_token` to revise/read; the human opens `reviewer_url`. This is
    // what lets an agent provision itself with nothing pre-shared.
    if (parts[1] === 'docs' && parts.length === 2 && method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress || 'unknown';
      if (!(await store.rateLimit('create:' + ip, CREATE_RATE_MAX, CREATE_RATE_WINDOW_SEC))) {
        return sendJSON(res, 429, { error: 'rate limited', hint: `at most ${CREATE_RATE_MAX} new documents per ${Math.round(CREATE_RATE_WINDOW_SEC / 60)} min from one address` });
      }
      const body = await readBody(req);
      if (!body.html) return sendJSON(res, 400, { error: 'html is required' });
      if (typeof body.html !== 'string' || body.html.length > MAX_HTML_BYTES) {
        return sendJSON(res, 413, { error: 'html too large', hint: `max ${MAX_HTML_BYTES} bytes (~${Math.round(MAX_HTML_BYTES / 1024 / 1024)}MB)`, size: typeof body.html === 'string' ? body.html.length : 0 });
      }
      const author = { identity: 'agent', name: AGENT_NAME, session_id: String(req.headers['x-agent-session'] || 'anon') };
      const { docId: id, version } = await store.createDoc({ title: body.title, html: body.html, summary: body.summary, author, idHint: body.title });
      const agentToken = mintToken(id, 'agent', SIGNING_SECRET, 0); // agent capability: no expiry
      return sendJSON(res, 200, {
        doc_id: id,
        version,
        created: true,
        agent_token: agentToken,
        agent_url: `${PUBLIC_BASE_URL}/d/${encodeURIComponent(id)}?token=${encodeURIComponent(agentToken)}`,
        reviewer_url: reviewerUrl(id),
      });
    }

    // /api/queue  (GET) — the reviewer's triage list. PUBLIC (no 401 — the page
    // shows its own empty state): an all-scope credential gets the global view;
    // everyone else gets THEIR docs, scoped to the anonymous rid cookie. Being
    // public and a full-store scan, it's the one route worth rate-limiting by IP
    // even though nothing here needs a credential (same IP extraction as create).
    if (parts[1] === 'queue' && parts.length === 2 && method === 'GET') {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress || 'unknown';
      if (!(await store.rateLimit('queue:' + ip, QUEUE_RATE_MAX, QUEUE_RATE_WINDOW_SEC))) {
        return sendJSON(res, 429, { error: 'rate limited', hint: `at most ${QUEUE_RATE_MAX} queue refreshes per ${Math.round(QUEUE_RATE_WINDOW_SEC / 60)} min from one address` });
      }
      if (identify(req, u)?.scope === 'all') return sendJSON(res, 200, await store.reviewQueue());
      const rid = ridFrom(req);
      if (rid) return sendJSON(res, 200, await store.reviewQueue({ rid }));
      return sendJSON(res, 200, { generated_at: Date.now(), scope: 'mine', items: [] });
    }

    let auth = identify(req, u);
    // The margin_token cookie is single-slot — it holds only the LAST doc link
    // this browser opened, but the queue lists every doc it ever opened. For doc
    // routes, fall back to the anonymous rid: a browser bound to a doc (it opened
    // that doc's reviewer link before) may act as its reviewer again.
    const reqDocId = parts[1] === 'docs' && parts.length >= 3 ? parts[2] : null;
    if (reqDocId && (!auth || (auth.scope === 'doc' && auth.doc !== reqDocId && auth.role === 'reviewer'))) {
      const rid = ridFrom(req);
      if (rid && await store.isBoundReviewer(reqDocId, rid)) {
        auth = { role: 'reviewer', scope: 'doc', doc: reqDocId, author: { identity: 'human', name: REVIEWER_NAME, rid } };
      }
    }
    if (!auth) return sendJSON(res, 401, { error: 'unauthorized', hint: 'create a document with POST /api/docs, or pass a valid capability token' });

    // /api/docs
    if (parts[1] === 'docs' && parts.length === 2 && method === 'GET') {
      const all = await store.listDocs();
      // A doc-scoped token sees only its own document; owner/agent see everything.
      const visible = auth.scope === 'all' ? all : all.filter((d) => d.id === auth.doc);
      const docs = visible.map((d) => ({ ...d, url: reviewerUrl(d.id) }));
      return sendJSON(res, 200, { docs });
    }

    // /api/stats  (GET) — aggregate usage analytics. Owner-only: a global view
    // across every document, so it requires all-scope (the owner-master reviewer
    // token or the global agent key), not a per-document reviewer link.
    if (parts[1] === 'stats' && parts.length === 2 && method === 'GET') {
      if (auth.scope !== 'all') {
        return sendJSON(res, 403, { error: 'analytics is owner-only', hint: 'open /analytics with the owner reviewer token' });
      }
      return sendJSON(res, 200, await store.stats());
    }

    const docId = parts[2];
    // A doc-scoped token may only touch the one document it was issued for.
    if (docId && !canAccess(auth, docId)) {
      return sendJSON(res, 403, { error: 'this token is not valid for this document', hint: 'open the link for this specific document', doc_id: docId });
    }

    // /api/docs/:id/publish  (agent only)
    if (parts[1] === 'docs' && parts[3] === 'publish' && method === 'POST') {
      if (auth.role !== 'agent') {
        return sendJSON(res, 403, { error: 'an agent capability is required to publish', hint: 'use the agent_token from when this document was created (POST /api/docs), not a reviewer link', doc_id: docId });
      }
      if (!DOC_ID_RE.test(docId)) {
        return sendJSON(res, 400, { error: 'invalid doc_id', hint: 'must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase letters, digits, hyphens)', doc_id: docId });
      }
      const body = await readBody(req);
      if (!body.html) return sendJSON(res, 400, { error: 'html is required', doc_id: docId });
      if (typeof body.html !== 'string' || body.html.length > MAX_HTML_BYTES) {
        return sendJSON(res, 413, { error: 'html too large', hint: `max ${MAX_HTML_BYTES} bytes (~${Math.round(MAX_HTML_BYTES / 1024 / 1024)}MB)`, size: typeof body.html === 'string' ? body.html.length : 0, doc_id: docId });
      }
      const r = await store.publish(docId, { title: body.title, html: body.html, summary: body.summary, author: auth.author });
      const openComments = (await store.getComments(docId, { status: 'open' }))?.threads.length ?? 0;
      broadcast(docId, { type: 'published', version: r.version, at: Date.now() });
      return sendJSON(res, 200, { docId: r.docId, version: r.version, created: r.version === 1, url: reviewerUrl(docId), openComments });
    }

    // /api/docs/:id/link  (agent/owner: mint a fresh, optionally-expiring reviewer link)
    // A doc-scoped agent capability may mint links for its own doc (access was
    // already gated by canAccess above); a plain reviewer link may not.
    if (parts[1] === 'docs' && parts[3] === 'link' && method === 'POST') {
      if (auth.role !== 'agent' && auth.role !== 'owner') return sendJSON(res, 403, { error: 'only the owner or an agent can mint links', doc_id: docId });
      const body = await readBody(req);
      const days = parseFloat(body.expires_in_days);
      const ttlMs = Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : LINK_TTL_MS;
      const url = reviewerUrl(docId, ttlMs);
      return sendJSON(res, 200, { doc_id: docId, url, expires_at: ttlMs > 0 ? Date.now() + ttlMs : null });
    }

    // /api/docs/:id  (GET view)
    if (parts[1] === 'docs' && parts.length === 3 && method === 'GET') {
      const view = await store.getDocView(docId);
      if (!view) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
      // Retroactive bind: a reviewer reading through a doc-scoped link claims the
      // doc into their queue — covers links opened before the rid cookie existed.
      if (auth.scope === 'doc' && auth.role === 'reviewer' && auth.author.rid) {
        await store.bindReviewer(docId, auth.author.rid);
      }
      view.url = reviewerUrl(docId);
      return sendJSON(res, 200, view);
    }

    // /api/docs/:id/comments
    if (parts[1] === 'docs' && parts[3] === 'comments' && parts.length === 4) {
      if (method === 'GET') {
        const out = await store.getComments(docId, { status: u.searchParams.get('status') || undefined });
        if (!out) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
        return sendJSON(res, 200, out);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const c = await store.addComment(docId, { anchor: body.anchor, body: body.body, author: auth.author });
        if (!c) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
        broadcast(docId, { type: 'comment', commentId: c.id, at: Date.now() });
        return sendJSON(res, 200, c);
      }
    }

    // /api/docs/:id/comments/:cid/replies
    if (parts[1] === 'docs' && parts[3] === 'comments' && parts[5] === 'replies' && method === 'POST') {
      const body = await readBody(req);
      const r = await store.addReply(docId, parts[4], { body: body.body, author: auth.author });
      if (!r) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
      broadcast(docId, { type: 'reply', commentId: parts[4], at: Date.now() });
      return sendJSON(res, 200, r);
    }

    // /api/docs/:id/comments/:cid/delete  (author removes their own comment)
    if (parts[1] === 'docs' && parts[3] === 'comments' && parts[5] === 'delete' && method === 'POST') {
      const doc = await store.getDoc(docId);
      const existing = doc && (doc.comments || []).find((x) => x.id === parts[4]);
      if (!existing) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
      // You may remove a comment you authored; the owner master may remove any.
      const sameAuthor = (existing.author?.identity || '') === auth.author.identity;
      if (!sameAuthor && auth.role !== 'owner') {
        return sendJSON(res, 403, { error: 'you can only remove your own comments', doc_id: docId });
      }
      const removed = await store.deleteComment(docId, parts[4]);
      broadcast(docId, { type: 'delete', commentId: parts[4], at: Date.now() });
      return sendJSON(res, 200, { deleted: true, comment_id: parts[4], anchor: removed.anchor, body: removed.body });
    }

    // /api/docs/:id/comments/:cid/status
    if (parts[1] === 'docs' && parts[3] === 'comments' && parts[5] === 'status' && method === 'POST') {
      const body = await readBody(req);
      const status = body.status === 'resolved' ? 'resolved' : 'open';
      const c = await store.setStatus(docId, parts[4], status, auth.author);
      if (!c) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
      broadcast(docId, { type: 'status', commentId: parts[4], status, at: Date.now() });
      return sendJSON(res, 200, c);
    }

    // /api/docs/:id/reviewed  (owner/reviewer: mark the doc reviewed up to its
    // current version — the queue's "Done"). An agent must never clear its own
    // item from the reviewer's queue.
    if (parts[1] === 'docs' && parts[3] === 'reviewed' && method === 'POST') {
      if (auth.role !== 'owner' && auth.role !== 'reviewer') {
        return sendJSON(res, 403, { error: 'only a reviewer can mark a document reviewed', doc_id: docId });
      }
      const r = await store.markReviewed(docId, { rid: ridFrom(req) });
      if (!r) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
      return sendJSON(res, 200, r);
    }

    // /api/docs/:id/wait  (long-poll: block up to WAIT_MS for new comments — the
    // agent review-gate). Polls the store so it works on serverless, where the
    // publisher runs in a different invocation with no shared memory.
    if (parts[1] === 'docs' && parts[3] === 'wait' && method === 'GET') {
      const doc = await store.getDoc(docId);
      if (!doc) return sendJSON(res, 404, { error: 'not found', doc_id: docId });
      // Stamp the queue's "agent waiting now" signal — agents only. Any bound
      // reviewer can also hit /wait (e.g. a stray poll), and that must not fake
      // an "agent waiting" pulse for every reviewer sharing the doc.
      if (auth.role === 'agent') await store.noteAgentWait(docId);
      const sinceVersion = parseInt(u.searchParams.get('since_version') || '0', 10) || 0;
      const baseIds = new Set((doc.comments || []).map((c) => c.id));
      // New = an open thread that didn't exist when we started waiting, OR (catch-up)
      // an open thread on a version newer than the one the agent last acted on.
      const collect = async () => {
        const out = await store.getComments(docId, { status: 'open' });
        if (!out) return [];
        return out.threads.filter((t) => !baseIds.has(t.id) || (sinceVersion && t.version > sinceVersion));
      };
      const deadline = Date.now() + WAIT_MS;
      let aborted = false;
      req.on('close', () => { aborted = true; });
      // Poll until something new shows up or we hit the window.
      for (;;) {
        const fresh = await collect();
        if (fresh.length) {
          const cur = (await store.getDoc(docId))?.currentVersion ?? doc.currentVersion;
          return sendJSON(res, 200, { doc_id: docId, version: cur, timed_out: false, threads: fresh });
        }
        if (aborted) return;
        if (Date.now() + WAIT_POLL_MS >= deadline) break;
        await sleep(WAIT_POLL_MS);
      }
      const cur = (await store.getDoc(docId))?.currentVersion ?? doc.currentVersion;
      return sendJSON(res, 200, { doc_id: docId, version: cur, timed_out: true, threads: [] });
    }

    // /api/docs/:id/events  (SSE — best-effort live updates within one instance)
    if (parts[1] === 'docs' && parts[3] === 'events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...CORS,
      });
      res.write(': connected\n\n');
      subscribe(docId, res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25000);
      req.on('close', () => { clearInterval(ping); unsubscribe(docId, res); });
      return;
    }

    return sendJSON(res, 404, { error: 'no such route', path: u.pathname });
  } catch (e) {
    // Never leak a stack to the client; never crash the function.
    try { sendJSON(res, 500, { error: 'internal error' }); } catch { /* response already sent */ }
    console.error('[margin] handler error:', e && e.stack ? e.stack : e);
  }
}
