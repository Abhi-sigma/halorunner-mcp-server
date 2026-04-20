# Security TODO — remaining hardening

What's shipped so far lives in [production-hardening.md](production-hardening.md). This doc lists the work that **hasn't** been done, roughly ordered by how much risk it retires per hour of effort.

Sister docs:
- [authorization.md](authorization.md) — OAuth flow + gap inventory
- [pipeline.md](pipeline.md) — end-to-end request flow

---

## Tier A — do before any public pilot

These close real attack surface. Mostly small, each ≤ a day of work.

### A1. Scope-gate write tools

**Risk** — any valid Cognito access token currently lets a user call any tool — including the write-marked ones in [tools.json](../src/config/tools.json) (`"write": true`). Scopes exist in the JWT (`openid email phone profile`) but are never inspected.

**Proposed** — introduce a new Cognito scope `gp-mcp/write`. In [toolRegistry.ts:38](../src/services/toolRegistry.ts#L38), if `tool.write === true`, check the session's scopes. Fail with a JSON-RPC permission error otherwise.

```ts
// src/services/toolRegistry.ts
const session = getSession();
if (tool.write && !session.scopes.includes("gp-mcp/write")) {
  return { content: [{ type:"text", text: "missing required scope: gp-mcp/write" }], isError: true };
}
```

Requires threading `scopes` through `SessionContext` ([toolRegistry.ts:9-14](../src/services/toolRegistry.ts#L9-L14)) and extracting them in `verifyCognitoToken` (already done — see [jwtVerify.ts:36](../src/auth/jwtVerify.ts#L36)).

**Configure on the Cognito side** — add the resource server + scope, grant it only to staff who should be able to mutate data. Consent screen lists the scope during the OAuth flow.

---

### A1.3. Pin GitHub OIDC trust policy to immutable `repository_id`

**Risk** — trust policy at [infra/terraform/iam_github_oidc.tf:56-62](../infra/terraform/iam_github_oidc.tf#L56-L62) currently matches on `sub = repo:Abhi-sigma/halorunner-mcp-server:ref:refs/heads/main`. GitHub guarantees `owner/repo` names are unique **at any moment**, but not **over time**. If the `Abhi-sigma` org is ever renamed, deleted, or the account is reclaimed, someone else can create a repo at the same path and their workflow will present a JWT with the exact `sub` our trust policy accepts → they'd inherit deploy credentials to our AWS.

**Proposed** — add two StringEquals conditions on the immutable numeric IDs issued by GitHub at repo/owner creation. These IDs are never reused, even if the repo is deleted or the owner transferred:

```hcl
condition {
  test     = "StringEquals"
  variable = "token.actions.githubusercontent.com:repository_id"
  values   = ["<numeric repo ID>"]
}
condition {
  test     = "StringEquals"
  variable = "token.actions.githubusercontent.com:repository_owner_id"
  values   = ["<numeric owner ID>"]
}
```

Lookup:
```bash
gh api repos/Abhi-sigma/halorunner-mcp-server --jq '.id, .owner.id'
```

Or grab from a successful CloudTrail `AssumeRoleWithWebIdentity` event — the claims are in `userIdentity.webIdFederationData.attributes`.

**Effort** — 10 min (lookup + 2 hcl blocks + `terraform apply --no-session`).

---

### A1.5. Add `search_invoices` tool with date filter

**Gap** — current `list_recent_invoices` has no server-side date filter; only `limit`. Claude has to fetch-and-filter client-side, silently misses anything past the limit, and can't cleanly answer "invoices on 18 April".

**Proposed** — wrap the existing `.NET /api/Financial/payments/invoices/search` endpoint as a new MCP tool `search_invoices`. Parameters: `invoiceId?`, `patient?`, `invoiceDate?` (ISO `YYYY-MM-DD`), `status?`. Returns the same `PaymentInvoiceSummaryDto` shape as `list_recent_invoices`.

**Gotcha** — SQL Server's `TRY_CONVERT(date, …)` on the .NET side silently NULLs unparseable dates (returning the full list unfiltered). Add MCP-layer regex validation on `invoiceDate` (must match `^\d{4}-\d{2}-\d{2}$`) and return 400 to Claude if it doesn't. 4-line change.

**Effort** — 10 min.

---

### A2. `tools.json` coverage lint in CI

**Risk** — the redactor is strict (drops undeclared fields), but the tests in [redact.coverage.test.ts](../src/middleware/redact.coverage.test.ts) only prove the *declared* fields redact correctly. If the .NET API adds a new `ssn` field to a patient endpoint and [tools.json](../src/config/tools.json) isn't updated, that field is silently dropped — safe behaviour but undetected, and the operator would reasonably assume the tool hadn't gained new data. Worse: if someone later flips `strict_returns: false`, the leak is instant.

**Proposed** — a CI script that reads the .NET Swagger/OpenAPI spec and compares response schemas against each tool's declared `returns`. Flag:
- Upstream field not in tool returns → fail build.
- Tool returns field not in upstream → warn (may be a typo).

Can reuse [scripts/generate-tools-from-swagger.ts](../scripts/generate-tools-from-swagger.ts) as a starting point.

**Effort** — half a day. Output as a diff on PRs.

---

### A3. Redirect URI validator tightening

**Risk** — `isAllowedRedirectUri` at [oauth.ts:321-330](../src/auth/oauth.ts#L321-L330) has three gaps called out in [authorization.md gap #4](authorization.md#gaps-deployment-blocking-or-near-blocking):

- No IPv6 loopback `[::1]` — some Claude installs use it (RFC 8252 says accept).
- No fragment rejection — RFC 6749 §3.1.2 forbids fragments in redirect URIs, none checked.
- No per-registration cap — DCR request with 10 000 `redirect_uris` passes.

**Proposed**

```ts
function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash !== "") return false;                      // no fragments
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" &&
        (u.hostname === "localhost" ||
         u.hostname === "127.0.0.1" ||
         u.hostname === "[::1]" || u.hostname === "::1"))
      return true;
    return false;
  } catch { return false; }
}
```

Plus a cap in the register handler:

```ts
if (redirectUris.length > 10) { return 400 invalid_redirect_uri; }
```

**Effort** — 15 min.

---

### A4. Require `state` on `/oauth/authorize`

**Risk** — [stores.ts:16](../src/auth/stores.ts#L16) has `claude_state` optional, and [oauth.ts:113](../src/auth/oauth.ts#L113) reads it without requiring it. A client omitting `state` has no CSRF binding on the callback leg. OAuth 2.1 recommends mandatory `state` for public clients.

**Proposed** — reject at [oauth.ts:116](../src/auth/oauth.ts#L116):

```ts
if (!state) return res.status(400).send("state required (CSRF binding)");
```

**Effort** — 5 min. Only concern: does any Claude client omit `state`? Modern clients don't, but worth testing before enforcing.

---

### A5. `/health` that actually checks health

**Risk** — [index.ts:58-60](../src/index.ts#L58-L60) returns `{ status: "ok" }` unconditionally. If JWKS is unreachable (bad VPC config, Cognito outage in our region), `/health` is green and the ALB keeps routing traffic, every `/mcp` 500s on the first call.

**Proposed** — a deep health mode. Keep `/health` cheap for ALB (just a process-alive check) but add `/health/deep` that:
- Fetches JWKS (or returns a cached result if < 60 s old)
- Pings Dynamo with `DescribeTable` on one of our three tables
- Returns 503 if either fails

```
GET /health       → { ok:true } — ALB target group
GET /health/deep  → CI/readiness probe
```

**Effort** — 1-2 hours.

---

## Tier A.6 — DynamoDB-backed MCP session store (required to return to HA)

**Risk** — `sessions` Map in [index.ts:68](../src/index.ts#L68) is per-process. With >1 Fargate task behind the ALB, session state only exists on one task; round-robined follow-up requests 404 on the other task and Claude gets stuck in a re-initialize loop. Currently mitigated by running `desired_count = 1` in staging, which loses HA and causes ~60 s blips on deploys.

**Proposed** — extend the `STORE_DRIVER=dynamo` pattern to cover MCP sessions. Add a fourth Dynamo table `{env}-mcp-sessions` keyed by `mcp-session-id`, with a TTL attribute so idle sessions roll off after (say) 30 min. The per-request session lookup in `handleMcp` becomes a DDB `GetItem`/`PutItem` instead of an in-process Map access. The `McpServer` and `StreamableHTTPServerTransport` instances themselves can't be serialised, so the session record stores only the `userToken` + `mcp-session-id`; the McpServer is built per-request if needed (or kept in a warm pool per-task with LRU).

Lift `desired_count` back to 2+ once this lands.

**Effort** — ~2-4 hours (schema, Dynamo adapter, replace the in-memory Map, tests).

---

## Tier B — before opening beyond a pilot

These are operational maturity: auditability, abuse resistance, incident readiness.

### B1. WAF in front of ALB

AWS WAF with:
- Managed rule groups: `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `AWSManagedRulesAmazonIpReputationList`.
- Geo-match: allow only `AU` (and test-region IPs). MCP traffic is from claude.ai edge and staff browsers — if you're sure of those origins, restrict further.
- Custom rule rate-limiting `/oauth/*` at the edge too, as defence in depth against our in-process limiter.

**Effort** — 1 day including testing.

---

### B2. ALB access logs → S3 (+ Athena)

ALB access logging enabled, logs to a dedicated S3 bucket with 30-90 day TTL. Gives you:
- "Who hit `/mcp` at 3 am?" answerable without replaying the incident.
- Latency / 5xx rate dashboards via Athena.
- Feeds a Glue table for ad-hoc SQL.

Critical: **staging = prod logs** with the same retention as prod if staging data is prod. The log bucket itself is PII-adjacent (source IPs).

**Effort** — half a day (Terraform).

---

### B3. Structured audit log per tool call

**Risk** — current `logger.info` lines are fine for debugging but mixed in with request noise. "Did Alice call `get_patient_by_id(123)` yesterday?" requires grepping through a lot.

**Proposed** — a dedicated audit logger that emits one line per tool call:

```json
{"type":"audit","at":"2026-…","sub":"cognito-uuid","tool":"get_patient_by_id","status":200,"ms":120,"requestId":"..."}
```

Separate pino transport → separate CloudWatch log group with stricter IAM. SIEM / compliance team has read-only access to just this group.

**Do not log arguments** — a patient ID in the audit log is itself PII. Log the tool name and the `sub` who called it; correlate to the .NET API's audit log (by `requestId`) for the full picture.

**Effort** — half a day.

---

### B4. Key rotation runbook for `API_KEY`

**Risk** — `API_KEY` is the legacy `x-api-key` forwarded to the .NET API. No documented rotation path. Compromise → unclear how to replace without downtime.

**Proposed** — Secrets Manager auto-rotation Lambda:
1. Call .NET `POST /admin/api-keys` for a new key.
2. Write new key to Secrets Manager as `pending`.
3. Restart MCP tasks (picks up new value via [secrets.ts](../src/lib/secrets.ts)).
4. Deactivate old key after grace window.

Needs a matching admin endpoint on the .NET side.

**Effort** — 1-2 days, dependent on .NET changes.

---

### B5. Health check includes JWKS freshness

Covered by A5 but worth calling out independently — jose caches JWKS per-process. If Cognito rotates its signing keys and jose's cache hasn't refreshed, every verify 401s until the cache expires. A deep health probe catches this before traffic does.

---

## Tier C — belt-and-braces, low urgency

### C1. Strict `aud` enforcement

[jwtVerify.ts:23](../src/auth/jwtVerify.ts#L23) currently validates `client_id` manually because Cognito access tokens lack consistent `aud`. If you move to a multi-app-client pool (e.g. a separate client for machine-to-machine), add explicit per-token-type audience checks.

### C2. Rotating client-side DCR secrets

If we ever switch from public clients to confidential clients (requires Claude to handle client secrets), tokens become more valuable and rotation strategy matters. Out of scope until the MCP spec supports this.

### C3. Per-tool argument size limits

`express.json({ limit: "1mb" })` caps the whole request, but a malicious client could send 1 MB in a single tool argument. The JSON-RPC parser and zod validator accept it. Low risk, but a per-argument 64 KB cap in `buildInputShape` would be belt-and-braces.

### C4. SBOM + dependency scanning

Snyk / GitHub Dependabot / `npm audit --audit-level=high` in CI. Catches upstream supply-chain issues.

### C5. Pen-test before GA

Third-party pen test against the deployed staging. Focus areas: the OAuth bridge, the redirect URI allowlist, session handling, the rate limit's evictability.

---

## Tier D — "nice to have, never quite urgent"

- Distributed rate limit (Redis/Dynamo-backed) once we're on multi-instance heavily
- Field-level audit (track which tool calls exposed which patient IDs)
- Structured deprecation warnings when [tools.json](../src/config/tools.json) marks a tool `deprecated:true` — current behaviour silently drops it from registration
- Tool-level circuit breaker on upstream failures (stop calling an endpoint that's 500ing for all users, give it 60 s)
- Per-tool concurrency limits

---

## Summary ranking

| Rank | Item | Effort | Risk retired |
|---|---|---|---|
| 1 | A1 scope-gate writes | 2-4 h | High — any user can currently write |
| 2 | A2 tools.json lint | 4 h | Silent-leak avoidance |
| 3 | A3 redirect URI validator | 15 min | Spec compliance + DoS |
| 4 | A4 require state | 5 min | CSRF |
| 5 | B2 ALB access logs | 4 h | Incident forensics |
| 6 | B1 WAF | 1 d | Edge abuse |
| 7 | A5 / B5 deep health | 2 h | Grey failures |
| 8 | B3 audit log | 4 h | Compliance / SIEM |
| 9 | B4 API_KEY rotation | 1-2 d | Secret compromise response |
| 10 | Everything else | varies | Belt-and-braces |

**Before opening staging to real PII traffic**, Tier A is the minimum bar. Tier B before opening beyond a pilot. Tier C/D can slot into normal sprint work.
