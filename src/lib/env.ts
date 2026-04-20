import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  API_BASE_URL: z.string().url(),
  API_KEY: z.string().optional().default(""),

  COGNITO_REGION: z.string().min(1),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
  COGNITO_HOSTED_UI_DOMAIN: z.string().url(),
  COGNITO_SCOPES: z.string().default("openid email phone profile"),

  PUBLIC_BASE_URL: z.string().url(),

  // Comma-separated list of origins allowed to hit /mcp.
  // Dev default is permissive; in production set this explicitly.
  CORS_ALLOWED_ORIGINS: z.string().default("*"),

  // Storage driver for DCR clients, pending auths, and issued codes.
  //   memory  — in-process Map, single-node only (dev default).
  //   dynamo  — DynamoDB, required for multi-instance / durable deploys.
  STORE_DRIVER: z.enum(["memory", "dynamo"]).default("memory"),
  DDB_CLIENTS_TABLE: z.string().optional(),
  DDB_PENDING_TABLE: z.string().optional(),
  DDB_CODES_TABLE: z.string().optional(),

  // Optional Secrets Manager secret ID. If set, pulled at boot and merged
  // into process.env BEFORE env() runs. Secret must be JSON of {KEY:VALUE}.
  SECRETS_MANAGER_SECRET_ID: z.string().optional()
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertProductionInvariants(parsed.data);
  cached = parsed.data;
  return cached;
}

/**
 * Fail loudly on startup if production-only invariants are violated.
 * These are mistakes that are safe in dev but actively dangerous with real
 * PII in flight — wildcard CORS, missing Cognito pool, etc.
 */
function assertProductionInvariants(e: Env): void {
  if (e.NODE_ENV !== "production" && e.NODE_ENV !== "staging") return;

  const origins = e.CORS_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
  if (origins.includes("*") || origins.length === 0) {
    throw new Error(
      `CORS_ALLOWED_ORIGINS must be set to explicit origins in ${e.NODE_ENV} (got "${e.CORS_ALLOWED_ORIGINS}"). ` +
        `Wildcard CORS is blocked because the /mcp endpoint serves authenticated PII.`
    );
  }
  for (const origin of origins) {
    if (!/^https:\/\//.test(origin)) {
      throw new Error(
        `CORS origin "${origin}" must use https:// in ${e.NODE_ENV}. Plain http:// origins are blocked.`
      );
    }
  }

  if (e.STORE_DRIVER === "memory") {
    throw new Error(
      `STORE_DRIVER=memory is not permitted in ${e.NODE_ENV}. Use dynamo and configure ` +
        `DDB_CLIENTS_TABLE / DDB_PENDING_TABLE / DDB_CODES_TABLE.`
    );
  }

  if (e.STORE_DRIVER === "dynamo") {
    const missing = [
      !e.DDB_CLIENTS_TABLE && "DDB_CLIENTS_TABLE",
      !e.DDB_PENDING_TABLE && "DDB_PENDING_TABLE",
      !e.DDB_CODES_TABLE && "DDB_CODES_TABLE"
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`STORE_DRIVER=dynamo requires: ${missing.join(", ")}`);
    }
  }
}

export function cognitoAuthority(e: Env = env()): string {
  return `https://cognito-idp.${e.COGNITO_REGION}.amazonaws.com/${e.COGNITO_USER_POOL_ID}`;
}
