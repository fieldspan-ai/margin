// Mint a signed, document-scoped access token (and its link) from the CLI.
//
//   node scripts/mint-token.js <doc-id> [--role reviewer|agent] [--days N]
//   npm run mint -- report --days 7
//
// The token only grants the named document, and optionally expires — hand it to
// a reviewer (or a scoped sub-agent) without exposing your other documents.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from '../server/config.js';
import { mintToken } from '../server/tokens.js';
import * as store from '../server/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv(ROOT);

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const docId = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--role' && args[args.indexOf(a) - 1] !== '--days');
const role = flag('--role', 'reviewer') === 'agent' ? 'agent' : 'reviewer';
const days = parseFloat(flag('--days', '0')) || 0;

if (!docId) {
  console.error('Usage: node scripts/mint-token.js <doc-id> [--role reviewer|agent] [--days N]');
  process.exit(1);
}

// Resolve the same signing secret the server uses: env MARGIN_SECRET, else the
// one the store provisioned on first use.
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || './data');
if (process.env.STORE === 'kv' || process.env.STORE === 'memory') await store.init(null);
else await store.init(DATA_DIR);
const SECRET = process.env.MARGIN_SECRET || await store.getSigningSecret();
const BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '');
const ttlMs = days > 0 ? days * 24 * 60 * 60 * 1000 : 0;

const token = mintToken(docId, role, SECRET, ttlMs);
console.log(`role:    ${role} (scoped to "${docId}")`);
console.log(`expires: ${ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : 'never'}`);
console.log(`token:   ${token}`);
console.log(`link:    ${BASE}/d/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`);
