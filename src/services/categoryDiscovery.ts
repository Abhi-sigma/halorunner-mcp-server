import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolsConfig } from "../config/schema.js";
import type { RedactionPlan } from "../middleware/redact.js";
import { groupByCategory, registerTool, type SessionResolver } from "./toolRegistry.js";
import { logger } from "../lib/logger.js";

/**
 * Register every non-deprecated tool against the server up-front, plus an
 * informational `list_categories` tool.
 *
 * We previously used progressive discovery (register-on-demand via
 * load_category), but most MCP clients — including Claude.ai — only
 * re-fetch the tool list between user turns, so dynamically-registered
 * tools were visible in the server but not callable in the same turn.
 * Eager registration works everywhere without relying on
 * `notifications/tools/list_changed` delivery timing.
 *
 * At ~30 tools the context cost of exposing all schemas upfront is still
 * small (a few KB). Revisit this decision if we grow well past that.
 */
export function installAllTools(
  server: McpServer,
  config: ToolsConfig,
  plans: Map<string, RedactionPlan>,
  getSession: SessionResolver
): void {
  const byCategory = groupByCategory(config);

  // Informational browsing aid — lets Claude orient itself among categories
  // without acting as a gate. All real tools are already registered below.
  server.registerTool(
    "list_categories",
    {
      description:
        "List the tool categories exposed by this server with their tool counts. Informational only — all tools are already available, no separate loading step needed.",
      inputSchema: {}
    },
    async () => {
      const rows = Array.from(byCategory.entries()).map(([key, tools]) => {
        const meta = config.categories[key];
        return {
          category: key,
          label: meta?.label ?? key,
          summary: meta?.summary ?? "",
          toolCount: tools.length,
          tools: tools.map(t => t.tool_name)
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  // Eager-register every non-deprecated tool.
  let registered = 0;
  for (const tool of config.tools) {
    if (tool.deprecated) continue;
    const plan = plans.get(tool.tool_name);
    if (!plan) {
      logger.warn({ tool: tool.tool_name }, "no redaction plan, skipping registration");
      continue;
    }
    registerTool(server, tool, plan, getSession);
    registered++;
  }
  logger.info({ registered, total: config.tools.length }, "tools registered eagerly");
}
