# Working in the Margin repo

Guidance for any agent (or human) making changes to this codebase. For product
usage, see `README.md`.

## What Margin is

Agent-native HTML review. An agent publishes generated HTML to a private link; a
human reviews and leaves anchored comments on their phone; the comments feed back
to the agent. Auth is **agent-first** — no pre-shared keys; the first publish
self-provisions a per-document capability token.

## Layout

| Path | Role |
|------|------|
| `server/app.js` | The single `handle(req, res)` request handler — routing, auth, CSP. Shared by local dev and serverless. |
| `server/server.js` | Local-dev entry: wraps `handle` in a long-running http server. |
| `api/index.js` | Vercel serverless entry: hands each request to the same `handle`. |
| `server/store.js` | Domain logic (publish, comments, anchoring resolution) over a pluggable backend. |
| `server/store/backend-json.js` | Default backend: atomic JSON files on disk (local dev). |
| `server/store/backend-kv.js` | Upstash/Vercel KV backend (serverless). |
| `server/store/memory-redis.js` | In-process Redis stand-in so `STORE=memory` runs the real KV path with no infra. |
| `server/blocks.js` | Server-side block anchoring — pure, dependency-free, the core technical risk. |
| `server/tokens.js` | HMAC-signed, document-scoped capability tokens. |
| `mcp/margin-mcp.js` | stdio MCP server — the agent-facing seam. |
| `viewer/` | Single-file mobile reviewer (`index.html`), landing page, downloadable skill. |
| `test/` | `node --test` suites. |

## Invariants — don't regress these

- **The server has zero runtime dependencies.** Only the MCP server (`mcp/`) may
  use packages. Keep `server/` dependency-free.
- **Rendered documents run with scripts OFF** — a sandboxed iframe (no
  `allow-scripts`) behind a nonce CSP. Never loosen this; untrusted HTML is the
  main attack surface.
- **Agent-first auth.** No key should be required to create a document. The
  signing secret self-provisions and persists to the store if `MARGIN_SECRET` is
  unset.
- **Wire fields are snake_case.**
- **All storage goes through the async backend seam** so a remote store drops in
  with no call-site changes. JSON writes are atomic (tmp + fsync + rename).
- **Anchoring must never silently move a comment to different content.** The
  solid / soft-edited / orphan model in `blocks.js` is load-bearing — see
  `test/blocks.test.js` before touching it.

## Dev

```bash
npm start            # local server (http://localhost:8787)
npm test             # all suites
npm run seed         # write a demo document
STORE=memory npm start   # exercise the real KV code path, no Upstash needed
```

The canonical hosted deploy is `https://margin.fieldspan.ai` (Vercel serverless +
Upstash KV). See `README.md` → *Self-hosting* to run your own.
