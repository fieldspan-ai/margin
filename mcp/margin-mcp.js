#!/usr/bin/env node
// Margin MCP server — the agent-facing seam.
//
// Wraps the Margin HTTP API as MCP tools over stdio so a Claude agent can
// publish HTML for review and read the human's anchored comments back. This is
// the whole point of Margin: without it the loop only works via curl.
//
// Run:  npm run mcp     (or: node mcp/margin-mcp.js)
// Wire it into Claude Code as a stdio MCP server pointing at this file.
//
// Agent-first: no pre-shared key needed. The first margin_publish creates a
// document via POST /api/docs and the server hands back a per-document agent
// capability token, which this server persists locally and reuses on later turns.
//
// Env (from .env or the process environment) — all OPTIONAL:
//   MARGIN_BASE_URL / PUBLIC_BASE_URL  base URL of the Margin server (default: the hosted deploy)
//   AGENT_API_KEY                      legacy global agent key, if the host uses one
//   MARGIN_TOKEN_FILE                  where per-doc capability tokens are cached
//   MARGIN_SESSION                     optional stable agent session id

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDotenv } from '../server/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadDotenv(ROOT);

const DEFAULT_BASE = 'https://margin.fieldspan.ai';
const PORT = parseInt(process.env.PORT || '8787', 10);
const BASE_URL = (process.env.MARGIN_BASE_URL || process.env.PUBLIC_BASE_URL
  || (process.env.PORT ? `http://localhost:${PORT}` : DEFAULT_BASE)).replace(/\/$/, '');
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';
const SESSION = process.env.MARGIN_SESSION || `mcp-${crypto.randomBytes(4).toString('hex')}`;

// --- per-document capability token cache (the agent's "memory" of what it owns) ---
const TOKEN_FILE = process.env.MARGIN_TOKEN_FILE || path.join(os.homedir(), '.margin', 'tokens.json');
const tokenKey = (id) => `${BASE_URL}::${id}`;
function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return {}; } }
function saveToken(id, token) {
  const all = loadTokens();
  all[tokenKey(id)] = token;
  try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2)); } catch { /* best effort */ }
}
// The capability for a doc: its stored per-doc token, else the legacy global key.
function tokenFor(id) { return loadTokens()[tokenKey(id)] || AGENT_API_KEY || null; }

// --- HTTP bridge to the Margin server ---
async function api(p, { method = 'GET', body, token, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json', 'x-agent-session': SESSION };
  if (token) headers.authorization = 'Bearer ' + token;
  let resp;
  try {
    resp = await fetch(BASE_URL + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`cannot reach the Margin server at ${BASE_URL} (${e.message}). Is it running? Start it with: npm start`);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const detail = (data && data.error) || resp.statusText;
    const hint = data && data.hint ? ` (${data.hint})` : '';
    throw new Error(`Margin API ${method} ${p} → ${resp.status} ${detail}${hint}`);
  }
  return data;
}

function ok(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }; }
function fail(msg) { return { content: [{ type: 'text', text: 'Error: ' + msg }], isError: true }; }

// Re-shape the server's thread payload into the snake_case wire contract.
function shapeComments(docId, out, isWait) {
  const threads = (out.threads || []).map((t) => ({
    id: t.id,
    status: t.status,
    version: t.version,
    // 'document' = general feedback on the whole document (no block anchor);
    // 'block' = anchored to a specific span (see anchored_to).
    scope: t.scope || ((t.anchor && t.anchor.block_id) ? 'block' : 'document'),
    anchored_to: {
      quote: (t.anchor && t.anchor.quote) || null,
      block_text: (t.anchor && t.anchor.block_text) || null,
      block_type: (t.anchor && t.anchor.block_type) || null,
    },
    body: t.body,
    replies: (t.replies || []).map((r) => ({ author: r.author, body: r.body })),
  }));
  const shaped = { doc_id: docId, title: out.title, version: out.version, threads };
  if (isWait) shaped.timed_out = !!out.timed_out;
  return shaped;
}

const server = new McpServer({ name: 'margin', version: '0.1.0' });

server.registerTool('margin_publish', {
  title: 'Publish HTML for review',
  description:
    'Publish generated HTML for the human to review and get back a reviewer link to hand them. Omit doc_id the first time — the server creates the document and this tool remembers it. Pass the returned doc_id on later turns to post revisions to the same document (comments are carried forward). No API key or human setup is required.',
  inputSchema: {
    html: z.string().describe('The full HTML document or fragment to render for review.'),
    doc_id: z.string().optional().describe('Omit to create a new document. Pass a doc_id returned by a previous margin_publish to revise that document.'),
    title: z.string().optional().describe('Human-readable title shown in the viewer; also seeds the readable part of a new document id.'),
    summary: z.string().optional().describe('Short note describing what changed in this version.'),
  },
}, async ({ html, doc_id, title, summary }) => {
  try {
    if (!html || !html.trim()) return fail('html is required and cannot be empty');
    const id = doc_id ? doc_id.trim() : null;

    // Revise an existing document we hold a capability for (or via a global key).
    if (id) {
      const token = tokenFor(id);
      if (!token) return fail(`no saved credential for "${id}". Omit doc_id to create a new document, or set AGENT_API_KEY if the host uses a global key.`);
      const r = await api(`/api/docs/${encodeURIComponent(id)}/publish`, { method: 'POST', token, body: { html, title, summary } });
      return ok({ doc_id: id, version: r.version, created: !!r.created, url: r.url, open_comments: r.openComments ?? 0 });
    }

    // First publish — create the document with no credential; keep the capability.
    const r = await api('/api/docs', { method: 'POST', body: { html, title, summary } });
    if (r.agent_token) saveToken(r.doc_id, r.agent_token);
    return ok({ doc_id: r.doc_id, version: r.version, created: true, url: r.reviewer_url, open_comments: 0 });
  } catch (e) { return fail(e.message); }
});

server.registerTool('margin_get_comments', {
  title: 'Read reviewer comments',
  description:
    "Fetch the human reviewer's comments for a document so the agent can act on them. Each thread includes the quoted span and block it anchors to (scope: 'block'), or is general feedback on the document as a whole with no anchor (scope: 'document').",
  inputSchema: {
    doc_id: z.string().describe('The document slug.'),
    status: z.enum(['open', 'resolved', 'all']).optional().describe('Filter by status. Default: open.'),
  },
}, async ({ doc_id, status }) => {
  try {
    const token = tokenFor(doc_id);
    if (!token) return fail(`no saved credential for "${doc_id}". Publish it first with margin_publish.`);
    let st = 'open';
    if (status === 'all') st = '';
    else if (status === 'resolved') st = 'resolved';
    const qs = st ? `?status=${st}` : '';
    const out = await api(`/api/docs/${encodeURIComponent(doc_id)}/comments${qs}`, { token });
    return ok(shapeComments(doc_id, out, false));
  } catch (e) { return fail(e.message); }
});

server.registerTool('margin_resolve_comment', {
  title: 'Resolve a comment',
  description: 'Mark a reviewer comment as resolved so the human sees the agent has addressed it.',
  inputSchema: {
    doc_id: z.string().describe('The document slug.'),
    comment_id: z.string().describe('The comment id to resolve (from margin_get_comments).'),
  },
}, async ({ doc_id, comment_id }) => {
  try {
    const token = tokenFor(doc_id);
    if (!token) return fail(`no saved credential for "${doc_id}". Publish it first with margin_publish.`);
    await api(`/api/docs/${encodeURIComponent(doc_id)}/comments/${encodeURIComponent(comment_id)}/status`, { method: 'POST', token, body: { status: 'resolved' } });
    return ok({ doc_id, comment_id, status: 'resolved' });
  } catch (e) { return fail(e.message); }
});

server.registerTool('margin_wait_for_comments', {
  title: 'Wait for new comments',
  description:
    'Long-poll (blocks up to ~25s) until the reviewer leaves a new comment, then returns the new threads. Use this to pause for feedback instead of busy-polling. If nothing arrives it returns timed_out:true — call again to keep waiting.',
  inputSchema: {
    doc_id: z.string().describe('The document slug.'),
    since_version: z.number().int().optional().describe('Return immediately if open comments already exist on a version newer than this. Pass the version you last acted on.'),
  },
}, async ({ doc_id, since_version }) => {
  try {
    const token = tokenFor(doc_id);
    if (!token) return fail(`no saved credential for "${doc_id}". Publish it first with margin_publish.`);
    const qs = since_version ? `?since_version=${since_version}` : '';
    const out = await api(`/api/docs/${encodeURIComponent(doc_id)}/wait${qs}`, { token, timeoutMs: 30000 });
    return ok(shapeComments(doc_id, out, true));
  } catch (e) { return fail(e.message); }
});

server.registerTool('margin_review_link', {
  title: 'Mint a reviewer link',
  description:
    'Mint a fresh reviewer link for a document. The link carries a signed, document-scoped token — it only opens this one document, so it is safe to share, and it can be set to expire. Use when you want a new or time-limited link rather than the one returned by margin_publish.',
  inputSchema: {
    doc_id: z.string().describe('The document slug.'),
    expires_in_days: z.number().optional().describe('Optional: link stops working after this many days. Omit for no expiry.'),
  },
}, async ({ doc_id, expires_in_days }) => {
  try {
    const token = tokenFor(doc_id);
    if (!token) return fail(`no saved credential for "${doc_id}". Publish it first with margin_publish.`);
    const body = {};
    if (typeof expires_in_days === 'number') body.expires_in_days = expires_in_days;
    const r = await api(`/api/docs/${encodeURIComponent(doc_id)}/link`, { method: 'POST', token, body });
    return ok({ doc_id, url: r.url, expires_at: r.expires_at });
  } catch (e) { return fail(e.message); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel; logs must go to stderr.
console.error(`[margin-mcp] connected · base=${BASE_URL} · session=${SESSION}`);
