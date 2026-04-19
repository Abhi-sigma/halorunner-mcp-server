import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { ParameterDef, ToolDef, ToolsConfig } from "../config/schema.js";
import type { RedactionPlan } from "../middleware/redact.js";
import { redact } from "../middleware/redact.js";
import { callUpstream } from "./apiClient.js";
import { logger } from "../lib/logger.js";

export interface SessionContext {
  /** Bearer token extracted from the MCP HTTP request — forwarded upstream. */
  userToken: string;
}

export type SessionResolver = () => SessionContext;

/**
 * Register a tool against a live McpServer instance.
 * Called once per tool whenever a category is loaded in a session.
 */
export function registerTool(
  server: McpServer,
  tool: ToolDef,
  plan: RedactionPlan,
  getSession: SessionResolver
): void {
  const inputShape = buildInputShape(tool.parameters);

  const description = tool.write
    ? `⚠ WRITE OPERATION: ${tool.description}`
    : tool.description;

  server.registerTool(
    tool.tool_name,
    {
      description,
      inputSchema: inputShape
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();
      try {
        const { status, body } = await callUpstream(tool, args, session.userToken);
        const redacted = redact(plan, body);
        const payload = {
          status,
          tool: tool.tool_name,
          data: redacted
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: status >= 400
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, tool: tool.tool_name }, "tool call failed");
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true
        };
      }
    }
  );
}

/**
 * Convert our JSON parameter definitions to a Zod raw shape for McpServer.
 * Kept simple — strings are strings, numbers/integers are numbers, etc.
 * Format hints (e.g. "date") surface only in the description.
 */
function buildInputShape(params: Record<string, ParameterDef>): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const [name, def] of Object.entries(params)) {
    let schema: ZodTypeAny = baseType(def);
    if (def.description || def.format) {
      const bits = [def.description, def.format ? `(format: ${def.format})` : ""].filter(Boolean);
      schema = schema.describe(bits.join(" ").trim());
    }
    if (!def.required) schema = schema.optional();
    shape[name] = schema;
  }
  return shape;
}

function baseType(def: ParameterDef): ZodTypeAny {
  switch (def.type) {
    case "string":  return z.string();
    case "number":  return z.number();
    case "integer": return z.number().int();
    case "boolean": return z.boolean();
    case "array":   return z.array(z.unknown());
    case "object":  return z.record(z.unknown());
  }
}

/**
 * Compile category → tool list map for progressive discovery.
 */
export function groupByCategory(config: ToolsConfig): Map<string, ToolDef[]> {
  const m = new Map<string, ToolDef[]>();
  for (const t of config.tools) {
    if (t.deprecated) continue;
    const bucket = m.get(t.category);
    if (bucket) bucket.push(t); else m.set(t.category, [t]);
  }
  return m;
}
