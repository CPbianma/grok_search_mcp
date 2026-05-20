import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Fixed model routing — do NOT read GROK_MODEL from env to avoid stale model ids.
const FAST_SEARCH_MODEL = "grok-4.3";
const DEEP_SEARCH_MODEL = "grok-4.20-multi-agent";
const DEFAULT_TIMEOUT_MS = 120000;
const DEEP_TIMEOUT_MS = 300000;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === "" ) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

const config = {
  baseUrl: process.env.GROK_BASE_URL ?? "http://localhost:8000/v1",
  apiKey: process.env.GROK_API_KEY,
  timeoutMs: Number.parseInt(process.env.GROK_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10),
  deepTimeoutMs: Number.parseInt(process.env.GROK_DEEP_TIMEOUT_MS ?? String(DEEP_TIMEOUT_MS), 10),
  useStreaming: parseBoolean(process.env.GROK_STREAM, true)
};

const server = new McpServer({
  name: "grok-search",
  version: "1.2.0"
});

const searchSchema = {
  query: z.string().min(1).describe("Search query to answer with current web evidence."),
  max_results: z.number().int().min(1).max(25).optional().describe("Preferred number of source links to include.")
};

const deepSearchSchema = {
  query: z.string().min(1).describe("Complex research query that benefits from broad, multi-source investigation."),
  max_results: z.number().int().min(1).max(25).optional().describe("Preferred number of source links to include.")
};

const factCheckSchema = {
  claim: z.string().min(1).describe("Claim to verify against current public evidence."),
  max_results: z.number().int().min(1).max(25).optional().describe("Preferred number of source links to include.")
};

server.registerTool(
  "grok_search",
  {
    title: "Grok Search",
    description: "Fast web search with Grok. Returns a concise answer with source links. Optimized for speed and stability — use this for most everyday lookups.",
    inputSchema: searchSchema
  },
  async ({ query, max_results = 15 }) => {
    const text = await askGrok({
      task: "search",
      userText: query,
      maxResults: max_results,
      model: FAST_SEARCH_MODEL,
      timeoutMs: config.timeoutMs
    });

    return textContent(text);
  }
);

server.registerTool(
  "grok_deep_search",
  {
    title: "Grok Deep Search",
    description: [
      "Deep, multi-agent web research with Grok. Use this for complex investigations,",
      "broad surveys, and cross-source verification across many references.",
      "Slower than `grok_search` — prioritizes breadth and accuracy over speed.",
      "Prefer this when a single quick search would not give a defensible, well-sourced answer."
    ].join(" "),
    inputSchema: deepSearchSchema
  },
  async ({ query, max_results = 20 }) => {
    const text = await askGrok({
      task: "deep_search",
      userText: query,
      maxResults: max_results,
      model: DEEP_SEARCH_MODEL,
      timeoutMs: config.deepTimeoutMs
    });

    return textContent(text);
  }
);

server.registerTool(
  "grok_fact_check",
  {
    title: "Grok Fact Check",
    description: "Fact-check a claim with Grok and return verdict, evidence, and source links.",
    inputSchema: factCheckSchema
  },
  async ({ claim, max_results = 15 }) => {
    const text = await askGrok({
      task: "fact_check",
      userText: claim,
      maxResults: max_results,
      model: FAST_SEARCH_MODEL,
      timeoutMs: config.timeoutMs
    });

    return textContent(text);
  }
);

async function askGrok({ task, userText, maxResults, model, timeoutMs }) {
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(task, maxResults)
    },
    {
      role: "user",
      content: userText
    }
  ];

  const result = await callGrok(messages, { model, timeoutMs });
  return appendFooter(result.content, { model: result.model ?? model, task, usage: result.usage });
}

async function callGrok(messages, options = {}) {
  if (!config.apiKey) {
    throw new Error("GROK_API_KEY is required.");
  }

  const model = options.model ?? FAST_SEARCH_MODEL;
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const maxTokens = options.max_tokens;
  const stream = options.stream ?? config.useStreaming;

  if (stream) {
    return callGrokStream(messages, { model, timeoutMs, maxTokens });
  }
  return callGrokNonStream(messages, { model, timeoutMs, maxTokens });
}

// Idle-timeout-aware streaming call. Resets the timer every time we receive
// a chunk, so the upstream gateway can take a long time as long as it keeps
// the SSE connection warm.
async function callGrokStream(messages, { model, timeoutMs, maxTokens }) {
  const controller = new AbortController();
  let timer = null;
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  armTimer();

  const payload = {
    model,
    messages,
    temperature: 0.2,
    stream: true
  };
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;

  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error?.name === "AbortError") {
      throw new Error(`Grok API streaming request idle-timed-out after ${timeoutMs}ms (model: ${model}).`);
    }
    throw error;
  }

  if (!response.ok) {
    const text = await safeText(response);
    if (timer) clearTimeout(timer);
    throw new Error(`Grok API request failed (${response.status}) for model ${model}: ${text}`);
  }

  if (!response.body) {
    if (timer) clearTimeout(timer);
    throw new Error(`Grok API streaming response has no body (model: ${model}).`);
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let reportedModel;
  let usage;

  try {
    const reader = response.body.getReader();
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error(`Grok API stream idle-timed-out after ${timeoutMs}ms (model: ${model}).`);
        }
        throw error;
      }
      if (chunk.done) break;
      armTimer(); // reset idle timer on every received chunk

      buffer += decoder.decode(chunk.value, { stream: true });
      // Process complete SSE events terminated by a blank line, while leaving
      // any partial trailing event in the buffer.
      let sepIndex;
      while ((sepIndex = findSseEventBoundary(buffer)) !== -1) {
        const event = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex).replace(/^\r?\n\r?\n/, "");
        const parsed = parseSseEvent(event);
        if (!parsed) continue;
        if (parsed.done) {
          // Drain remaining and exit gracefully.
          buffer = "";
          break;
        }
        if (parsed.contentDelta) content += parsed.contentDelta;
        if (parsed.model) reportedModel = parsed.model;
        if (parsed.usage) usage = parsed.usage;
      }
    }

    // Flush any final buffered event (some servers don't emit a trailing blank line).
    if (buffer.trim() !== "") {
      const parsed = parseSseEvent(buffer);
      if (parsed) {
        if (parsed.contentDelta) content += parsed.contentDelta;
        if (parsed.model) reportedModel = parsed.model;
        if (parsed.usage) usage = parsed.usage;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const trimmed = content.trim();
  if (trimmed === "") {
    throw new Error(`Grok API stream returned no text content for model ${model}.`);
  }
  return { content: trimmed, model: reportedModel ?? model, usage };
}

// Non-streaming fallback. Useful when GROK_STREAM=false for debugging or
// when the upstream gateway misbehaves with SSE.
async function callGrokNonStream(messages, { model, timeoutMs, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model,
    messages,
    temperature: 0.2,
    stream: false
  };
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const bodyText = await response.text();
    const body = parseCompletionBody(bodyText);

    if (!response.ok) {
      const detail = body?.error?.message ?? bodyText;
      throw new Error(`Grok API request failed (${response.status}) for model ${model}: ${detail}`);
    }

    const answer = extractAnswer(body);
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new Error(`Grok API returned no text content for model ${model}.`);
    }

    const reportedModel = body?.model ?? body?.chunks?.find?.((c) => c?.model)?.model;
    const usage = body?.usage;
    return { content: answer.trim(), model: reportedModel ?? model, usage };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Grok API request timed out after ${timeoutMs}ms (model: ${model}).`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(response) {
  try { return await response.text(); } catch { return ""; }
}

function findSseEventBoundary(buffer) {
  const a = buffer.indexOf("\n\n");
  const b = buffer.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

// Parse a single SSE event block (one or more `data: ...` / `event: ...` lines).
// Returns { contentDelta?, model?, usage?, done? }.
function parseSseEvent(block) {
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const data = rawLine.slice("data:".length).trim();
    if (data === "") continue;
    if (data === "[DONE]") return { done: true };
    dataLines.push(data);
  }
  if (dataLines.length === 0) return undefined;

  // Most providers send one JSON per `data:` line.
  const joined = dataLines.join("");
  const parsed = parseJson(joined) ?? parseJson(dataLines[dataLines.length - 1]);
  if (!parsed) return undefined;

  const choice = parsed?.choices?.[0];
  const delta = choice?.delta?.content ?? choice?.text ?? "";
  return {
    contentDelta: typeof delta === "string" ? delta : "",
    model: parsed?.model,
    usage: parsed?.usage
  };
}

function buildSystemPrompt(task, maxResults) {
  if (task === "fact_check") {
    return [
      "You are a careful fact-checking assistant with live web search capability.",
      "Verify the claim using current public evidence.",
      "Return: Verdict, Evidence, Caveats, Sources.",
      `Include up to ${maxResults} source links with title and URL.`,
      "Do not cite sources without URLs."
    ].join("\n");
  }

  if (task === "deep_search") {
    return [
      "You are a deep research assistant with live web search and multi-agent investigation capability.",
      "The user's query requires broad, multi-source investigation.",
      "Cross-check claims across multiple independent sources before stating them.",
      "Prefer breadth and accuracy over speed.",
      "Return: Summary, Key Findings (with inline source markers), Open Questions, Sources.",
      `Include up to ${maxResults} source links with title and URL.`,
      "Do not cite sources without URLs."
    ].join("\n");
  }

  return [
    "You are a web search assistant with live web search capability.",
    "Answer the user's query using current public evidence.",
    "Return a concise answer followed by Sources.",
    `Include up to ${maxResults} source links with title and URL.`,
    "Do not cite sources without URLs."
  ].join("\n");
}

function appendFooter(answer, { model, task, usage }) {
  const lines = [`model: ${model}`, `tool: ${task}`];
  if (usage && (usage.prompt_tokens || usage.completion_tokens || usage.total_tokens)) {
    const pt = usage.prompt_tokens ?? "?";
    const ct = usage.completion_tokens ?? "?";
    const tt = usage.total_tokens ?? "?";
    lines.push(`usage: prompt=${pt} completion=${ct} total=${tt}`);
  }
  return `${answer}\n\n---\n${lines.join("\n")}`;
}

function parseCompletionBody(text) {
  if (text.trimStart().startsWith("data:")) {
    return parseSseCompletion(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSseCompletion(text) {
  const chunks = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }

    const chunk = parseJson(data);
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return { chunks };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractAnswer(body) {
  const messageContent = body?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (Array.isArray(body?.chunks)) {
    return body.chunks
      .map((chunk) => chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.text ?? "")
      .filter(Boolean)
      .join("");
  }

  return undefined;
}

function textContent(text) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Grok Search MCP server failed:", error);
  process.exit(1);
});
