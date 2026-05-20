# grok-search-mcp

[简体中文](./README.zh.md) | English

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that
exposes Grok's live-web search and fact-checking as three tools: `grok_search`,
`grok_deep_search`, and `grok_fact_check`.

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
| `GROK_TIMEOUT_MS` | no | `120000` | Per-request **idle** timeout for fast tools (`grok_search`, `grok_fact_check`). Resets on every received SSE chunk. |
| `GROK_DEEP_TIMEOUT_MS` | no | `300000` | Per-request **idle** timeout for `grok_deep_search` |
| `GROK_STREAM` | no | `true` | Send `stream: true` to grok2api and parse the SSE chunks. Set to `false` to use a regular non-streaming POST as a debugging fallback. |
| `HTTPS_PROXY` / `HTTP_PROXY` | no | — | Optional outbound proxy |

> **Models are pinned in the server and not configurable via env.** A previous
> `GROK_MODEL` variable existed and is now intentionally ignored — set it and
> nothing happens. This keeps clients from accidentally pinning a stale model id.
>
> Tool → model routing:
>
> - `grok_search` → `grok-4.20-fast`
> - `grok_deep_search` → `grok-4.20-multi-agent`
> - `grok_fact_check` → `grok-4.20-fast`

## Run as an MCP server

This server speaks MCP over stdio. Register it in your MCP client's config.
Example for Claude Code (`~/.claude.json` or project `.mcp.json`); see also
[`mcp-config.example.json`](./mcp-config.example.json):

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "node",
      "args": ["/absolute/path/to/grok_search_mcp/src/server.js"],
      "env": {
        "GROK_API_KEY": "your-grok2api-app-key",
        "GROK_BASE_URL": "http://localhost:8000/v1",
        "GROK_TIMEOUT_MS": "120000",
        "GROK_DEEP_TIMEOUT_MS": "300000",
        "GROK_STREAM": "true"
      }
    }
  }
}
```

## Tools

### `grok_search` — everyday search
Web search with Grok (`grok-4.20-fast`). Returns an answer with source links.
Use this for everyday lookups.

| Field | Type | Description |
| :-- | :-- | :-- |
| `query` | string | Search query |
| `max_results` | int (1-25, optional, default 20) | Preferred number of source links |

### `grok_deep_search` — broad multi-source research
Deep, multi-agent web research with Grok (`grok-4.20-multi-agent`). Use this
for complex investigations, broad surveys, and cross-source verification.
**Slower than `grok_search`** — prioritizes breadth and accuracy over speed.
Prefer this when a single quick search wouldn't give a defensible answer.

| Field | Type | Description |
| :-- | :-- | :-- |
| `query` | string | Complex research query |
| `max_results` | int (1-25, optional) | Preferred number of source links |

### `grok_fact_check` — verdict + evidence
Fact-check a claim with Grok (`grok-4.20-fast`) and return verdict, evidence,
caveats, and sources.

| Field | Type | Description |
| :-- | :-- | :-- |
| `claim` | string | Claim to verify |
| `max_results` | int (1-25, optional, default 20) | Preferred number of source links |

Every tool's response ends with a footer line like `model: grok-4.20-fast` so you
can see which model actually answered.

## Test

```bash
# Make sure .env is loaded into your shell first, e.g. with `dotenvx run` or
# `set -a; . ./.env; set +a` on bash. Then:
npm test
```

The test client spawns the server as a subprocess, lists tools, and invokes
`grok_search`, `grok_deep_search`, and `grok_fact_check` end-to-end, asserting
that each response footer reports the correct pinned model.

## Credits

- [chenyme/grok2api](https://github.com/chenyme/grok2api) — the upstream
  OpenAI-compatible Grok gateway that powers this server.
- [Model Context Protocol](https://modelcontextprotocol.io/) and its
  [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

[MIT](./LICENSE)
