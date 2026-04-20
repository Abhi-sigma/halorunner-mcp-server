# Production hardening — what's in place

Five pieces of hardening land between the "initial commit" prototype and the first real deploy. This doc explains what each one does, how it's configured, and how to back it out if you need to.

Sister docs:
- [pipeline.md](pipeline.md) — how a request flows end-to-end
- [security-todo.md](security-todo.md) — what's still outstanding

---

## 1. CORS lockdown + production invariants

**Problem** — the default `CORS_ALLOWED_ORIGINS=*` in [src/lib/env.ts](../src/lib/env.ts) is fine for local dev, lethal in prod. A wildcard lets any website (including a compromised one the user visits in the same browser) make credentialed-style requests against `/mcp`.

**What we do now** — [src/lib/env.ts](../src/lib/env.ts) runs `assertProductionInvariants()` on boot. When `NODE_ENV ∈ {staging, production}` it refuses to start if:
- `CORS_ALLOWED_ORIGINS` is `*` or empty.
- Any origin doesn't start with `https://`.
- `STORE_DRIVER=memory` is set (see §4).
- `STORE_DRIVER=dynamo` but any `DDB_*_TABLE` env var is missing.

**How to configure**

```
# staging or production:
CORS_ALLOWED_ORIGINS=https://claude.ai,https://app.claude.ai
```

**Rollback** — delete the `assertProductionInvariants()` call at [env.ts:32](../src/lib/env.ts#L32). Not recommended; rebuild-time dependency is what makes this guard load-bearing.

---

## 2. Upstream error-log hygiene

**Problem** — [src/services/apiClient.ts](../src/services/apiClient.ts) originally logged up to 2000 chars of the upstream error body. If the .NET API ever echoed request parameters back in an exception message (e.g. `"Patient with mobile +61... not found"`), those parameters landed in CloudWatch. CloudWatch logs are often accessible to more engineers than the production database — a lateral leak path.

**What we do now** — [apiClient.ts:94-106](../src/services/apiClient.ts#L94-L106) replaces the body with:

```
bodyHash: sha256(body).slice(0, 12)   ← 12-char hex prefix
bodyLength: body.length
```

The hash lets you **correlate** repeated identical errors without exposing content. To actually **diagnose**, pivot via the request log `tool`, `status`, `ms` into the .NET API's own (separately access-controlled) logs — they carry the real stack trace.

**Tradeoff** — you can't decode the hash. If you need to read error bodies directly from MCP logs, switch to extracting only .NET `ProblemDetails` fields (`title`, `type`, `status`, `traceId`) via a small extractor. Left as future work.

**Rollback** — put the old `body: text.slice(0, 2000)` line back. Safe only if you know .NET's `DeveloperExceptionPage` middleware is disabled in every env that shares this log group.

---

## 3. Rate limit on `/oauth/register`

**Problem** — DCR is a public endpoint with no authentication (by design — it's how a new client gets a `client_id`). Without a rate limit, an attacker can flood it: 10k registrations → `MAX_CLIENTS` kicks in and evicts legitimate entries via LRU. Real users start getting "unknown client_id" and have to re-register on every session.

**What we do now** — [src/middleware/rateLimit.ts](../src/middleware/rateLimit.ts) provides an in-process fixed-window limiter, applied only to `/oauth/register`:

```
windowMs: 60 * 60 * 1000    → 1 hour window
max: 10                     → 10 registrations per IP per hour
```

Rationale: real Claude clients register *once* and cache the `client_id` for 30 days. Anything above single-digit hourly DCR hits per IP is almost certainly hostile traffic.

Bounded memory: the rate-limiter's own Map is capped at 10 000 tracked IPs with LRU eviction ([rateLimit.ts:54-66](../src/middleware/rateLimit.ts#L54-L66)), so the defence can't itself be used as a memory exhaustion vector.

**`trust proxy` is required** — [src/index.ts:40](../src/index.ts#L40) sets `app.set("trust proxy", 1)`. Without this, `req.ip` is the ALB's IP and the limiter collapses into a single global counter.

**Configure** — no env vars; tuning is in-code. If you need different limits, edit the `rateLimit({ windowMs, max })` call in [oauth.ts:62](../src/auth/oauth.ts#L62).

**Limitation** — per-process only. Running N instances means N × limit effective ceiling. Good enough at our scale; for multi-node accuracy, swap the `Map` for Redis or DynamoDB (same interface).

**Rollback** — delete the `registerLimiter` argument from the `/oauth/register` route.

---

## 4. DynamoDB stores (`STORE_DRIVER=dynamo`)

**Problem** — the in-memory `ClientStore` / `PendingStore` / `CodeStore` in [stores.ts](../src/auth/stores.ts) don't survive restarts and can't be shared across instances. Every rolling deploy wipes every DCR registration. Multi-instance deploys (behind an ALB) break mid-OAuth-flow because the user can land on instance B after registering on instance A. See [authorization.md §7 gap #1](authorization.md).

**What we do now** — [src/auth/stores.dynamo.ts](../src/auth/stores.dynamo.ts) provides DynamoDB implementations of the same three interfaces. Driver is selected at boot:

```
STORE_DRIVER=memory    ← default; in-process Maps, single node only
STORE_DRIVER=dynamo    ← DynamoDB-backed, safe for multi-instance + restart
```

**Three tables** (see [stores.dynamo.ts:29-37](../src/auth/stores.dynamo.ts#L29-L37) for the full spec):

| Table | PK | TTL | Purpose |
|---|---|---|---|
| `mcp_clients` | `client_id` (S) | 30 days sliding | DCR registrations |
| `mcp_pending_auths` | `state` (S) | 5 min | Per-in-flight OAuth session |
| `mcp_codes` | `code` (S) | 60 sec | Authorization codes, single-use |

Native DynamoDB TTL is enabled on `ttl_epoch_s` (epoch seconds) on all three — DynamoDB deletes expired rows automatically within ~48 h. We double-check the timestamp in application code so the window between expiry and server-side delete doesn't leak.

**Atomic single-use via `DeleteItem ReturnValues: ALL_OLD`** — pending/codes `take()` deletes and returns the item in one call. DynamoDB guarantees at-most-one caller sees the row. Critical for OAuth code replay defence.

**Sliding TTL for clients** — `touch()` ([stores.dynamo.ts:85-99](../src/auth/stores.dynamo.ts#L85-L99)) updates both `last_used_at` and `ttl_epoch_s` on each OAuth authorize, so active users never expire while inactive ones roll off.

**Configure** — minimum four env vars:

```
STORE_DRIVER=dynamo
DDB_CLIENTS_TABLE=mcp_clients
DDB_PENDING_TABLE=mcp_pending_auths
DDB_CODES_TABLE=mcp_codes
```

Plus IAM on the ECS task role: `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` on the three tables. Region is inferred from `COGNITO_REGION` (same AWS region as the rest of the stack).

**Provisioning** (Terraform/CDK, not included here):
- Billing mode: `PAY_PER_REQUEST` — traffic is spiky and low volume.
- TTL attribute: `ttl_epoch_s` on all three tables.
- No indexes required — everything is PK lookup.

**Rollback** — set `STORE_DRIVER=memory` in dev, or delete the three DDB envs. In prod/staging the server refuses to boot with `memory`, so there's no accidental downgrade.

---

## 5. AWS Secrets Manager boot loader

**Problem** — Cognito IDs, `API_KEY`, and future secrets shouldn't live in ECS task definitions (visible to anyone with `ecs:DescribeTaskDefinition`) or `.env` files (rotation means redeploy). Secrets should live in a dedicated secret store that supports rotation and audit.

**What we do now** — [src/lib/secrets.ts](../src/lib/secrets.ts) provides `loadSecretsIntoEnv(secretId)`, called from [src/index.ts](../src/index.ts) **before** `env()` is first invoked. It:

1. Fetches the secret's `SecretString` (expected to be JSON: `{"KEY":"VALUE",...}`).
2. For each key, writes to `process.env` — but only if the key isn't already set.
3. Returns. Subsequent `env()` calls see the merged values.

**"Existing env vars win"** is deliberate: a developer can override one key locally (e.g. `API_BASE_URL=http://localhost:53714`) without editing the secret. Same behaviour in CI, where you might inject a test-only key.

**Configure** — optional in dev, recommended in staging/production:

```
SECRETS_MANAGER_SECRET_ID=arn:aws:secretsmanager:ap-southeast-2:...:secret:gp-mcp/prod-abc
```

Secret payload example:

```json
{
  "COGNITO_CLIENT_ID": "7c3delbo3qpf0n5ek1bu37itmc",
  "COGNITO_USER_POOL_ID": "ap-southeast-2_7AEltCLXS",
  "API_KEY": "…",
  "COGNITO_HOSTED_UI_DOMAIN": "https://…"
}
```

Plus IAM: `secretsmanager:GetSecretValue` on the secret ARN.

**Rotation strategy** — Secrets Manager supports scheduled rotation with Lambda. For `API_KEY` (upstream-issued), the Lambda rotates by calling the .NET side, getting a new key, writing both to the secret, then invalidating the old one. MCP pods pick up the new value on next restart (or ECS can trigger restart on secret change via EventBridge). Not included here; see [security-todo.md](security-todo.md).

**Rollback** — leave `SECRETS_MANAGER_SECRET_ID` unset. Boot path is a no-op. Fall back to env vars from ECS task definition or `.env`.

---

## Verifying the hardening

```
npm run typecheck     # type safety
npm test              # 28 redaction tests
```

Both should pass after every change.

**End-to-end sanity check after deploy**:
1. Boot with `NODE_ENV=staging` and `CORS_ALLOWED_ORIGINS=*` → server refuses to start.
2. Hit `/oauth/register` 11 times from the same IP in an hour → last one returns 429 with `Retry-After`.
3. `kill -9` an instance mid-OAuth-flow → user completes flow on a different instance without "invalid state". (Dynamo working.)
4. Cause an upstream 500 → confirm CloudWatch log has `bodyHash:` but NOT the body content.

---

## Summary table

| Feature | Env var(s) | Runtime dep | What it protects |
|---|---|---|---|
| CORS lockdown | `CORS_ALLOWED_ORIGINS` | — | Cross-origin auth leaks |
| Error-log hygiene | (always on) | — | PII in CloudWatch via upstream stack traces |
| Rate limit DCR | (in-code 10/h/IP) | — | Public registration endpoint flood |
| DynamoDB stores | `STORE_DRIVER`, `DDB_*_TABLE` | DynamoDB + IAM | Multi-instance safety, restart durability |
| Secrets loader | `SECRETS_MANAGER_SECRET_ID` | Secrets Manager + IAM | Secrets in task defs / env files |

All five are **boot-time additive** — no code path changes at request time, so rollback is a config flip.
