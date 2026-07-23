// Signed, scoped access tokens — the dynamic-token model (Commento/SSO-style).
//
// Instead of one global reviewer token that opens every document, access rides
// in an HMAC-signed token that names exactly what it grants:
//   payload = { d: <docId>, r: 'reviewer'|'agent', iat, exp? }
//   token   = base64url(payload) + '.' + base64url(HMAC-SHA256(payload, secret))
//
// The server holds the secret and verifies the signature + scope on every
// request, so a leaked link only exposes its one document and (optionally)
// expires. Stateless by construction, which also makes it serverless-ready.
import crypto from 'node:crypto';

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function hmac(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

export function sign(payload, secret) {
  const body = b64urlJson(payload);
  return body + '.' + hmac(body, secret);
}

// Signature + expiry check only — shape checks live in verify/verifySession so
// a doc token and a session token can never stand in for each other.
function verifyRaw(token, secret, now) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = hmac(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (payload.exp && now > payload.exp) return null;
  return payload;
}

// Returns the payload if the signature is valid and the token isn't expired, else null.
// Rejects session tokens (rid, no d) — a browser identity is never a doc capability.
export function verify(token, secret, now = Date.now()) {
  const payload = verifyRaw(token, secret, now);
  if (!payload || (payload.rid && !payload.d)) return null;
  return payload;
}

// Mint a document-scoped token. ttlMs <= 0 (or omitted) means no expiry.
export function mintToken(docId, role, secret, ttlMs, now = Date.now()) {
  const payload = { d: docId, r: role === 'agent' ? 'agent' : 'reviewer', iat: now };
  if (ttlMs && ttlMs > 0) payload.exp = now + ttlMs;
  return sign(payload, secret);
}

// --- anonymous reviewer sessions ---
// The margin_rid cookie: a signed { rid } with no doc scope and no expiry — the
// browser's "who you are" for the per-person review queue. Grants nothing by
// itself; it only lets the server group activity under one anonymous identity.
export function mintSession(secret, now = Date.now()) {
  return sign({ rid: crypto.randomBytes(10).toString('hex'), iat: now }, secret);
}

// Returns { rid } for a valid session token, else null. Rejects doc tokens (d)
// — a leaked reviewer link must never impersonate a browser identity.
export function verifySession(token, secret, now = Date.now()) {
  const payload = verifyRaw(token, secret, now);
  if (!payload || !payload.rid || payload.d) return null;
  return { rid: String(payload.rid) };
}
