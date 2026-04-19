/* eslint-disable no-console */
/**
 * Swagger → tools.json candidate generator.
 *
 * Usage:
 *   npm run generate:tools -- --swagger <url-or-path> [--out <path>] [--insecure]
 *
 * Behaviour:
 *   - Reads OpenAPI 3 JSON from a URL (http/https) or local file.
 *   - Emits two artifacts:
 *       src/config/tools.candidates.json    (full candidate set — one entry per operation)
 *       src/config/tools.diff.md            (human-readable diff vs current tools.json)
 *   - NEVER writes to tools.json directly. Every live tool must be an explicit
 *     choice, so the scraper is advisory only — copy entries across by hand.
 *   - Auto-annotates pii:true on fields whose name matches the canonical list.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PII_FIELD_PATTERNS: readonly RegExp[] = [
  /^(first[_ ]?name|last[_ ]?name|surname|full[_ ]?name|preferred[_ ]?name|middle[_ ]?name|patient[_ ]?name|contact[_ ]?name)$/i,
  /^name$/i,
  /^(dob|date[_ ]?of[_ ]?birth|birth[_ ]?date|birthday)$/i,
  /^(email|email[_ ]?address)$/i,
  /^(phone|mobile|home[_ ]?phone|work[_ ]?phone|mobile[_ ]?phone|phone[_ ]?number)$/i,
  /^(address|address1|address2|street|suburb|city|state|postcode|postal[_ ]?code|zip)$/i,
  /^(medicare|medicare[_ ]?no|medicare[_ ]?number|ihi|dva|dva[_ ]?number|irn)$/i,
  /^(notes|comments|clinical[_ ]?notes|reason|appointment[_ ]?reason)$/i
];

const CATEGORY_BY_TAG: Record<string, string> = {
  financial: "billing",
  invoices: "billing",
  payments: "billing",
  billing: "billing",
  appointments: "appointments",
  booking: "appointments",
  aibooking: "appointments",
  patients: "gp",
  threads: "gp",
  messages: "gp",
  patientfile: "gp",
  referrals: "referrals",
  documents: "documents",
  patientdocuments: "documents",
  dashboard: "admin",
  reports: "admin",
  configuration: "admin",
  admin: "admin"
};

interface Args {
  swagger: string;
  out: string;
  insecure: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let swagger = "";
  let out = "";
  let insecure = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--swagger") swagger = argv[++i] ?? "";
    else if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--insecure") insecure = true;
  }
  if (!swagger) {
    console.error("Usage: generate:tools -- --swagger <url-or-path> [--out <path>] [--insecure]");
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultOut = resolve(here, "../src/config/tools.candidates.json");
  return { swagger, out: out || defaultOut, insecure };
}

async function loadSpec(source: string, insecure: boolean): Promise<OpenApiSpec> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch ${source} → ${res.status}`);
    return (await res.json()) as OpenApiSpec;
  }
  const text = await readFile(source, "utf8");
  return JSON.parse(text) as OpenApiSpec;
}

// -- Minimal OpenAPI 3 shape (only what we use) -----------------------------

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  paths: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}
interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  parameters?: OpenApiParameter[];
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
}
interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}
interface OpenApiSchema {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  format?: string;
  description?: string;
  $ref?: string;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  enum?: unknown[];
}

// -- Converter --------------------------------------------------------------

function resolveRef(spec: OpenApiSpec, schema: OpenApiSchema | undefined, seen = new Set<string>()): OpenApiSchema {
  if (!schema) return {};
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {}; // cycle guard
    seen.add(schema.$ref);
    const name = schema.$ref.split("/").pop() ?? "";
    const target = spec.components?.schemas?.[name];
    return target ? resolveRef(spec, target, seen) : {};
  }
  if (schema.allOf && schema.allOf.length) {
    const merged: OpenApiSchema = { type: "object", properties: {} };
    for (const part of schema.allOf) {
      const r = resolveRef(spec, part, seen);
      if (r.properties) merged.properties = { ...merged.properties, ...r.properties };
    }
    return merged;
  }
  return schema;
}

function isPiiField(name: string): boolean {
  return PII_FIELD_PATTERNS.some(rx => rx.test(name));
}

function flattenResponseSchema(
  spec: OpenApiSpec,
  schema: OpenApiSchema | undefined,
  prefix = ""
): Record<string, { type: string; pii: boolean; format?: string }> {
  const out: Record<string, { type: string; pii: boolean; format?: string }> = {};
  if (!schema) return out;

  const resolved = resolveRef(spec, schema);

  if (resolved.type === "array" && resolved.items) {
    // Apply field rules at element depth (same as our redactor walks arrays).
    return flattenResponseSchema(spec, resolved.items, prefix);
  }

  if (resolved.type === "object" && resolved.properties) {
    for (const [name, propSchema] of Object.entries(resolved.properties)) {
      const path = prefix ? `${prefix}.${name}` : name;
      const propResolved = resolveRef(spec, propSchema);

      if (propResolved.type === "object" && propResolved.properties) {
        Object.assign(out, flattenResponseSchema(spec, propResolved, path));
      } else if (propResolved.type === "array" && propResolved.items) {
        Object.assign(out, flattenResponseSchema(spec, propResolved.items, path));
      } else {
        const t = propResolved.type ?? "string";
        out[path] = {
          type: t,
          pii: isPiiField(name),
          ...(propResolved.format ? { format: propResolved.format } : {})
        };
      }
    }
  }

  return out;
}

function categoryFor(path: string, tags: string[] | undefined): string {
  for (const tag of tags ?? []) {
    const hit = CATEGORY_BY_TAG[tag.toLowerCase().replace(/\s+/g, "")];
    if (hit) return hit;
  }
  const first = path.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  return CATEGORY_BY_TAG[first] ?? "admin";
}

function toolNameFrom(method: string, path: string, operationId?: string): string {
  if (operationId) {
    return operationId
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }
  const slug = path
    .replace(/\{[^}]+\}/g, "by_id")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `${method.toLowerCase()}_${slug}`;
}

interface CandidateTool {
  tool_name: string;
  path: string;
  method: string;
  category: string;
  write: boolean;
  description: string;
  source: { swagger_operation_id?: string };
  parameters: Record<string, unknown>;
  returns: Record<string, unknown>;
}

/** Paths whose authentication scheme is incompatible with our Cognito Web-pool bearer tokens. */
const SKIP_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/ygp-patient\//i,  // PatientScheme (self-issued HMAC JWT)
  /^\/api\/webhooks\//i,     // public webhooks, not user-scoped
];

function shouldSkip(path: string): boolean {
  return SKIP_PATH_PATTERNS.some(rx => rx.test(path));
}

function generateCandidates(spec: OpenApiSpec): CandidateTool[] {
  const out: CandidateTool[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (shouldSkip(path)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = pathItem[method];
      if (!op) continue;

      const parameters: Record<string, unknown> = {};
      const combinedParams = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
      for (const p of combinedParams) {
        parameters[p.name] = {
          type: p.schema?.type ?? "string",
          ...(p.schema?.format ? { format: p.schema.format } : {}),
          required: !!p.required,
          in: p.in === "cookie" ? "header" : p.in,
          ...(p.description ? { description: p.description } : {})
        };
      }

      // Body parameters — pull top-level props of application/json schema into named params.
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        const resolved = resolveRef(spec, bodySchema);
        if (resolved.type === "object" && resolved.properties) {
          for (const [name, propSchema] of Object.entries(resolved.properties)) {
            const r = resolveRef(spec, propSchema);
            parameters[name] = {
              type: r.type ?? "string",
              ...(r.format ? { format: r.format } : {}),
              required: false, // swagger "required" is array-based; easier to default false and let human tune
              in: "body",
              ...(r.description ? { description: r.description } : {})
            };
          }
        }
      }

      const responseSchema = op.responses?.["200"]?.content?.["application/json"]?.schema
        ?? op.responses?.["201"]?.content?.["application/json"]?.schema;
      const returns = flattenResponseSchema(spec, responseSchema);

      const tool: CandidateTool = {
        tool_name: toolNameFrom(method, path, op.operationId),
        path,
        method: method.toUpperCase(),
        category: categoryFor(path, op.tags),
        write: method !== "get",
        description: op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`,
        source: { swagger_operation_id: op.operationId },
        parameters,
        returns
      };
      out.push(tool);
    }
  }
  return out;
}

// -- Diff report ------------------------------------------------------------

interface ExistingTool {
  tool_name: string;
  path: string;
  method: string;
}

async function loadExistingNames(): Promise<Set<string>> {
  const here = dirname(fileURLToPath(import.meta.url));
  const toolsJson = resolve(here, "../src/config/tools.json");
  try {
    const raw = await readFile(toolsJson, "utf8");
    const parsed = JSON.parse(raw) as { tools?: ExistingTool[] };
    return new Set((parsed.tools ?? []).map(t => `${t.method} ${t.path}`));
  } catch {
    return new Set();
  }
}

function buildDiffReport(candidates: CandidateTool[], existingKeys: Set<string>): string {
  const candidateKeys = new Set(candidates.map(c => `${c.method} ${c.path}`));
  const added = candidates.filter(c => !existingKeys.has(`${c.method} ${c.path}`));
  const removed = [...existingKeys].filter(k => !candidateKeys.has(k));

  const piiCandidates = candidates.filter(c =>
    Object.values(c.returns).some(v => (v as { pii?: boolean }).pii)
  );

  const lines: string[] = [];
  lines.push(`# Swagger candidate report`);
  lines.push("");
  lines.push(`- Total operations in spec: **${candidates.length}**`);
  lines.push(`- New (not in tools.json): **${added.length}**`);
  lines.push(`- Removed (in tools.json, not in spec): **${removed.length}**`);
  lines.push(`- With auto-annotated PII fields: **${piiCandidates.length}**`);
  lines.push("");

  if (added.length) {
    lines.push(`## New operations`);
    for (const c of added) {
      const piiCount = Object.values(c.returns).filter(v => (v as { pii?: boolean }).pii).length;
      lines.push(`- \`${c.method} ${c.path}\` → \`${c.tool_name}\` (category: ${c.category}${piiCount ? `, ${piiCount} PII field${piiCount === 1 ? "" : "s"}` : ""})`);
    }
    lines.push("");
  }

  if (removed.length) {
    lines.push(`## Operations in tools.json but missing from spec`);
    for (const key of removed) lines.push(`- \`${key}\``);
    lines.push("");
  }

  lines.push(`## Next steps`);
  lines.push(``);
  lines.push(`1. Review \`tools.candidates.json\`.`);
  lines.push(`2. Copy the entries you want into \`src/config/tools.json\`.`);
  lines.push(`3. Double-check \`pii\` annotations — the heuristic is conservative but not perfect.`);
  lines.push(`4. Delete any entries from \`tools.json\` whose operations were removed upstream.`);
  return lines.join("\n");
}

// -- Main -------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  console.log(`Reading OpenAPI spec from: ${args.swagger}`);
  const spec = await loadSpec(args.swagger, args.insecure);

  const candidates = generateCandidates(spec);
  const existingKeys = await loadExistingNames();
  const diff = buildDiffReport(candidates, existingKeys);

  const here = dirname(fileURLToPath(import.meta.url));
  const diffPath = resolve(here, "../src/config/tools.diff.md");

  await writeFile(args.out, JSON.stringify({ tools: candidates }, null, 2) + "\n", "utf8");
  await writeFile(diffPath, diff + "\n", "utf8");

  console.log(`\nWrote ${candidates.length} candidates → ${args.out}`);
  console.log(`Wrote diff report → ${diffPath}`);
  console.log(`\n${diff.split("\n").slice(0, 12).join("\n")}\n...`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
