import { z } from "zod";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// -- Zod schema mirrors tools.schema.json exactly. --------------------------

const parameterSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
  format: z.string().optional(),
  required: z.boolean().default(false),
  in: z.enum(["query", "path", "body", "header"]).default("query"),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  default: z.unknown().optional()
}).strict();

const returnFieldSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
  pii: z.boolean(),
  format: z.string().optional(),
  description: z.string().optional()
}).strict();

const toolSchema = z.object({
  tool_name: z.string().regex(/^[a-z][a-z0-9_]*$/, "tool_name must be snake_case"),
  path: z.string().startsWith("/"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  category: z.string().min(1),
  description: z.string().min(1),
  write: z.boolean().default(false),
  deprecated: z.boolean().default(false),
  source: z.object({
    swagger_operation_id: z.string().optional()
  }).passthrough().optional(),
  parameters: z.record(parameterSchema).default({}),
  returns: z.record(returnFieldSchema).default({})
}).strict();

const categorySchema = z.object({
  label: z.string(),
  summary: z.string()
}).strict();

export const toolsConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal("1.0"),
  strict_returns: z.boolean().default(true),
  redactionValue: z.string().default("REDACTED"),
  categories: z.record(categorySchema),
  tools: z.array(toolSchema)
}).strict();

export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
export type ToolDef = z.infer<typeof toolSchema>;
export type ParameterDef = z.infer<typeof parameterSchema>;
export type ReturnFieldDef = z.infer<typeof returnFieldSchema>;
export type CategoryDef = z.infer<typeof categorySchema>;

// -- Loader -----------------------------------------------------------------

function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "./tools.json");
}

export async function loadToolsConfig(path = defaultConfigPath()): Promise<ToolsConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const result = toolsConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid tools.json:\n${issues}`);
  }

  // Cross-check: every tool.category must exist in categories.
  const knownCategories = new Set(Object.keys(result.data.categories));
  const unknown = result.data.tools
    .filter(t => !knownCategories.has(t.category))
    .map(t => `${t.tool_name} → ${t.category}`);
  if (unknown.length) {
    throw new Error(`tools.json references unknown categories:\n  ${unknown.join("\n  ")}`);
  }

  // Cross-check: tool_name uniqueness.
  const names = new Set<string>();
  for (const t of result.data.tools) {
    if (names.has(t.tool_name)) throw new Error(`Duplicate tool_name: ${t.tool_name}`);
    names.add(t.tool_name);
  }

  return result.data;
}
