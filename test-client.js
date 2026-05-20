import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./src/server.js", import.meta.url));

if (!process.env.GROK_API_KEY) {
  console.error("GROK_API_KEY is required. Set it in your environment or a .env file before running the test.");
  process.exit(1);
}

const FAST_SEARCH_MODEL = "grok-4.3";
const DEEP_SEARCH_MODEL = "grok-4.20-multi-agent";

const childEnv = { ...process.env };
// NOTE: GROK_MODEL is intentionally NOT forwarded — the server pins models
// per-tool and ignores GROK_MODEL on purpose.
for (const key of [
  "GROK_BASE_URL",
  "GROK_TIMEOUT_MS",
  "GROK_DEEP_TIMEOUT_MS",
  "GROK_STREAM",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY"
]) {
  if (process.env[key] !== undefined) {
    childEnv[key] = process.env[key];
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: childEnv
});

const client = new Client({
  name: "grok-search-test-client",
  version: "1.2.0"
});

function extractText(result) {
  return result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
}

function assertModelFooter(text, expectedModel, toolName) {
  if (!text.includes(`model: ${expectedModel}`)) {
    throw new Error(
      `${toolName} response footer did not pin the expected model.\n` +
      `Expected footer to contain "model: ${expectedModel}".\n` +
      `Got tail:\n${text.slice(-400)}`
    );
  }
}

try {
  await client.connect(transport);

  const toolsResponse = await client.listTools();
  const toolNames = toolsResponse.tools.map((tool) => tool.name);

  console.log("Available tools:", toolNames.join(", "));

  for (const requiredTool of ["grok_search", "grok_deep_search", "grok_fact_check"]) {
    if (!toolNames.includes(requiredTool)) {
      throw new Error(`Missing required tool: ${requiredTool}`);
    }
  }

  // 1. grok_search → grok-4.3
  const searchResult = await client.callTool({
    name: "grok_search",
    arguments: {
      query: "What is the latest stable Node.js major version?",
      max_results: 25
    }
  }, undefined, { timeout: 130000 });

  if (searchResult.isError) {
    throw new Error(`grok_search returned an MCP tool error: ${JSON.stringify(searchResult.content)}`);
  }

  const searchText = extractText(searchResult);
  if (!searchText || searchText.trim().length < 20) {
    throw new Error("grok_search returned an empty or unexpectedly short result.");
  }
  assertModelFooter(searchText, FAST_SEARCH_MODEL, "grok_search");

  console.log("grok_search result preview:");
  console.log(searchText.slice(0, 1000));

  // 2. grok_deep_search → grok-4.20-multi-agent
  const deepResult = await client.callTool({
    name: "grok_deep_search",
    arguments: {
      query: "Compare the major MCP server implementations published in 2025 and how they differ on transport, auth, and tooling.",
      max_results: 20
    }
  }, undefined, { timeout: 320000 });

  if (deepResult.isError) {
    throw new Error(`grok_deep_search returned an MCP tool error: ${JSON.stringify(deepResult.content)}`);
  }

  const deepText = extractText(deepResult);
  if (!deepText || deepText.trim().length < 20) {
    throw new Error("grok_deep_search returned an empty or unexpectedly short result.");
  }
  assertModelFooter(deepText, DEEP_SEARCH_MODEL, "grok_deep_search");

  console.log("grok_deep_search result preview:");
  console.log(deepText.slice(0, 1000));

  // 3. grok_fact_check → grok-4.3
  const factCheckResult = await client.callTool({
    name: "grok_fact_check",
    arguments: {
      claim: "The MCP server can be called through stdio."
    }
  }, undefined, { timeout: 130000 });

  if (factCheckResult.isError) {
    throw new Error(`grok_fact_check returned an MCP tool error: ${JSON.stringify(factCheckResult.content)}`);
  }

  const factCheckText = extractText(factCheckResult);
  if (!factCheckText || factCheckText.trim().length < 20) {
    throw new Error("grok_fact_check returned an empty or unexpectedly short result.");
  }
  assertModelFooter(factCheckText, FAST_SEARCH_MODEL, "grok_fact_check");

  console.log("grok_fact_check result preview:");
  console.log(factCheckText.slice(0, 1000));

  console.log("\nAll three tools returned the expected pinned-model footer.");
} finally {
  await client.close();
}
