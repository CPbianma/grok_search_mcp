import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const config = {
  baseUrl: process.env.GROK_BASE_URL ?? "http://localhost:8000/v1",
  apiKey: process.env.GROK_API_KEY,
  model: process.env.GROK_MODEL ?? "grok-4.20-fast",
  timeoutMs: Number.parseInt(process.env.GROK_TIMEOUT_MS ?? "90000", 10)
};

const server = new McpServer({
  name: "grok-search",
  version: "1.0.0"
});

const searchSchema = {
  query: z.string().min(1).describe("Search query to answer with current web evidence."),
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
    description: "Search the web with Grok and return an answer with source links.",
    inputSchema: searchSchema
  },
  async ({ query, max_results = 15 }) => {
    const text = await askGrok({
      task: "search",
      userText: query,
      maxResults: max_results
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
      maxResults: max_results
    });

    return textContent(text);
  }
);

async function askGrok({ task, userText, maxResults }) {
  if (!config.apiKey) {
    throw new Error("GROK_API_KEY is required.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(task, maxResults)
          },
          {
            role: "user",
            content: userText
          }
        ],
        temperature: 0.2
      }),
      signal: controller.signal
    });

    const bodyText = await response.text();
    const body = parseCompletionBody(bodyText);

    if (!response.ok) {
      const detail = body?.error?.message ?? bodyText;
      throw new Error(`Grok API request failed (${response.status}): ${detail}`);
    }

    const answer = extractAnswer(body);
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new Error("Grok API returned no text content.");
    }

    return answer.trim();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Grok API request timed out after ${config.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

  return [
    "You are a web search assistant with live web search capability.",
    "Answer the user's query using current public evidence.",
    "Return a concise answer followed by Sources.",
    `Include up to ${maxResults} source links with title and URL.`,
    "Do not cite sources without URLs."
  ].join("\n");
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
