# grok-search-mcp

简体中文 | [English](./README.md)

一个 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 服务器，
把 Grok 的联网搜索和事实核查能力封装成两个工具：`grok_search` 与
`grok_fact_check`。

本项目是 OpenAI 兼容的 Grok 网关之上的薄封装层，推荐配合
[chenyme/grok2api](https://github.com/chenyme/grok2api) 使用 —— 后者会把
Grok 的网页能力转成 `/v1/chat/completions` 风格的接口。

## 架构

```
MCP 客户端 (Claude Code 等)
        │  stdio (MCP)
        ▼
grok-search-mcp  (本项目)
        │  HTTPS  /v1/chat/completions
        ▼
grok2api 网关 (你自部署)
        │
        ▼
        Grok
```

## 前置条件

1. **一个运行中的 grok2api 实例**。可以按上游 README 选择本地、Docker
   Compose、Vercel 或 Render 部署：
   <https://github.com/chenyme/grok2api>
2. grok2api 中配置的 `app.api_key`（对应本项目的 `GROK_API_KEY`）。
3. Node.js 18+（使用原生 `fetch`）。

## 安装

```bash
git clone https://github.com/CPbianma/grok_search_mcp.git
cd grok_search_mcp
npm install
```

## 配置

复制示例文件并填入实际值：

```bash
cp .env.example .env
```

| 变量 | 必填 | 默认值 | 说明 |
| :-- | :-- | :-- | :-- |
| `GROK_API_KEY` | 是 | — | grok2api 中的 `app.api_key` |
| `GROK_BASE_URL` | 否 | `http://localhost:8000/v1` | grok2api 的 OpenAI 兼容 Base URL |
| `GROK_MODEL` | 否 | `grok-4.20-fast` | grok2api 支持的任意模型 id |
| `GROK_TIMEOUT_MS` | 否 | `90000` | 单次请求超时（毫秒） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 否 | — | 可选出站代理 |

## 作为 MCP 服务器使用

服务以 stdio 方式提供 MCP。把它注册到你的 MCP 客户端配置中即可。以
Claude Code 为例（`~/.claude.json` 或项目级 `.mcp.json`）：

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "node",
      "args": ["/绝对路径/grok_search_mcp/src/server.js"],
      "env": {
        "GROK_API_KEY": "你在 grok2api 设置的 app.api_key",
        "GROK_BASE_URL": "http://localhost:8000/v1",
        "GROK_MODEL": "grok-4.20-fast"
      }
    }
  }
}
```

## 工具说明

### `grok_search`
用 Grok 搜索网页，返回包含来源链接的回答。

| 字段 | 类型 | 说明 |
| :-- | :-- | :-- |
| `query` | string | 搜索查询 |
| `max_results` | int (1-25, 可选) | 期望返回的来源数量 |

### `grok_fact_check`
对一个声明进行事实核查，返回结论、证据、注意事项和来源。

| 字段 | 类型 | 说明 |
| :-- | :-- | :-- |
| `claim` | string | 待核查的声明 |
| `max_results` | int (1-25, 可选) | 期望返回的来源数量 |

## 测试

```bash
# 先把 .env 加载进 shell（例如 PowerShell:
#   Get-Content .env | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2] } }
# bash:
#   set -a; . ./.env; set +a
# ）然后运行：
npm test
```

测试客户端会以子进程方式启动服务，列出工具，并依次调用
`grok_search` 与 `grok_fact_check` 做端到端验证。

## 致谢

- [chenyme/grok2api](https://github.com/chenyme/grok2api) —— 提供 OpenAI
  兼容 Grok 网关的上游项目。
- [Model Context Protocol](https://modelcontextprotocol.io/) 与
  [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

## 许可证

[MIT](./LICENSE)
