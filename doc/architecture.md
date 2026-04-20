# Architecture — the one-pager

`gp-mcp-server` is a Model Context Protocol server that lets Claude call the HaloRunner .NET API safely, with PII stripped before anything reaches Claude.

## The whole system, one diagram

```
┌──────────────────┐          ┌────────────────────────────────────────────────┐
│ Claude           │          │  AWS account 702767218796 / ap-southeast-2     │
│ (Desktop / Web)  │          │                                                │
│                  │ HTTPS    │  ┌────────┐   ┌─────┐   ┌────────────────────┐ │
│  OAuth 2.1 +     │─────────▶│  │ WAFv2  │──▶│ ALB │──▶│ Fargate task       │ │
│  PKCE + DCR      │          │  └────────┘   └─────┘   │ gp-mcp-server      │ │
│  client          │          │                         │ (Node 22 / TS)     │ │
│                  │◀─────────│                         │                    │ │
└──────────────────┘  JSON    │                         │ ┌────────────────┐ │ │
         ▲                    │                         │ │ Express + MCP  │ │ │
         │ OAuth              │                         │ │ SDK            │ │ │
         ▼                    │                         │ │                │ │ │
┌──────────────────┐          │                         │ │ • OAuth router │ │ │
│ Cognito          │◀─────────│                         │ │ • /mcp + auth  │ │ │
│ User Pool +      │          │                         │ │ • Tool registry│ │ │
│ Hosted UI        │─────────▶│                         │ │ • Redactor     │ │ │
│                  │          │                         │ └────────────────┘ │ │
└──────────────────┘          │                         └──┬─────┬──────┬────┘ │
                              │                            │     │      │      │
                              │         ┌──────────────────┘     │      │      │
                              │         ▼                        ▼      ▼      │
                              │  ┌──────────────┐      ┌──────────────┐        │
                              │  │ DynamoDB × 3 │      │ Secrets Mgr  │        │
                              │  │ (OAuth state)│      │ (boot config)│        │
                              │  └──────────────┘      └──────────────┘        │
                              │                                                │
                              │  ECR: gp-mcp-server image repo                 │
                              │  CloudWatch: /ecs/staging-gp-mcp logs          │
                              │  Route 53: mcp-staging.ygpapp.com alias → ALB  │
                              │  ACM: TLS cert for the above                   │
                              └────────────────────────────────────┬───────────┘
                                                                   │
                                                                   ▼ HTTPS
                                                       ┌──────────────────────┐
                                                       │ HaloRunner .NET API  │
                                                       │ (API Gateway → EB)   │
                                                       │ api.staging.         │
                                                       │ ygpapp.com           │
                                                       └──────────────────────┘
```

## Request lifecycle (simplified)

```
1. Claude calls a tool  →  POST /mcp with JSON-RPC body + Bearer JWT
2. ALB → Fargate → Express checks JWT signature via Cognito JWKS
3. MCP SDK routes to the right tool handler
4. Handler calls .NET API with user's token forwarded
5. .NET responds with full data (including PII)
6. Redactor strips PII per tools.json rules
7. Response wrapped in JSON-RPC and returned to Claude
```

Full walkthrough: [pipeline.md](pipeline.md).

## Authentication flow (simplified)

```
First-time connect:
  Claude  ─────▶  GET  /.well-known/oauth-authorization-server   (discover)
  Claude  ─────▶  POST /oauth/register                            (DCR, get client_id)
  Browser ─────▶  GET  /oauth/authorize                           (302 to Cognito)
  User    ─────▶  logs in at Cognito Hosted UI
  Cognito ─────▶  /oauth/callback?code=…                          (back to MCP)
  MCP     ─────▶  swaps code for Cognito tokens (server-to-server)
  MCP     ─────▶  302 back to Claude with MCP's one-time code
  Claude  ─────▶  POST /oauth/token                               (final exchange)
  Claude  ◀────   Cognito's access_token + refresh_token

Every subsequent /mcp call:
  Claude  ─────▶  POST /mcp with Authorization: Bearer <cognito-jwt>
```

Full RFC-level walkthrough: [authorization.md](authorization.md).

## Core components

| Layer | What it does | Code location |
|---|---|---|
| **Express HTTP server** | Routing, CORS, JWT gate | [src/index.ts](../src/index.ts) |
| **OAuth router** | Discovery, DCR, authorize, callback, token, revoke | [src/auth/oauth.ts](../src/auth/oauth.ts) |
| **JWT verifier** | Validates Cognito tokens via JWKS | [src/auth/jwtVerify.ts](../src/auth/jwtVerify.ts) |
| **OAuth state store** | DCR clients + pending auths + codes; pluggable memory/DynamoDB | [src/auth/stores.ts](../src/auth/stores.ts) + [stores.dynamo.ts](../src/auth/stores.dynamo.ts) |
| **Tool registry** | Turns [tools.json](../src/config/tools.json) into live MCP tool handlers | [src/services/toolRegistry.ts](../src/services/toolRegistry.ts) |
| **Upstream client** | Calls the .NET API with the user's forwarded token | [src/services/apiClient.ts](../src/services/apiClient.ts) |
| **Redactor** | Walks responses, replaces pii-flagged fields with `"REDACTED"`, drops undeclared fields | [src/middleware/redact.ts](../src/middleware/redact.ts) |
| **Secrets loader** | Pulls Cognito client ID etc. from AWS Secrets Manager at boot | [src/lib/secrets.ts](../src/lib/secrets.ts) |

## Security boundaries

| | Trusts | Trusted by |
|---|---|---|
| Claude | Cognito JWKS | MCP server (as a registered DCR client) |
| MCP server | Cognito JWKS | Claude (via its OAuth metadata); .NET API (via forwarded JWT) |
| Cognito | Itself | MCP, dashboard, all YGP frontends |
| .NET API | Cognito JWKS | MCP server (verifies same JWT Claude presented) |
| AWS | Terraform user; GitHub OIDC | Infrastructure operations |

PII never leaves AWS unredacted. The redactor runs server-side before the response reaches Claude.

## State

| Kind | Where | TTL |
|---|---|---|
| DCR client registrations | DynamoDB `staging-mcp-clients` | 30 days sliding |
| Pending OAuth flows | DynamoDB `staging-mcp-pending-auths` | 5 min |
| One-time codes | DynamoDB `staging-mcp-codes` | 60 sec |
| MCP session map | In-process only (per Fargate task) | Until session close or task restart |
| Secrets | AWS Secrets Manager | Rotated via Secrets Manager rotation |
| Container images | AWS ECR | Last 20 retained |
| Logs | CloudWatch Logs `/ecs/staging-gp-mcp` | 30 days |

The in-process session map is why `desired_count = 1` — scaling to 2+ would split sessions. Moving that to DynamoDB is tracked in [security-todo.md](security-todo.md#tier-a6--dynamodb-backed-mcp-session-store-required-to-return-to-ha).

## CI/CD

```
git push main
  ↓
GitHub Actions (deploy-staging.yml)
  ├─ npm ci + typecheck + test                 (in the runner)
  ├─ AssumeRoleWithWebIdentity via OIDC        (no stored creds)
  ├─ docker build + push to ECR
  ├─ render task definition with new image SHA
  └─ ecs update-service → rolling deploy
  ↓
Fargate serves the new image after ALB health check passes
```

No long-lived AWS credentials anywhere. Trust is established via GitHub's OIDC provider registered in our AWS account.

## Environments

| | `local` (dev) | `staging` |
|---|---|---|
| Where | your laptop | AWS Fargate in ap-southeast-2 |
| Storage | in-memory Maps | DynamoDB |
| Public URL | `http://localhost:3000` | `https://mcp-staging.ygpapp.com` |
| Upstream API | `https://localhost:53714` (direct) | `https://api.staging.ygpapp.com` (via API GW → EB) |
| Cognito | same pool (`ap-southeast-2_7AEltCLXS`) | same pool |
| Secrets | `.env.local` | Secrets Manager |
| Auth hardening | permissive CORS, dev-only TLS skips | strict CORS, prod-invariants asserted at boot |

Production doesn't exist yet — the plan is to clone the Terraform in `infra/terraform/` with a new CIDR + hostname + secret, when the staging pilot is validated.

## See also

- [pipeline.md](pipeline.md) — full request lifecycle with code references
- [authorization.md](authorization.md) — OAuth flow in RFC detail
- [production-hardening.md](production-hardening.md) — what security measures are in place
- [security-todo.md](security-todo.md) — what security measures still need to land
