# Margin

A single-user tool for reviewing agent-generated HTML on your phone. A Claude
agent publishes generated HTML to a shareable link; you open it on your phone,
select text, and leave anchored comments; the comments feed straight back to the
agent through an MCP server. Close the loop without copy-pasting screenshots.

```
   Claude agent ──(margin_publish)──▶  Margin server  ──▶  https link
        ▲                                                       │
        │                                                  you, on your phone:
   margin_get_comments / wait  ◀── anchored comments ◀──  select text → comment
```

> **Agent-first auth:** no pre-shared keys and no human sign-in. The agent's
> first `margin_publish` creates the document with *no credential*; the server
> assigns an unguessable id and hands back a per-document **capability token**
> (the agent keeps it) plus a **reviewer link** (you open it — the token rides in
> the URL into an httpOnly cookie). Each token only ever opens its one document.
> Setting `AGENT_API_KEY` / `REVIEWER_TOKEN` is optional and adds a global agent
> key / an owner-master that can see every document + the index.

## Use the hosted instance (no setup)

The hosted deploy (`https://margin.fieldspan.ai`) serves a **landing page** at
`/` with a stupid-simple onboarding flow, and a **downloadable Claude Code
skill** that teaches an agent the publish → review → revise loop over plain HTTP
(no MCP, no repo clone, no keys). Install it with one command:

```bash
mkdir -p ~/.claude/skills/margin \
  && curl -fsSL https://margin.fieldspan.ai/skill.md -o ~/.claude/skills/margin/SKILL.md
```

Then open a new Claude Code session and ask it to make something you'd like to
review. The page also has a **live demo** button and a no-install "paste this
prompt" fallback. Routes:

| Route | Serves |
|-------|--------|
| `/` | landing + onboarding (owners with `REVIEWER_TOKEN` still get the docs index here) |
| `/analytics` | owner usage dashboard — docs, comments, agent sessions, 14-day activity (see `MARGIN_OWNER_PASSWORD`) |
| `/queue` | your review queue — every document where an agent is waiting on you (public, scoped to your browser; `?all=1` + owner password for the global view) |
| `/skill.md` | the raw skill (`SKILL.md`), `__BASE_URL__` substituted to this host |
| `/install.sh` | one-line installer for `curl -fsSL …/install.sh \| sh` |

The skill is the [share prompt](viewer/skill/SKILL.md) made permanent. For the
MCP-server path instead, see *Publish from an agent → Option A* below.

## 60-second quickstart

```bash
git clone https://github.com/fieldspan-ai/margin.git && cd margin
npm install

cp .env.example .env
# set strong keys (the server refuses to start with the defaults on a public URL):
#   AGENT_API_KEY=$(openssl rand -hex 24)
#   REVIEWER_TOKEN=$(openssl rand -hex 24)

npm run seed     # creates a demo document
npm start        # → prints a reviewer link
```

Open the printed `http://localhost:8787/d/demo?token=…` link. You'll see the
rendered document with a comment rail. Select text and leave a comment, or use
the rail's "+ Comment" button for feedback on the document as a whole.

## Publish from an agent

### Option A — the MCP server (recommended)

`mcp/margin-mcp.js` exposes five tools over stdio. No key needed — wire it in and
publish:

```bash
# Defaults to the hosted deploy (https://margin.fieldspan.ai). Nothing else to set.
claude mcp add margin -- node "$(pwd)/mcp/margin-mcp.js"
```

To point it at your own server (e.g. local dev), set the base URL:

```bash
claude mcp add margin \
  -e MARGIN_BASE_URL=http://localhost:8787 \
  -- node /absolute/path/to/mcp/margin-mcp.js
```

The first `margin_publish` (omit `doc_id`) creates the document and the MCP caches
the returned agent capability token (`~/.margin/tokens.json`); pass the returned
`doc_id` on later turns to revise it and read comments back.

Tools:

| Tool | Purpose |
|------|---------|
| `margin_publish(html, doc_id?, title?, summary?)` | First call (no `doc_id`) creates the doc and returns a reviewer `url`; pass `doc_id` to revise. |
| `margin_get_comments(doc_id, status?)` | Read comments (`open` \| `resolved` \| `all`) — each thread's `scope` is `block` (anchored) or `document` (general feedback). |
| `margin_resolve_comment(doc_id, comment_id)` | Mark a comment resolved. |
| `margin_wait_for_comments(doc_id, since_version?)` | Block up to ~25s for new comments — a review gate instead of busy-polling. |
| `margin_review_link(doc_id, expires_in_days?)` | Mint a fresh (optionally expiring) reviewer link. |

### Option B — raw HTTP

```bash
# Create — no credential. The server assigns the id and returns capability tokens.
curl -s -X POST http://localhost:8787/api/docs \
  -H "content-type: application/json" \
  -d '{"title":"Report","html":"<h1>Report</h1><p>First draft.</p>"}'
# → {"doc_id":"report-1a2b…","version":1,"agent_token":"…","agent_url":"…","reviewer_url":"…/d/report-1a2b…?token=…"}
```

Open the `reviewer_url`. Revise with the `agent_token`
(`POST /api/docs/<doc_id>/publish`, `Authorization: Bearer <agent_token>`) and read
comments with `GET /api/docs/<doc_id>/comments?status=open` (same bearer).

## Review from your phone

The server is `localhost` by default. To reach it from a phone, expose it:

```bash
npm run tunnel        # cloudflared/ngrok → prints a public https URL
```

Put that URL in `.env` as `PUBLIC_BASE_URL=https://…` and restart (`npm start`)
so the links the agent hands out are reachable. Open the magic link on your
phone — the reviewer token is moved into an httpOnly cookie and stripped from
the URL on first load.

### The review queue

`/queue` is the reviewer's triage list: every document sorted by whose turn it
is. Each item is in one of four states — `awaiting_review` (a version you
haven't seen), `needs_reply` (an agent replied on an open thread),
`waiting_on_agent` (the ball is with the agent), or `clear`. Commenting,
replying, or resolving a thread implicitly marks the document reviewed up to its
current version; the queue's **Done** button does the same explicitly.

The queue is **per-person**: it follows your browser via an anonymous httpOnly
identity — no login. Opening a review link once adds that doc to your queue on
that device from then on. The owner still gets the global view across every
document (owner credentials, or `/queue?all=1` with the owner password). Opening a review link once is enough — docs in your queue stay clickable from that browser even after you open other links. This binding is permanent per browser: link expiry (`MARGIN_LINK_TTL_DAYS`, or a link's `expires_in_days`) only limits how long the *URL* itself can be opened by someone new — it doesn't revoke a browser that already opened the link once.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/queue` | Your queue items + states (owner credentials get the global `scope: 'all'` view). |
| `POST /api/docs/:id/reviewed` | Mark a document reviewed up to its current version (reviewer/owner — never an agent). |

## Access tokens (dynamic, per-document, self-provisioning)

Access rides in an **HMAC-signed, document-scoped** capability token (`{doc, role,
exp}`) — modeled on Commento-style SSO. The server signs them with a secret it
**provisions itself**: if `MARGIN_SECRET` is unset, it generates one on first use
and persists it to the store, so an instance needs zero configured secrets.

- **Agent capability** — returned by `POST /api/docs` (open create). The agent
  keeps it to revise the doc and read comments. Scoped to that one document.
- **Reviewer link** — handed to the human; the token rides in the URL into an
  httpOnly cookie. A leaked link only exposes its one document; the server rejects
  it on any other (`403`). Set `MARGIN_LINK_TTL_DAYS` to make links expire.
- **`REVIEWER_TOKEN`** (optional) — an **owner master**: full read + the docs
  index, for bootstrapping your own devices. **`AGENT_API_KEY`** (optional) — a
  global agent key that can publish to any id.
- **`MARGIN_OWNER_PASSWORD`** (optional) — gates the usage dashboard at
  `/analytics` behind the browser's native **HTTP Basic Auth** login
  (username `owner`, override with `MARGIN_OWNER_USER`). A valid login is an owner
  master, same scope as `REVIEWER_TOKEN`. Unset = the dashboard falls back to the
  in-page token gate. Only the analytics routes are challenged; public review links
  stay open.
- Open create is rate-limited per IP (`MARGIN_CREATE_MAX` per `MARGIN_CREATE_WINDOW`
  seconds) on KV-backed deploys; ids are unguessable so nothing is enumerable.

Mint a scoped link yourself, or let the agent call `margin_review_link`:

```bash
npm run mint -- <doc-id> --days 7          # a 7-day reviewer link
npm run mint -- <doc-id> --role agent       # a doc-scoped agent capability
```

## Self-hosting

Margin is MIT-licensed and runs anywhere Node ≥18 does. There are two supported
shapes; pick by where you want it to live.

### Option 1 — a long-running Node host (VPS, container, home server)

The simplest self-host: one always-on process with the default JSON-file store.

```bash
git clone https://github.com/fieldspan-ai/margin.git && cd margin
npm install

cp .env.example .env
# edit .env:
#   PUBLIC_BASE_URL=https://margin.example.com   # your public URL (used in reviewer links)
#   DATA_DIR=/var/lib/margin                      # a PERSISTENT path you back up
#   MARGIN_SECRET=$(openssl rand -hex 32)         # keeps reviewer links valid across restarts
# AGENT_API_KEY / REVIEWER_TOKEN stay optional (agent-first); set them only for a
# global agent key or an owner-master index view.

npm start    # listens on PORT (default 8787)
```

Then put it behind TLS:

- Terminate HTTPS with a reverse proxy (Caddy, nginx, Traefik) and forward to
  `localhost:8787`. `PUBLIC_BASE_URL` **must** be the public `https://` URL so
  the links the agent hands out are reachable from a phone, and so the reviewer
  cookie is set `Secure`.
- Keep the process up with systemd / pm2 / a container restart policy.
- **Persistence:** the JSON backend writes docs + per-version HTML under
  `DATA_DIR`. Put it on a durable volume and back it up — that directory *is* your
  data. Set `MARGIN_SECRET` so signed links survive a restart (otherwise a fresh
  random secret invalidates every outstanding link).

No public host yet? For ad-hoc phone review you can skip the proxy and expose a
local server with a tunnel (`npm run tunnel` → cloudflared/ngrok), then set
`PUBLIC_BASE_URL` to the printed URL — see *Review from your phone* above.

### Option 2 — Vercel serverless + KV

Serverless can't use a local filesystem (it's read-only and not shared between
invocations), so this path stores everything in Redis via `STORE=kv`. Good if you
want zero servers to babysit. Steps are below.

## Deploy to Vercel (serverless + KV)

Margin runs as a single Vercel serverless function backed by KV. The repo is
wired so a push to `main` deploys to your project (e.g.
`https://margin.fieldspan.ai`).

1. **Provision KV.** In the Vercel dashboard → *Storage* → add **Upstash for
   Redis** (Marketplace) and connect it to the project. Vercel injects
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. (Or via CLI:
   `vercel integration add upstash/upstash-kv`.)
2. **Set environment variables** (Project → Settings → Environment Variables):

   | Variable | Value | Required? |
   |----------|-------|-----------|
   | `STORE` | `kv` | **yes** — the function FS is read-only |
   | `PUBLIC_BASE_URL` | `https://margin.fieldspan.ai` | recommended (stable links) |
   | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | injected by the KV integration | yes (auto) |
   | `MARGIN_SECRET` | `openssl rand -hex 32` | optional — self-provisioned into KV if unset |
   | `AGENT_API_KEY` / `REVIEWER_TOKEN` | `openssl rand -hex 24` | optional — global agent key / owner master |
   | `MARGIN_OWNER_PASSWORD` | `openssl rand -hex 16` | optional — Basic-Auth login for the `/analytics` dashboard |
   | `MARGIN_QUEUE_MAX` / `MARGIN_QUEUE_WINDOW` | `120` / `300` (defaults) | optional — per-IP rate limit (requests / seconds) for the public `GET /api/queue` |

   With agent-first auth, **no keys are required** — the agent self-provisions per
   document. Set `MARGIN_SECRET` if you want signing to survive a KV reset; set the
   two keys only if you want a global agent key or an owner-master index view.
3. **Deploy.** Merge to `main` (or `vercel --prod`). Point an agent at it with
   `MARGIN_BASE_URL=https://margin.fieldspan.ai` for the MCP — that's the default,
   so usually nothing to set.

How it maps to serverless (see [`vercel.json`](vercel.json)):

- `vercel.json` rewrites every request to `api/index.js`, which hands the request
  to the shared handler in [`server/app.js`](server/app.js) — the same code the
  local server runs.
- `STORE=kv` keeps documents/comments in Redis (the function filesystem is
  read-only and not shared between invocations).
- `margin_wait_for_comments` **polls KV** instead of relying on in-process
  notification (there's no shared memory between the publishing request and the
  waiting one). The poll window is `MARGIN_WAIT_MS` (default 25s) and the
  function's `maxDuration` is 60s.
- The viewer falls back to **polling** for live updates, since server-sent events
  can't be broadcast across serverless invocations.

## How anchoring works

Block ids are assigned **server-side** and carried across re-publishes by
matching each new version's blocks to the previous version's (exact text →
fuzzy → fresh id). A comment stays on its block when text is unchanged, shows a
**"moved/edited"** badge when the block was edited, and falls back to a visible
**orphan** when its block is gone — it never silently jumps to different
content. See `server/blocks.js` and `test/blocks.test.js`.

## Layout

```
server/   request handler (app.js), local dev server (server.js), storage (store.js + store/), anchoring (blocks.js)
api/       Vercel serverless entry (index.js → server/app.js)
viewer/   single-file mobile reviewer (index.html)
mcp/      stdio MCP server — the agent-facing seam (margin-mcp.js)
test/     node --test suites (blocks, store, kv, api, tokens)
vercel.json  serverless routing + function config
```

## Tests

```bash
npm test
```

## Notes & limits

- Rendered HTML runs with scripts **off** (`sandbox="allow-same-origin"`), so
  interactive/JS-driven HTML won't execute — it's for reviewing static output.
- Storage is pluggable behind an async seam (`server/store/`): JSON files
  (default, atomic writes + out-of-row HTML) for local dev, or `STORE=kv` for
  Vercel KV / Upstash Redis on the serverless deploy. Full render-host origin
  isolation is deferred.
- Capability tokens are document-scoped by default; the optional `REVIEWER_TOKEN`
  owner-master grants access to **all** documents (use it only on your own devices).

## License

MIT
