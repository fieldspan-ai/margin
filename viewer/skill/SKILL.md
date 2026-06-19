---
name: margin
description: >-
  Publish HTML for the user to review on their phone and get their comments back,
  using Margin — a hosted review tool at __BASE_URL__. Use this whenever the user
  asks you to make something they'd want to look at and give feedback on (a
  one-pager, report, summary, proposal, table, landing copy, slide outline, etc.),
  and especially when they say things like "let me review it", "in Margin", "send
  it to my phone", or "I want to comment on it" before it's final. No login, API
  key, or setup — the server hands you a per-document token the first time you
  publish.
---

# Margin — review on your phone

Margin lets you (the agent) publish a self-contained HTML document to a private
link. The user opens that link on their phone, selects any text, and leaves
comments anchored to exactly that text. You read the comments back, revise, and
re-publish to the same link. No login, no API key: the server hands you a
per-document capability token the first time you publish.

**Base URL:** `__BASE_URL__`

## The loop

1. Write a self-contained HTML document.
2. Publish it → get a `reviewer_url`. Hand it to the user.
3. The user comments on their phone.
4. When the user says they've commented (or just "check"), read the comments.
5. Revise, re-publish to the **same** doc, and mark handled comments resolved.
6. Repeat until the user is happy.

To start, ask the user what they'd like to create, then run the loop.

## 1 · Write the HTML

Write a **complete, self-contained** HTML document:

- **Inline CSS only.**
- **No external scripts, stylesheets, or fonts** — the review sandbox runs with
  scripts **off**, so anything JS-driven won't render. Make it static.
- **Images:** inline `data:` URIs or absolute `https:` URLs only.
- **Markdown content:** render it to clean, self-contained HTML first (headings,
  tables, lists, code blocks) so the user reviews the formatted page, not the raw
  markup.

Write it to a temp file (avoids shell-quoting pain): `/tmp/margin-doc.html`.

## 2 · Publish

Build the request with `jq` and `--rawfile` so the HTML never breaks quoting,
and save the credentials for later turns in one shot:

```bash
jq -n --rawfile html /tmp/margin-doc.html --arg title "SHORT TITLE" \
  '{title:$title, html:$html}' \
| curl -s -X POST __BASE_URL__/api/docs \
    -H "content-type: application/json" --data-binary @- \
| tee /tmp/margin-resp.json | jq '{doc_id, reviewer_url}'

# Save creds so you can revise on later turns (keep this file out of git):
jq '{doc_id, agent_token}' /tmp/margin-resp.json > ./.margin.json
```

The POST response is JSON: `{ "doc_id", "agent_token", "reviewer_url", ... }`.

Then give the user the **`reviewer_url`** as a clickable link and tell them:
open it (phone or browser), select any text, and leave a comment. Add
`.margin.json` to `.gitignore` — the `agent_token` controls the document, so keep
it private.

## 3 · Read the comments

When the user says they've commented (or "check"), read the open threads (load
`doc_id` and `agent_token` from `./.margin.json`):

```bash
curl -s "__BASE_URL__/api/docs/DOC_ID/comments?status=open" \
  -H "authorization: Bearer AGENT_TOKEN" | jq .
```

Each thread carries the user's `body` (what they want) plus the
`anchor.quote` / `anchor.block_text` it's attached to — so you know exactly
which part of the document they mean. Threads can also have `replies`.

## 4 · Revise and re-publish

Address the comments, rewrite `/tmp/margin-doc.html`, then re-publish to the
**same** doc. This keeps the comments anchored and the link unchanged:

```bash
jq -n --rawfile html /tmp/margin-doc.html --arg s "what changed in this round" \
  '{html:$html, summary:$s}' \
| curl -s -X POST __BASE_URL__/api/docs/DOC_ID/publish \
    -H "authorization: Bearer AGENT_TOKEN" \
    -H "content-type: application/json" --data-binary @- | jq .
```

Mark each comment you handled as resolved (one call per `comment_id`):

```bash
curl -s -X POST __BASE_URL__/api/docs/DOC_ID/comments/COMMENT_ID/status \
  -H "authorization: Bearer AGENT_TOKEN" \
  -H "content-type: application/json" -d '{"status":"resolved"}'
```

The user just refreshes the same link to see the new version, with their
addressed comments marked resolved.

## Decision widgets / playgrounds — ask the user to decide in full HTML

Sometimes you don't want a comment — you want the user to *decide* something. A
**decision widget** is a full interactive HTML "playground" the user explores,
then commits a choice that you read back. Think "AskUserQuestion, but as rich
HTML you design": configure options, drag a slider, pick from a live preview,
compare layouts side by side.

**When to use it:** the decision is richer than yes/no and the user benefits from
interactive exploration (tuning parameters, previewing variants, arranging
items). For a plain comment or a simple approval, stick with the review flow
above.

**Scripts run here.** Unlike the static review document (scripts **off**), the
decision widget runs **real JavaScript** in a hardened, sandboxed iframe (opaque
origin: no network, no cookies, no storage). Its only channel back is a tiny SDK
that's injected for you:

```js
Margin.submit(value, { label })  // user committed: value = any JSON, label = short human string
Margin.ready()                   // optional: signal the widget is interactive
Margin.resize()                  // optional: re-report height (auto on load + window resize)
```

**Author contract:** build any interactive HTML/JS you like, then call
`Margin.submit({...}, { label: "Compact layout" })` when the user clicks the
button that commits their choice. The viewer shows a "Decision sent" confirmation
and posts it to the server for you.

**Publish it** as a second payload alongside (or instead of focusing on) the
review HTML — any document can carry one:

```bash
jq -n --rawfile html /tmp/margin-doc.html --rawfile dec /tmp/margin-widget.html \
  --arg title "Pick a layout" \
  '{title:$title, html:$html, decision_html:$dec}' \
| curl -s -X POST __BASE_URL__/api/docs \
    -H "content-type: application/json" --data-binary @- | jq '{doc_id, reviewer_url}'
```

`decision_html` also works on revise (`POST /api/docs/DOC_ID/publish`).

**Read it back** — block until the user decides, or just fetch the latest:

```bash
# Block up to ~25s for a fresh decision (call again on timed_out:true):
curl -s "__BASE_URL__/api/docs/DOC_ID/decisions/wait" \
  -H "authorization: Bearer AGENT_TOKEN" | jq .

# Or read whatever has been decided so far:
curl -s "__BASE_URL__/api/docs/DOC_ID/decisions" \
  -H "authorization: Bearer AGENT_TOKEN" | jq '.decisions'
```

Each decision carries the `value` the widget submitted plus the optional `label`,
so you know exactly what the user chose and can act on it.

## Rules

- **Reuse the same `doc_id` for every revision** — never create a new document
  each round, or the link changes and the comments detach.
- On later turns, read `doc_id` / `agent_token` from `./.margin.json`.
- Keep `agent_token` private — it controls the document. Don't commit it.
- If a `curl` command needs the user's approval, ask once, then proceed.
- If you want a fresh link (e.g. one that expires), POST to
  `__BASE_URL__/api/docs/DOC_ID/link` with the same bearer and an optional
  `{"expires_in_days": 7}`.

## Quick reference

| Action | Request |
|--------|---------|
| Create | `POST /api/docs` · body `{title, html}` · no auth → returns `doc_id`, `agent_token`, `reviewer_url` |
| Revise | `POST /api/docs/DOC_ID/publish` · `Bearer AGENT_TOKEN` · body `{html, summary}` |
| Read comments | `GET /api/docs/DOC_ID/comments?status=open` · `Bearer AGENT_TOKEN` |
| Resolve | `POST /api/docs/DOC_ID/comments/COMMENT_ID/status` · `Bearer AGENT_TOKEN` · body `{"status":"resolved"}` |
| Fresh link | `POST /api/docs/DOC_ID/link` · `Bearer AGENT_TOKEN` · body `{"expires_in_days":7}` (optional) |
| Decision widget | add `decision_html` to the create/revise body — a full interactive HTML/JS playground that calls `Margin.submit(value,{label})` |
| Read decisions | `GET /api/docs/DOC_ID/decisions` · `Bearer AGENT_TOKEN` |
| Wait for decision | `GET /api/docs/DOC_ID/decisions/wait` · `Bearer AGENT_TOKEN` → blocks ~25s, `timed_out:true` if none |
