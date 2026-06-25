# margin-mcp

**Let your coding agent hand you the page to review on your phone.**

[Margin](https://margin.fieldspan.ai) is agent-native HTML review. Your agent
publishes a generated document (a report, one-pager, plan, table, landing
draft…) to a private link. You open it on your phone, **select any text, and
leave a comment anchored to exactly that text**. The agent reads the comments
back, revises, and re-publishes to the same link. No login, no API key — the
first publish self-provisions a per-document capability token the agent keeps.

This package is the MCP server: it exposes Margin's publish → review → revise
loop as Model Context Protocol tools, so any MCP-capable agent (Claude Code,
Cursor, Cline, Goose, …) can drive it.

## Install

Zero-config — it talks to the hosted Margin instance by default:

```bash
npx -y margin-mcp
```

### Claude Code

```bash
claude mcp add margin -- npx -y margin-mcp
```

### Cursor / Cline / Windsurf / any MCP client

Add to your MCP config (`mcpServers`):

```json
{
  "mcpServers": {
    "margin": {
      "command": "npx",
      "args": ["-y", "margin-mcp"]
    }
  }
}
```

Self-hosting Margin? Point the server at your instance:

```json
{
  "mcpServers": {
    "margin": {
      "command": "npx",
      "args": ["-y", "margin-mcp"],
      "env": { "MARGIN_BASE_URL": "https://margin.example.com" }
    }
  }
}
```

## The loop

1. The agent writes a self-contained HTML document and calls `margin_publish`.
2. It hands you the `reviewer_url`. You open it and comment on your phone.
3. The agent reads your comments (`margin_get_comments`), revises, and
   re-publishes to the **same** doc so the link is stable and comments stay
   anchored.
4. It marks handled comments resolved (`margin_resolve_comment`).

## Tools

| Tool | What it does |
|------|--------------|
| `margin_publish` | Publish HTML (first call creates the doc + caches its token; later calls revise the same doc). Returns the reviewer link. |
| `margin_get_comments` | Read the human's open comment threads (each anchored to the text it's about). |
| `margin_wait_for_comments` | Block until the human has left comments (or a timeout). |
| `margin_resolve_comment` | Mark a comment thread resolved after addressing it. |
| `margin_review_link` | Re-fetch the reviewer link for a document. |

## Configuration

All optional:

| Env var | Default | Purpose |
|---------|---------|---------|
| `MARGIN_BASE_URL` | `https://margin.fieldspan.ai` | Base URL of the Margin server (set for self-hosting). |
| `AGENT_API_KEY` | — | Legacy global agent key, if your instance uses one. |
| `MARGIN_TOKEN_FILE` | `~/.margin/tokens.json` | Where per-document capability tokens are cached. |

## Links

- Hosted instance: <https://margin.fieldspan.ai>
- Source & self-hosting: <https://github.com/fieldspan-ai/margin>

MIT © Fieldspan
