# Authorization in this MCP server — full mental model

## 1. The three players

| Actor | Role | Where |
|---|---|---|
| **Claude agent** (Claude Desktop / claude.ai) | OAuth 2.1 **client** — PKCE, dynamic registration, token requests | Remote |
| **This server** (`gp-mcp-server`) | Dual role: **Authorization Server** + **Resource Server** to Claude; **OAuth client** to Cognito | [../src/index.ts](../src/index.ts), [../src/auth/oauth.ts](../src/auth/oauth.ts) |
| **AWS Cognito** | The real IdP — owns users, JWKS, and issues the JWTs that protect `/mcp` | Remote |

The key asymmetry, explained at [oauth.ts:8-14](../src/auth/oauth.ts#L8-L14):
Cognito only accepts **one pre-registered redirect URI**, but MCP clients invent their own loopback redirect URIs at runtime (RFC 7591 DCR). So this server **sits in the middle** — it exposes DCR to Claude, but speaks to Cognito with a single static callback `${PUBLIC_BASE_URL}/oauth/callback` ([oauth.ts:28](../src/auth/oauth.ts#L28)).

## 2. End-to-end flow (what Claude actually does)

```
┌─ Step 0 : Claude hits /mcp with no token ────────────────────────┐
│ Server → 401 + WWW-Authenticate: Bearer resource_metadata="..."  │
│ (index.ts:140-146)                                               │
└──────────────────────────────────────────────────────────────────┘
              │
┌─ Step 1 : Discovery (RFC 9728 → RFC 8414) ───────────────────────┐
│ GET /.well-known/oauth-protected-resource   (oauth.ts:32-39)     │
│   → { authorization_servers: [PUBLIC_BASE_URL], ... }            │
│ GET /.well-known/oauth-authorization-server (oauth.ts:41-54)     │
│   → endpoints + { token_endpoint_auth_methods_supported:["none"] │
│                   code_challenge_methods_supported:["S256"] }    │
└──────────────────────────────────────────────────────────────────┘
              │
┌─ Step 2 : Dynamic Client Registration (RFC 7591) ────────────────┐
│ POST /oauth/register                         (oauth.ts:59-98)    │
│   body: { redirect_uris:["http://127.0.0.1:33418/callback"] }    │
│   → 201 { client_id: "mcp_<base64url>", redirect_uris, ... }     │
│ Stored in InMemoryClientStore (stores.ts:74-113), TTL 30 days    │
└──────────────────────────────────────────────────────────────────┘
              │
┌─ Step 3 : Browser-initiated authorize ───────────────────────────┐
│ GET /oauth/authorize?client_id=mcp_...&redirect_uri=...          │
│     &response_type=code&code_challenge=<Claude's>                │
│     &code_challenge_method=S256&state=<Claude's>&scope=...       │
│                                              (oauth.ts:102-153)  │
│                                                                  │
│ Server stores PendingAuth (stores.ts:13-22) keyed by ourState:   │
│   - claude_redirect_uri, claude_state, claude_code_challenge     │
│   - our_cognito_verifier   ← brand-new PKCE pair we just made    │
│                                                                  │
│ 302 → Cognito Hosted UI with OUR challenge + ourState            │
└──────────────────────────────────────────────────────────────────┘
              │
            user logs in at Cognito
              │
┌─ Step 4 : Cognito → us ──────────────────────────────────────────┐
│ GET /oauth/callback?code=<cogCode>&state=<ourState>              │
│                                              (oauth.ts:157-226)  │
│  1. take(ourState) from PendingStore                             │
│  2. POST Cognito /oauth2/token with OUR verifier → Cognito tokens│
│  3. Mint ourCode, store IssuedCode (stores.ts:33-39):            │
│       { cognito_tokens, claude_code_challenge }                  │
│  4. 302 → claude_redirect_uri?code=<ourCode>&state=<claudeState> │
└──────────────────────────────────────────────────────────────────┘
              │
┌─ Step 5 : Claude exchanges code for tokens ──────────────────────┐
│ POST /oauth/token                            (oauth.ts:230-282)  │
│   grant_type=authorization_code                                  │
│   code=<ourCode>&code_verifier=<Claude's>&client_id=mcp_...      │
│                                                                  │
│   codes.take(code)  → single-use (stores.ts:138-144)             │
│   SHA256(verifier) === stored challenge  ? (PKCE check)          │
│   client_id match   ?                                            │
│   → respond with Cognito's token response VERBATIM               │
└──────────────────────────────────────────────────────────────────┘
              │
┌─ Step 6 : Claude calls /mcp with Bearer <access_token> ──────────┐
│ index.ts:97-138                                                  │
│   verifyCognitoToken(token)     ← jose + Cognito JWKS            │
│     - issuer = cognito authority                                 │
│     - client_id claim === COGNITO_CLIENT_ID                      │
│     - token_use ∈ {access,id}                                    │
│   Then create or reuse MCP session keyed by mcp-session-id       │
└──────────────────────────────────────────────────────────────────┘
```

## 3. The **double PKCE** — the trick that makes this safe

Two independent PKCE legs run concurrently:

| Leg | Verifier | Challenge seen by | Where |
|---|---|---|---|
| Claude ↔ our server | Claude's `code_verifier` | stored in `IssuedCode.claude_code_challenge` | [oauth.ts:218](../src/auth/oauth.ts#L218), verified [oauth.ts:251-254](../src/auth/oauth.ts#L251-L254) |
| Our server ↔ Cognito | `our_cognito_verifier` (we generate at [oauth.ts:127](../src/auth/oauth.ts#L127)) | sent to Cognito as `code_challenge` in authorize step | stored in `PendingAuth` [oauth.ts:137](../src/auth/oauth.ts#L137), replayed at [oauth.ts:189](../src/auth/oauth.ts#L189) |

Claude never sees the Cognito verifier; Cognito never sees Claude's challenge. That's what lets a public DCR client safely tunnel through a single pre-registered Cognito app.

## 4. State stores & TTLs ([stores.ts:69-72](../src/auth/stores.ts#L69-L72))

| Store | TTL | Semantics | Rationale |
|---|---|---|---|
| `ClientStore` | 30 days, sliding via `touch()` | `get`/`create`/`touch`; LRU-evicts at 10k clients | DCR clients that haven't been used in a month are garbage |
| `PendingStore` | 5 min | `take()` = get-and-delete | Spans user's login at Cognito; can't be too short |
| `CodeStore` | 60 sec | `take()` = get-and-delete, single-use | OAuth 2.1 §4.1.3 — authorization codes must be one-shot |

All three stores are `Map` instances — **process-local, non-persistent**. Restart the server and every DCR client / pending auth / issued code is gone ([stores.ts:74-145](../src/auth/stores.ts#L74-L145)).

## 5. Token verification at `/mcp` ([jwtVerify.ts](../src/auth/jwtVerify.ts))

```ts
jwks = createRemoteJWKSet(cognitoAuthority + "/.well-known/jwks.json")  // cached by jose

jwtVerify(token, jwks, { issuer: cognitoAuthority() })   // signature + iss + exp
  - token_use ∈ {access, id}                             // reject refresh/id-bad
  - payload.client_id === COGNITO_CLIENT_ID              // manual aud check
```

Why the manual `client_id` check? Cognito access tokens don't carry a consistent `aud` claim, so the comment at [jwtVerify.ts:23](../src/auth/jwtVerify.ts#L23) explains validation is moved to `client_id`.

## 6. Session layer (after token is verified)

[index.ts:63-95](../src/index.ts#L63-L95). An `McpServer` + `StreamableHTTPServerTransport` is created on the first `InitializeRequest` for a given Bearer token. The `mcp-session-id` header (generated by `randomUUID`) keys subsequent requests. On every request the `userToken` is refreshed on the session ([index.ts:134](../src/index.ts#L134)) — **short-lived Cognito access token, long-lived MCP session**. Stale `mcp-session-id` → 404, chosen deliberately over 400 because clients retry 404s and don't retry 400s ([index.ts:118-131](../src/index.ts#L118-L131)).

## 7. Security posture — what's solid vs what's thin

### Solid
- **PKCE mandatory on both legs**; only `S256` accepted ([oauth.ts:52](../src/auth/oauth.ts#L52), [oauth.ts:115-116](../src/auth/oauth.ts#L115-L116)).
- **Public client** (`token_endpoint_auth_methods_supported: ["none"]`) — correct for DCR'd loopback clients.
- **Redirect URI allowlist check at DCR time and at authorize time** ([oauth.ts:70-77](../src/auth/oauth.ts#L70-L77) + [oauth.ts:120](../src/auth/oauth.ts#L120)) — prevents redirect-URI substitution.
- **Codes are single-use**, 60-second TTL.
- **JWKS verification** + issuer + client_id pinned.
- **401 with RFC 9728 `resource_metadata` pointer** so Claude discovers the AS automatically ([index.ts:140-146](../src/index.ts#L140-L146)).
- **Claude's original `state` echoed back unchanged** ([oauth.ts:169](../src/auth/oauth.ts#L169)) — CSRF protection preserved.

### Gaps (deployment-blocking or near-blocking)

| # | Gap | Where | Severity |
|---|---|---|---|
| 1 | **In-memory stores only** — server restart invalidates every DCR client and every pending auth. Also fails horizontally: with >1 instance behind the ALB, a user can register on instance A and authorize on instance B with no shared state. | [stores.ts:147-153](../src/auth/stores.ts#L147-L153) | Blocker for multi-instance or rolling deploys |
| 2 | **No rate limit on `/oauth/register`** — publicly reachable DCR endpoint. The `MAX_CLIENTS=10000` cap is a backstop, not a defense. | TODO at [oauth.ts:57](../src/auth/oauth.ts#L57) | High — classic DoS / registration-flood vector |
| 3 | **`CORS_ALLOWED_ORIGINS` defaults to `"*"`** and `/mcp` is in the CORS surface. For production this must be the explicit Claude origin(s). | [env.ts:21](../src/lib/env.ts#L21), [index.ts:37-46](../src/index.ts#L37-L46) | High if unset in prod |
| 4 | **Redirect URI validator gaps**: no IPv6 loopback `[::1]` (RFC 8252 says accept), no fragment rejection (RFC 6749 §3.1.2), no per-registration count cap. | [oauth.ts:312-321](../src/auth/oauth.ts#L312-L321) | Medium |
| 5 | **PKCE method hard-assumed `S256`** when stored as `IssuedCode.claude_code_challenge_method` ([oauth.ts:219](../src/auth/oauth.ts#L219)) even though the authorize handler already accepts any incoming value before defaulting. Current check at [oauth.ts:116](../src/auth/oauth.ts#L116) does reject non-S256, so this is consistent — but a future relaxation of that check would silently mismatch. | [oauth.ts:116](../src/auth/oauth.ts#L116) | Low, latent |
| 6 | **Cognito token exchange body is logged only on failure** but the logged `text` may contain an error response containing `code` values. Low risk but worth scrubbing. | [oauth.ts:201](../src/auth/oauth.ts#L201) | Low |
| 7 | **`/oauth/revoke` forwards blindly** without verifying the caller owns the token. That's how Cognito's revocation endpoint works anyway (public clients use `client_id`), but any holder of a refresh_token can revoke it — expected but worth noting. | [oauth.ts:286-305](../src/auth/oauth.ts#L286-L305) | By design |
| 8 | **No `aud` enforcement on access tokens** — mitigated by checking `client_id`, but if another app in the same Cognito pool ever mints tokens with the same client_id, they'd be accepted. | [jwtVerify.ts:21-34](../src/auth/jwtVerify.ts#L21-L34) | Low given single-client pool |
| 9 | **Scope surface not enforced per-tool** — any valid access token passes `/mcp`. Tools don't gate on `scopes` from the JWT. | [index.ts:97-138](../src/index.ts#L97-L138) | Medium if some tools should be scope-gated |
| 10 | **`PendingAuth.claude_state` is optional** — a client that omits `state` gets no CSRF binding on the callback leg. OAuth 2.1 recommends requiring it. | [stores.ts:16](../src/auth/stores.ts#L16), [oauth.ts:109](../src/auth/oauth.ts#L109) | Low–medium |

## 8. Reference map (files to re-read, in order)

1. [src/lib/env.ts](../src/lib/env.ts) — the vocabulary: what `PUBLIC_BASE_URL`, `COGNITO_CLIENT_ID`, `COGNITO_HOSTED_UI_DOMAIN` mean.
2. [src/auth/stores.ts](../src/auth/stores.ts) — the shape of persisted state (`RegisteredClient`, `PendingAuth`, `IssuedCode`). TTLs at [stores.ts:69-72](../src/auth/stores.ts#L69-L72).
3. [src/auth/oauth.ts](../src/auth/oauth.ts) — every OAuth endpoint, in the order a request touches them.
4. [src/auth/jwtVerify.ts](../src/auth/jwtVerify.ts) — where Cognito JWTs meet our `/mcp` guard.
5. [src/index.ts](../src/index.ts) — request pipeline: CORS → `/health` → `oauthRouter()` → `/mcp` with JWT + session.

## 9. One-sentence summary

The server is an OAuth 2.1 **AS bridge** that exposes DCR + PKCE to Claude on the outside while presenting as a single pre-registered public PKCE client to Cognito on the inside; Claude receives Cognito's real access token verbatim and uses it as a Bearer at `/mcp`, where this server verifies it against Cognito's JWKS before opening an MCP streaming session.

The architecture is correct for OAuth 2.1 + MCP spec. **Before production**, the three items that would give me pause are: (1) persistent stores, (2) the rate limit TODO, (3) the permissive CORS default.
