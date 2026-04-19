import { Router, type Request, type Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { inMemoryStores, type CognitoTokenResponse, type Stores } from "./stores.js";

/**
 * OAuth 2.1 endpoints for the MCP authorization server.
 *
 * The MCP server acts as its own AS to MCP clients (Claude desktop, Claude.ai),
 * and as an OAuth client to Cognito upstream. This lets MCP clients register
 * their own dynamic loopback redirect URIs via RFC 7591 DCR, while we talk to
 * Cognito using a single static redirect URI that is pre-registered in Cognito.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   POST /oauth/register                         (RFC 7591 DCR)
 *   GET  /oauth/authorize                        (browser-initiated, 302 → Cognito)
 *   GET  /oauth/callback                         (Cognito redirects here, 302 → client)
 *   POST /oauth/token                            (authorization_code | refresh_token)
 *   POST /oauth/revoke                           (forwarded to Cognito)
 */
export function oauthRouter(stores: Stores = inMemoryStores()): Router {
  const r = Router();
  const e = env();
  const scopesSupported = e.COGNITO_SCOPES.split(/\s+/).filter(Boolean);
  const ourCallback = `${e.PUBLIC_BASE_URL}/oauth/callback`;

  // ---- Metadata (discovery) ----------------------------------------------

  r.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: e.PUBLIC_BASE_URL,
      authorization_servers: [e.PUBLIC_BASE_URL],
      bearer_methods_supported: ["header"],
      scopes_supported: scopesSupported
    });
  });

  r.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer: e.PUBLIC_BASE_URL,
      authorization_endpoint: `${e.PUBLIC_BASE_URL}/oauth/authorize`,
      token_endpoint:         `${e.PUBLIC_BASE_URL}/oauth/token`,
      registration_endpoint:  `${e.PUBLIC_BASE_URL}/oauth/register`,
      revocation_endpoint:    `${e.PUBLIC_BASE_URL}/oauth/revoke`,
      scopes_supported: scopesSupported,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"]
    });
  });

  // ---- /oauth/register (RFC 7591) ----------------------------------------
  // TODO: add IP rate-limit. The MAX_CLIENTS cap in stores.ts is a backstop.

  r.post("/oauth/register", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = body.redirect_uris;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be a non-empty array"
      });
    }

    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
        return res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: "redirect_uris must be https or loopback http (localhost / 127.0.0.1)"
        });
      }
    }

    const client = await stores.clients.create({
      redirect_uris: redirectUris as string[],
      client_name: typeof body.client_name === "string" ? body.client_name : undefined
    });

    logger.info(
      { client_id: client.client_id, client_name: client.client_name, redirect_uris: client.redirect_uris },
      "DCR: client registered"
    );

    res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    });
  });

  // ---- /oauth/authorize (browser initiates) ------------------------------

  r.get("/oauth/authorize", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const clientId           = q.client_id;
    const redirectUri        = q.redirect_uri;
    const responseType       = q.response_type;
    const codeChallenge      = q.code_challenge;
    const codeChallengeMethod = (q.code_challenge_method ?? "S256") as string;
    const state              = q.state;
    const scope              = q.scope;

    if (!clientId)                        return res.status(400).send("missing client_id");
    if (!redirectUri)                     return res.status(400).send("missing redirect_uri");
    if (responseType !== "code")          return res.status(400).send("unsupported response_type (must be 'code')");
    if (!codeChallenge)                   return res.status(400).send("code_challenge required (PKCE is mandatory)");
    if (codeChallengeMethod !== "S256")   return res.status(400).send("only S256 code_challenge_method is supported");

    const client = await stores.clients.get(clientId);
    if (!client) return res.status(400).send("unknown client_id (was it registered via /oauth/register?)");
    if (!client.redirect_uris.includes(redirectUri)) {
      logger.warn({ clientId, redirectUri, registered: client.redirect_uris }, "redirect_uri not registered");
      return res.status(400).send("redirect_uri not registered for this client");
    }
    await stores.clients.touch(clientId);

    // Our own PKCE for the upstream (Cognito) leg.
    const ourVerifier  = randomBytes(32).toString("base64url");
    const ourChallenge = createHash("sha256").update(ourVerifier).digest("base64url");
    const ourState     = randomBytes(16).toString("base64url");

    await stores.pending.put(ourState, {
      client_id: clientId,
      claude_redirect_uri: redirectUri,
      claude_state: state,
      claude_code_challenge: codeChallenge,
      claude_code_challenge_method: "S256",
      our_cognito_verifier: ourVerifier,
      requested_scope: scope,
      created_at: Date.now()
    });

    const target = new URL(`${e.COGNITO_HOSTED_UI_DOMAIN}/oauth2/authorize`);
    target.searchParams.set("client_id", e.COGNITO_CLIENT_ID);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("redirect_uri", ourCallback);
    target.searchParams.set("scope", scope && scope.length > 0 ? scope : e.COGNITO_SCOPES);
    target.searchParams.set("code_challenge", ourChallenge);
    target.searchParams.set("code_challenge_method", "S256");
    target.searchParams.set("state", ourState);

    logger.debug({ clientId, redirectUri, ourState }, "authorize → Cognito");
    res.redirect(302, target.toString());
  });

  // ---- /oauth/callback (Cognito → us) ------------------------------------

  r.get("/oauth/callback", async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    const ourState = q.state;
    const cogCode  = q.code;
    const cogError = q.error;
    const cogErrDesc = q.error_description;

    if (!ourState) return res.status(400).send("missing state");
    const pending = await stores.pending.take(ourState);
    if (!pending) return res.status(400).send("invalid or expired state");

    const clientRedirect = new URL(pending.claude_redirect_uri);
    if (pending.claude_state) clientRedirect.searchParams.set("state", pending.claude_state);

    if (cogError) {
      logger.warn({ cogError, cogErrDesc }, "Cognito returned OAuth error");
      clientRedirect.searchParams.set("error", cogError);
      if (cogErrDesc) clientRedirect.searchParams.set("error_description", cogErrDesc);
      return res.redirect(302, clientRedirect.toString());
    }
    if (!cogCode) {
      clientRedirect.searchParams.set("error", "server_error");
      clientRedirect.searchParams.set("error_description", "no code from authorization server");
      return res.redirect(302, clientRedirect.toString());
    }

    // Exchange Cognito code for Cognito tokens using our own verifier.
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: e.COGNITO_CLIENT_ID,
      code: cogCode,
      redirect_uri: ourCallback,
      code_verifier: pending.our_cognito_verifier
    });

    let cognitoTokens: CognitoTokenResponse;
    try {
      const resp = await fetch(`${e.COGNITO_HOSTED_UI_DOMAIN}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString()
      });
      const text = await resp.text();
      if (!resp.ok) {
        logger.error({ status: resp.status, body: text }, "Cognito token exchange failed");
        clientRedirect.searchParams.set("error", "server_error");
        clientRedirect.searchParams.set("error_description", "upstream token exchange failed");
        return res.redirect(302, clientRedirect.toString());
      }
      cognitoTokens = JSON.parse(text) as CognitoTokenResponse;
    } catch (err) {
      logger.error({ err }, "Cognito token exchange threw");
      clientRedirect.searchParams.set("error", "server_error");
      return res.redirect(302, clientRedirect.toString());
    }

    // Mint our own one-time code that binds Claude's PKCE to the Cognito tokens.
    const ourCode = randomBytes(32).toString("base64url");
    await stores.codes.put(ourCode, {
      client_id: pending.client_id,
      cognito_tokens: cognitoTokens,
      claude_code_challenge: pending.claude_code_challenge,
      claude_code_challenge_method: pending.claude_code_challenge_method,
      created_at: Date.now()
    });

    clientRedirect.searchParams.set("code", ourCode);
    logger.debug({ client_id: pending.client_id, redirect: pending.claude_redirect_uri }, "callback → client redirect");
    res.redirect(302, clientRedirect.toString());
  });

  // ---- /oauth/token ------------------------------------------------------

  r.post("/oauth/token", async (req: Request, res: Response) => {
    const body = normaliseBody(req.body);
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const code         = body.code;
      const codeVerifier = body.code_verifier;
      const clientId     = body.client_id;

      if (!code || !codeVerifier || !clientId) {
        return res.status(400).json({ error: "invalid_request", error_description: "code, code_verifier, client_id required" });
      }

      const issued = await stores.codes.take(code);
      if (!issued) {
        return res.status(400).json({ error: "invalid_grant", error_description: "code is invalid or expired" });
      }
      if (issued.client_id !== clientId) {
        return res.status(400).json({ error: "invalid_grant", error_description: "client mismatch" });
      }

      const computed = createHash("sha256").update(codeVerifier).digest("base64url");
      if (computed !== issued.claude_code_challenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }

      // Hand Cognito's tokens through verbatim. Claude uses the access_token
      // directly against /mcp; our jwtVerify.ts validates it via Cognito JWKS.
      return res.json(issued.cognito_tokens);
    }

    if (grantType === "refresh_token") {
      // Forward to Cognito. Public client → no client_secret.
      const params = new URLSearchParams();
      params.set("grant_type", "refresh_token");
      params.set("client_id", e.COGNITO_CLIENT_ID);
      if (body.refresh_token) params.set("refresh_token", body.refresh_token);
      if (body.scope)         params.set("scope", body.scope);

      const resp = await fetch(`${e.COGNITO_HOSTED_UI_DOMAIN}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });
      const text = await resp.text();
      return res
        .status(resp.status)
        .type(resp.headers.get("content-type") ?? "application/json")
        .send(text);
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  // ---- /oauth/revoke (forwarded) -----------------------------------------

  r.post("/oauth/revoke", async (req: Request, res: Response) => {
    const body = normaliseBody(req.body);
    const params = new URLSearchParams();
    if (body.token)            params.set("token", body.token);
    if (body.token_type_hint)  params.set("token_type_hint", body.token_type_hint);
    params.set("client_id", e.COGNITO_CLIENT_ID);

    try {
      const resp = await fetch(`${e.COGNITO_HOSTED_UI_DOMAIN}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });
      const text = await resp.text();
      return res.status(resp.status).type(resp.headers.get("content-type") ?? "application/json").send(text);
    } catch (err) {
      logger.error({ err }, "Cognito revoke failed");
      return res.status(502).json({ error: "upstream_error" });
    }
  });

  return r;
}

// -- helpers ---------------------------------------------------------------

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Accept either application/x-www-form-urlencoded (the OAuth standard) or
 * application/json. Express parses both into `req.body` as an object.
 */
function normaliseBody(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
