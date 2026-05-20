# grok-search-mcp

[简体中文](./README.zh.md) | English

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that
exposes Grok's live-web search and fact-checking as two tools: `grok_search`
and `grok_fact_check`.

It is a thin wrapper around an OpenAI-compatible Grok gateway. The recommended
backend is [chenyme/grok2api](https://github.com/chenyme/grok2api), which turns
Grok's web capabilities into `/v1/chat/completions`-style endpoints.

## Architecture

```
MCP client (Claude Code / others)
        │  stdio (MCP)
        ▼
grok-search-mcp  (this repo)
        │  HTTPS  /v1/chat/completions
        ▼
grok2api gateway (you self-host)
        │
        ▼
        Grok
```

## Prerequisites

1. **A running grok2api instance.** Follow the upstream README to deploy it
   locally, via Docker Compose, Vercel, or Render:
   <https://github.com/chenyme/grok2api>
2. The `app.api_key` value you configured in grok2api (used as
   `GROK_API_KEY` here).
3. Node.js 18+ (uses native `fetch`).

## Install

```bash
git clone https://github.com/CPbianma/grok_search_mcp.git
cd grok_search_mcp
npm install
```

## Configure

Copy the example and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| :-- | :-- | :-- | :-- |
| `GROK_API_KEY` | yes | — | `app.api_key` from your grok2api deployment |
| `GROK_BASE_URL` | no | `http://localhost:8000/v1` | OpenAI-compatible base URL of grok2api |
| `GROK_MODEL` | no | `grok-4.20-fast` | Any model id supported by your grok2api |
| `GROK_TIMEOUT_MS` | no | `90000` | Per-request timeout |
| `HTTPS_PROXY` / `HTTP_PROXY` | no | — | Optional outbound proxy |

## Run as an MCP server

This server speaks MCP over stdio. Register it in your MCP client's config.
Example for Claude Code (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "node",
      "args": ["/absolute/path/to/grok_search_mcp/src/server.js"],
      "env": {
        "GROK_API_KEY": "your-grok2api-app-key",
        "GROK_BASE_URL": "http://localhost:8000/v1",
        "GROK_MODEL": "grok-4.20-fast"
      }
    }
  }
}
```

## Tools

### `grok_search`
Search the web with Grok and return an answer with source links.

| Field | Type | Description |
| :-- | :-- | :-- |
| `query` | string | Search query |
| `max_results` | int (1-25, optional) | Preferred number of source links |

### `grok_fact_check`
Fact-check a claim and return verdict, evidence, caveats, and sources.

| Field | Type | Description |
| :-- | :-- | :-- |
| `claim` | string | Claim to verify |
| `max_results` | int (1-25, optional) | Preferred number of source links |

## Test

```bash
# Make sure .env is loaded into your shell first, e.g. with `dotenvx run` or
# `set -a; . ./.env; set +a` on bash. Then:
npm test
```

The test client spawns the server as a subprocess, lists tools, and invokes
both `grok_search` and `grok_fact_check` end-to-end.

## Credits

- [chenyme/grok2api](https://github.com/chenyme/grok2api) — the upstream
  OpenAI-compatible Grok gateway that powers this server.
- [Model Context Protocol](https://modelcontextprotocol.io/) and its
  [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

[MIT](./LICENSE)
