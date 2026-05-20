import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./src/server.js", import.meta.url));

if (!process.env.GROK_API_KEY) {
  console.error("GROK_API_KEY is required. Set it in your environment or a .env file before running the test.");
  process.exit(1);
}

const childEnv = { ...process.env };
for (const key of ["GROK_BASE_URL", "GROK_MODEL", "GROK_TIMEOUT_MS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]) {
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
  version: "1.0.0"
});

try {
  await client.connect(transport);

  const toolsResponse = await client.listTools();
  const toolNames = toolsResponse.tools.map((tool) => tool.name);

  console.log("Available tools:", toolNames.join(", "));

  for (const requiredTool of ["grok_search", "grok_fact_check"]) {
    if (!toolNames.includes(requiredTool)) {
      throw new Error(`Missing required tool: ${requiredTool}`);
    }
  }

  const result = await client.callTool({
    name: "grok_search",
    arguments: {
      query: "What is the latest stable Node.js major version?",
      max_results: 25
    }
  });

  if (result.isError) {
    throw new Error(`grok_search returned an MCP tool error: ${JSON.stringify(result.content)}`);
  }

  const text = result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  if (!text || text.trim().length < 20) {
    throw new Error("grok_search returned an empty or unexpectedly short result.");
  }

  console.log("grok_search result preview:");
  console.log(text.slice(0, 1000));

  const factCheckResult = await client.callTool({
    name: "grok_fact_check",
    arguments: {
      claim: "The MCP server can be called through stdio."
    }
  });

  if (factCheckResult.isError) {
    throw new Error(`grok_fact_check returned an MCP tool error: ${JSON.stringify(factCheckResult.content)}`);
  }

  const factCheckText = factCheckResult.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  if (!factCheckText || factCheckText.trim().length < 20) {
    throw new Error("grok_fact_check returned an empty or unexpectedly short result.");
  }

  console.log("grok_fact_check result preview:");
  console.log(factCheckText.slice(0, 1000));
} finally {
  await client.close();
}
