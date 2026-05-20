import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Fixed model routing — do NOT read GROK_MODEL from env to avoid stale model ids.
const FAST_SEARCH_MODEL = "grok-4.20-fast";
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
  version: "1.4.0"
});

// Per-tool retry budgets. Fast tools retry up to 3 times; deep search up to 2
// (each attempt is already long, so we don't want to multiply the wall time).
const FAST_MAX_ATTEMPTS = 3;
const DEEP_MAX_ATTEMPTS = 2;
// Backoff between attempts in ms. Length of array implicitly caps total tries.
const BACKOFF_MS = [2000, 5000, 10000];

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
    description: "Web search with Grok. Returns an answer with source links. Use this for everyday lookups.",
    inputSchema: searchSchema
  },
  async ({ query, max_results = 20 }) => {
    const text = await askGrokWithRetry({
      task: "search",
      userText: query,
      maxResults: max_results,
      model: FAST_SEARCH_MODEL,
      timeoutMs: config.timeoutMs,
      maxAttempts: FAST_MAX_ATTEMPTS
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
    const text = await askGrokWithRetry({
      task: "deep_search",
      userText: query,
      maxResults: max_results,
      model: DEEP_SEARCH_MODEL,
      timeoutMs: config.deepTimeoutMs,
      maxAttempts: DEEP_MAX_ATTEMPTS
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
  async ({ claim, max_results = 20 }) => {
    const text = await askGrokWithRetry({
      task: "fact_check",
      userText: claim,
      maxResults: max_results,
      model: FAST_SEARCH_MODEL,
      timeoutMs: config.timeoutMs,
      maxAttempts: FAST_MAX_ATTEMPTS
    });

    return textContent(text);
  }
);

async function askGrokWithRetry(params) {
  const { task, maxAttempts } = params;
  const label = `${task}/${params.model}`;
  const attempts = clampAttempts(maxAttempts);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const out = await askGrokOnce(params);
      // Success path: append footer (with attempt count) and return.
      return appendFooter(out.content, {
        model: out.model ?? params.model,
        task,
        usage: out.usage,
        attempts: attempt
      });
    } catch (error) {
      lastError = error;
      const summary = errorSummary(error);
      const retryable = isRetryableError(error);
      const willRetry = retryable && attempt < attempts;

      // stderr breadcrumb so MCP clients with logs can see what happened.
      // We never log the API key or auth header.
      console.error(
        `[grok-search] attempt ${attempt}/${attempts} failed (${label}): ${summary}` +
        (willRetry ? ` — retrying in ${BACKOFF_MS[attempt - 1] ?? 0}ms` : "")
      );

      if (!willRetry) break;
      const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
      await sleep(wait);
    }
  }

  // All attempts exhausted. Return a clear, MCP-text-style error message.
  const summary = errorSummary(lastError);
  throw new Error(`Grok ${task} failed after ${attempts} attempt(s): ${summary}`);
}

function clampAttempts(n) {
  if (!Number.isFinite(n) || n < 1) return 1;
  // We only have BACKOFF_MS.length backoff slots; one more attempt than slots
  // is fine (last attempt has no follow-up wait).
  return Math.min(n, BACKOFF_MS.length + 1);
}

async function askGrokOnce({ task, userText, maxResults, model, timeoutMs }) {
  const messages = [
    { role: "system", content: buildSystemPrompt(task, maxResults) },
    { role: "user", content: userText }
  ];

  // Each attempt re-issues a fresh /chat/completions request, giving grok2api
  // a chance to pick a different upstream account on the next try.
  const result = await callGrok(messages, { model, timeoutMs });

  // Some failures come back as HTTP-200 JSON content with an "overloaded"
  // string inside instead of a proper error. Detect that and force a retry.
  if (isRetryableText(result.content)) {
    throw makeRetryableError(`upstream returned retryable text: ${snippet(result.content)}`);
  }

  return result;
}

const RETRYABLE_TEXT_PATTERNS = [
  /this model is overloaded/i,
  /overloaded right now/i,
  /try again shortly/i,
  /service temporarily unavailable/i,
  /grok2api stream did not include assistant content/i,
  /524: a timeout occurred/i,
  /\bcloudflare\b/i,
  /\btimed? out\b/i
];

function isRetryableText(text) {
  if (typeof text !== "string" || text.trim() === "") return false;
  return RETRYABLE_TEXT_PATTERNS.some((re) => re.test(text));
}

function isRetryableError(error) {
  if (!error) return false;

  // Explicit marker we set ourselves.
  if (error.retryable === true) return true;

  const name = String(error.name ?? "");
  const msg = String(error.message ?? "");

  // fetch / abort
  if (name === "AbortError") return true;
  if (/aborted/i.test(msg)) return true;

  // Node fetch / undici connection problems
  if (/terminated/i.test(msg)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i.test(msg)) return true;
  if (/connection (closed|reset|refused)/i.test(msg)) return true;
  if (/fetch failed/i.test(msg)) return true;
  if (/idle-timed-out/i.test(msg)) return true;
  if (/no text content/i.test(msg)) return true;

  // Upstream HTTP statuses that imply transient failures.
  if (/\bGrok API request failed \((50[234]|408|429|499|520|521|522|523|524|525|526|527|530)\)/i.test(msg)) {
    return true;
  }

  // Anything matching the same retryable text patterns we use on bodies.
  if (isRetryableText(msg)) return true;

  return false;
}

function makeRetryableError(message) {
  const e = new Error(message);
  e.retryable = true;
  return e;
}

function errorSummary(error) {
  if (!error) return "unknown error";
  const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
  const msg = String(error.message ?? error);
  // Trim very long upstream payloads but keep enough context to debug.
  return `${name}${msg.length > 500 ? msg.slice(0, 500) + "…" : msg}`;
}

function snippet(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function appendFooter(answer, { model, task, usage, attempts }) {
  const lines = [`model: ${model}`, `tool: ${task}`];
  if (usage && (usage.prompt_tokens || usage.completion_tokens || usage.total_tokens)) {
    const pt = usage.prompt_tokens ?? "?";
    const ct = usage.completion_tokens ?? "?";
    const tt = usage.total_tokens ?? "?";
    lines.push(`usage: prompt=${pt} completion=${ct} total=${tt}`);
  }
  if (typeof attempts === "number" && attempts > 0) {
    lines.push(`attempts: ${attempts}`);
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
