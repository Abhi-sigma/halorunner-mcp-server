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
  CORS_ALLOWED_ORIGINS: z.string().default("*")
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
  cached = parsed.data;
  return cached;
}

export function cognitoAuthority(e: Env = env()): string {
  return `https://cognito-idp.${e.COGNITO_REGION}.amazonaws.com/${e.COGNITO_USER_POOL_ID}`;
}
