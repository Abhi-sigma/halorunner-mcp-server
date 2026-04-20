import { createHash } from "node:crypto";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import type { ToolDef } from "../config/schema.js";

function hashForLog(text: string): string {
  if (text.length === 0) return "empty";
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface CallResult {
  status: number;
  body: unknown;
}

const TIMEOUT_MS = 15_000;

/**
 * Call the upstream .NET API for a given tool.
 *
 * - Substitutes {pathParam} placeholders in tool.path.
 * - Serialises `query` params into the URL, `body` params into the JSON body,
 *   `header` params into request headers, `path` params already substituted.
 * - Attaches Authorization: Bearer <userToken>.
 * - Optionally attaches x-api-key from env.API_KEY (legacy frontend header).
 */
export async function callUpstream(
  tool: ToolDef,
  args: Record<string, unknown>,
  userToken: string
): Promise<CallResult> {
  const e = env();

  // Partition args by their declared `in` location.
  const pathArgs = new Map<string, string>();
  const queryArgs = new URLSearchParams();
  const headerArgs = new Map<string, string>();
  const bodyArgs: Record<string, unknown> = {};

  for (const [name, def] of Object.entries(tool.parameters)) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (def.required) throw new Error(`Missing required parameter: ${name}`);
      continue;
    }
    switch (def.in) {
      case "path":   pathArgs.set(name, String(value)); break;
      case "query":  queryArgs.set(name, String(value)); break;
      case "header": headerArgs.set(name, String(value)); break;
      case "body":   bodyArgs[name] = value; break;
    }
  }

  // Substitute path placeholders e.g. /foo/{id}
  let path = tool.path;
  for (const [k, v] of pathArgs) {
    path = path.replaceAll(`{${k}}`, encodeURIComponent(v));
  }

  // Concatenate, don't use `new URL(path, base)` — that would drop any path
  // prefix on the base (e.g. `/web` in production). Here we want the full
  // base URL preserved verbatim.
  const base = e.API_BASE_URL.replace(/\/+$/, "");
  const joinedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${joinedPath}`);
  for (const [k, v] of queryArgs) url.searchParams.append(k, v);

  const headers: Record<string, string> = {
    "accept": "application/json",
    "authorization": `Bearer ${userToken}`
  };
  if (e.API_KEY) headers["x-api-key"] = e.API_KEY;
  for (const [k, v] of headerArgs) headers[k] = v;

  let body: string | undefined;
  if (tool.method !== "GET" && tool.method !== "DELETE" && Object.keys(bodyArgs).length > 0) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(bodyArgs);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const start = Date.now();
    const res = await fetch(url, { method: tool.method, headers, body, signal: ac.signal });
    const text = await res.text();
    const ms = Date.now() - start;

    logger.info(
      { tool: tool.tool_name, method: tool.method, url: url.toString(), status: res.status, ms },
      "upstream call"
    );

    // Log a digest of upstream errors — hash of the body + status + length.
    // The body itself is NOT logged: in production a 500 stack trace can
    // quote request data back, and request data may contain PII (patient
    // search strings, patient IDs with context, etc.). The hash lets you
    // correlate repeated identical errors without exposing content.
    if (res.status >= 400) {
      logger.warn(
        {
          tool: tool.tool_name,
          status: res.status,
          bodyHash: hashForLog(text),
          bodyLength: text.length
        },
        "upstream error response"
      );
    }

    let parsed: unknown = text;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && text.length > 0) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }

    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}
