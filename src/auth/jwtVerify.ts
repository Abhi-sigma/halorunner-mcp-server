import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { cognitoAuthority, env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const jwks = createRemoteJWKSet(new URL(`${cognitoAuthority()}/.well-known/jwks.json`));

export interface VerifiedIdentity {
  sub: string;
  clientId: string;
  tokenUse: "access" | "id";
  scopes: string[];
  claims: JWTPayload;
}

/**
 * Verify a Cognito-issued JWT from an inbound MCP request.
 * Rejects tokens not issued by our Web pool client.
 */
export async function verifyCognitoToken(token: string): Promise<VerifiedIdentity> {
  const e = env();
  const { payload } = await jwtVerify(token, jwks, {
    issuer: cognitoAuthority(),
    // Cognito access tokens do not have a consistent `aud`, so we validate client_id manually below.
  });

  const tokenUse = payload["token_use"];
  if (tokenUse !== "access" && tokenUse !== "id") {
    throw new Error(`Unsupported token_use: ${String(tokenUse)}`);
  }

  const clientId = String(payload["client_id"] ?? payload["aud"] ?? "");
  if (clientId !== e.COGNITO_CLIENT_ID) {
    throw new Error(`Token client_id mismatch: got ${clientId || "<missing>"}`);
  }

  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];

  logger.debug({ sub: payload.sub, clientId, tokenUse, scopes }, "token verified");

  return {
    sub: String(payload.sub ?? ""),
    clientId,
    tokenUse: tokenUse as "access" | "id",
    scopes,
    claims: payload
  };
}
