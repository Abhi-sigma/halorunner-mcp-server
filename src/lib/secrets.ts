import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * Pull a JSON secret from AWS Secrets Manager and merge its keys into
 * process.env. Must be called BEFORE env() is first invoked.
 *
 * Expected secret payload:
 *   { "COGNITO_CLIENT_ID": "...", "API_KEY": "...", ... }
 *
 * Existing process.env values win over secret values — so a developer can
 * override a single key locally without editing the secret.
 */
export async function loadSecretsIntoEnv(secretId: string | undefined, region?: string): Promise<void> {
  if (!secretId) return;

  const client = new SecretsManagerClient(region ? { region } : {});
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(SecretString);
  } catch {
    throw new Error(`Secrets Manager secret "${secretId}" is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secrets Manager secret "${secretId}" must be a JSON object of { KEY: "VALUE" }`);
  }

  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (process.env[k] !== undefined) continue; // existing env var wins
    if (typeof v === "string") {
      process.env[k] = v;
    } else if (v !== null && v !== undefined) {
      process.env[k] = String(v);
    }
  }
}
