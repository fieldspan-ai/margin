// Margin — local development server.
//
// Wraps the shared request handler (server/app.js) in a long-running Node http
// server. On Vercel the same handler is invoked per-request by api/index.js, so
// this file is only the local-dev entry point (npm start / npm run dev).
//
// Run: node server/server.js   (or: npm start)
import http from 'node:http';
import { handle, config } from './app.js';

// Refuse to start with default keys on a publicly-reachable URL — a known token
// on a public tunnel is an open door to every document. (security floor)
if (config.usingDefaultKeys && !config.isLocalBase) {
  console.error('\n  ✗ Refusing to start: PUBLIC_BASE_URL is not localhost but AGENT_API_KEY / REVIEWER_TOKEN still use the default "change-me" values.');
  console.error('    Set strong, random AGENT_API_KEY and REVIEWER_TOKEN in .env before exposing Margin.\n');
  process.exit(1);
}

const server = http.createServer(handle);
server.listen(config.PORT, () => {
  console.log(`\n  Margin server running`);
  console.log(`  ├─ local:    http://localhost:${config.PORT}`);
  console.log(`  ├─ public:   ${config.PUBLIC_BASE_URL}`);
  const storeLine = config.STORE_KIND === 'kv' ? 'kv (Upstash/Vercel KV)'
    : config.STORE_KIND === 'memory' ? 'memory (in-process Redis — not persistent)'
    : `json (${config.DATA_DIR})`;
  console.log(`  ├─ store:    ${storeLine}`);
  console.log(`  └─ reviewer link form: ${config.PUBLIC_BASE_URL}/d/<docId>?token=<REVIEWER_TOKEN>\n`);
  if (config.usingDefaultKeys) {
    console.log('  ⚠  Using default dev keys — fine on localhost, but set AGENT_API_KEY and REVIEWER_TOKEN in .env before exposing this.\n');
  }
});
