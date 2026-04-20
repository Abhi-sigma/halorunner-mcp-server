# Request pipeline — end to end

A single Claude tool call passes through ~12 layers on the way in and out. This doc names each one, explains why it's there, and points at the code.

See also: [authorization.md](authorization.md) for the OAuth flow that happens **before** any `/mcp` request.

---

## Phase 0 — startup (runs once in `main()`)

Before any request can be served, `main()` builds the whole graph:

```
main()                                      [src/index.ts]
  ├─ loadSecretsIntoEnv(SECRETS_MANAGER_SECRET_ID)   ← merges Secrets Manager JSON into process.env
  ├─ env()                                           ← validates process.env against zod schema
  ├─ loadToolsConfig()                               ← reads + zod-validates tools.json
  ├─ buildRedactionPlans(config)                     ← compiles Set<piiPath>, Set<declaredPath>
  ├─ express()                                        ← build HTTP app
  ├─ app.set("trust proxy", 1)                        ← req.ip is the real client behind ALB
  ├─ cors({origin: explicit list})                    ← wildcard forbidden in prod
  ├─ express.json({limit:"1mb"})
  ├─ oauthRouter(stores)                              ← /oauth/*, /.well-known/*
  ├─ handleMcp on POST/GET/DELETE /mcp
  └─ listen(PORT)
```

Two things are built once and reused for every request:
- **RedactionPlans** — compiled Set lookups per tool, no per-request parsing.
- **Stores** — one in-memory Map trio, or one DynamoDB DocumentClient, alive for the lifetime of the process.

---

## Phase 1 — HTTP request arrives

Claude sends:

```
POST /mcp HTTP/1.1
Host: mcp.api.yourapp
Authorization: Bearer eyJraWQiOi...            ← Cognito access token
Content-Type: application/json
mcp-session-id: 7d3f2a...                      ← (absent on first call)
mcp-protocol-version: 2024-11-05

{"jsonrpc":"2.0","method":"tools/call",
 "params":{"name":"get_patient_appointments","arguments":{"patientId":42}},
 "id":1}
```

Express middleware fires in order ([src/index.ts:37-58](../src/index.ts#L37-L58)):

1. **`cors()`** — responds to OPTIONS preflight, sets `Access-Control-Allow-Origin` on the real request. Origin must be in the allow-list or the browser rejects the response.
2. **`express.json({ limit: "1mb" })`** — parses request body. >1 MB → 413.
3. **`express.urlencoded(...)`** — irrelevant for `/mcp`; used by `/oauth/token` form-encoded POSTs.
4. **Router match** → `handleMcp(req, res)`.

Nothing else handles `/mcp`. `oauthRouter()` doesn't match this path so it passes through.

---

## Phase 2 — auth gate (`handleMcp`)

Logic at [src/index.ts:103-144](../src/index.ts#L103-L144):

```
handleMcp:
  ├─ Read "authorization" header.
  │     Missing or not "Bearer …" → unauthorized()
  │     → 401 + WWW-Authenticate: Bearer resource_metadata="…"
  │
  ├─ token = auth.slice(7).trim()
  │
  ├─ await verifyCognitoToken(token)         [src/auth/jwtVerify.ts:19]
  │     ├─ jose fetches Cognito JWKS (cached in-process by jose)
  │     ├─ jwtVerify(token, jwks, { issuer })   signature, exp, iss
  │     ├─ require token_use ∈ {access, id}
  │     └─ require payload.client_id === COGNITO_CLIENT_ID
  │  on failure → unauthorized()
  │
  ├─ sessionId = req.header("mcp-session-id")
  │     already in sessions Map?         → reuse
  │     absent but isInitializeRequest?  → createSession(token)
  │     absent and NOT initialize?       → 404 (client re-inits)
  │     present but unknown?             → 404 (same)
  │
  └─ session.userToken = token             ← refresh on every call
    await session.transport.handleRequest(req, res, req.body)
```

The 404-on-stale-session is deliberate: clients retry 404s, they don't retry 400s. See [src/index.ts:124-137](../src/index.ts#L124-L137).

---

## Phase 3 — `createSession` (first call only per user/session)

[src/index.ts:76-101](../src/index.ts#L76-L101):

```
createSession(userToken):
  ├─ new McpServer({ name, version })
  │
  ├─ sessionBox = { userToken }                 ← mutable closure
  │                                               tool handlers read userToken through this box
  │
  ├─ installAllTools(server, config, plans, () => sessionBox)
  │       [src/services/categoryDiscovery.ts:21]
  │   ├─ Register "list_categories"             — informational tool
  │   └─ For each non-deprecated tool:
  │       registerTool(server, tool, plans.get(tool_name), getSession)
  │          [src/services/toolRegistry.ts:20]
  │       ├─ buildInputShape(tool.parameters)   — zod schema from JSON decls
  │       └─ server.registerTool(name, schema, handler)
  │
  ├─ new StreamableHTTPServerTransport({
  │      sessionIdGenerator: randomUUID,
  │      onsessioninitialized: id => sessions.set(id, {...})
  │    })
  │
  ├─ transport.onclose → sessions.delete(sessionId)
  │
  └─ await server.connect(transport)
```

Key point: **every session gets its own `McpServer` instance**. This is how Alice's Bearer token doesn't leak into Bob's tool handlers — `sessionBox.userToken` is a per-session closure.

---

## Phase 4 — transport layer

`transport.handleRequest(req, res, body)` is SDK glue from `@modelcontextprotocol/sdk`:

```
StreamableHTTPServerTransport.handleRequest:
  ├─ Validate JSON-RPC envelope (jsonrpc:"2.0", method, id)
  ├─ Assign/echo mcp-session-id response header
  ├─ Wrap Express res for Server-Sent Events if client requested streaming
  └─ Dispatch message to McpServer
```

Dispatch inside `McpServer`:

```
method = "tools/call"
params.name = "get_patient_appointments"
params.arguments = { patientId: 42 }

McpServer:
  ├─ Look up registered tool by name.
  ├─ zod-validate params.arguments against the tool's inputSchema.
  │     Fail → JSON-RPC error { code:-32602, "Invalid params" }
  └─ Call tool handler(args).
```

---

## Phase 5 — tool handler

The closure registered at [src/services/toolRegistry.ts:38-60](../src/services/toolRegistry.ts#L38-L60):

```
handler(args):
  session = getSession()                         ← reads current userToken
  try:
    { status, body } = await callUpstream(tool, args, session.userToken)
    redacted = redact(plan, body)                ← compiled at startup
    payload = { status, tool: tool.tool_name, data: redacted }
    return {
      content: [{ type:"text", text: JSON.stringify(payload, null, 2) }],
      isError: status >= 400
    }
  catch err:
    logger.error; return { content:[{error:...}], isError:true }
```

This is where **redaction gets hooked in** — a single line between the upstream response and the MCP response envelope.

---

## Phase 6 — `callUpstream` (outbound .NET call)

[src/services/apiClient.ts:27-116](../src/services/apiClient.ts#L27-L116):

```
callUpstream(tool, args, userToken):
  ├─ Partition args by tool.parameters[].in  → path | query | header | body
  │     Missing required → throw
  │
  ├─ URL build:
  │    path = tool.path                         (e.g. "/api/Appointments/{id}")
  │    for each pathArg: path.replaceAll("{id}", encodeURIComponent(v))
  │    url  = `${API_BASE_URL}${path}` + queryArgs
  │          ↑ NOT new URL(path, base) — preserves "/web" prefix in prod
  │
  ├─ Headers:
  │    accept: application/json
  │    authorization: `Bearer ${userToken}`     ← forwarded Cognito token
  │    x-api-key: env.API_KEY                   ← optional legacy header
  │    + any header-typed params
  │
  ├─ Body:
  │    non-GET/DELETE with body-typed params → JSON.stringify
  │
  ├─ AbortController 15 s timeout
  │
  ├─ fetch(url, { method, headers, body, signal })
  │
  ├─ text = await res.text()
  │    Log { tool, method, url, status, ms } at info.
  │    If status >= 400 → log { tool, status, bodyHash, bodyLength } at warn.
  │        Body is NOT logged — upstream errors can echo request data back.
  │        The sha256-prefix hash is for correlating repeated identical errors.
  │
  └─ Parse:
      if content-type: application/json → JSON.parse (or keep text on parse failure)
      else leave as string
      return { status, body: parsed }
```

On the wire:

```
GET https://api.ygpapp.com/web/api/Appointments/42 HTTP/1.1
accept: application/json
authorization: Bearer eyJraWQiOi...          ← same token Claude gave us
x-api-key: <if set>
```

.NET API validates the same Cognito JWT, runs the query, returns JSON.

---

## Phase 7 — redaction

[src/middleware/redact.ts:50-82](../src/middleware/redact.ts#L50-L82). Where the `RedactionPlan` compiled at startup is applied:

```
upstream body (from .NET):
{
  "success": true,
  "data": {
    "appointmentId": 42,
    "patientName": "John Smith",        ← pii:true → REDACTED
    "dateOfBirth": "1980-01-15",        ← pii:true → REDACTED
    "mobile": "+61...",                  ← pii:true → REDACTED
    "appointmentType": "Standard",       ← pii:false → passthrough
    "patientId": 7,                      ← pii:false → passthrough
    "medicareNumber": "2 1234 56789 1"   ← NOT DECLARED → dropped (strict)
  }
}

redact walker (depth-first):
  for each key:
    dotted = path.join(".")
    if strict && no declaredPath starts with dotted → drop
    if piiPaths.has(dotted) → value = "REDACTED" (null stays null)
    else recurse

redacted:
{
  "success": true,
  "data": {
    "appointmentId": 42,
    "patientName": "REDACTED",
    "dateOfBirth": "REDACTED",
    "mobile": "REDACTED",
    "appointmentType": "Standard",
    "patientId": 7
    ← medicareNumber gone
  }
}
```

Key walker properties:
- **Compiled once** at startup; per-call redaction is a single tree walk.
- **Arrays don't extend the path** ([redact.ts:57](../src/middleware/redact.ts#L57)) — `"data.items.patientName"` matches every element of a `data.items` array.
- **Undeclared paths dropped** when `strict_returns: true`. Prevents leaks when upstream adds a new field without an accompanying tools.json update.
- **null stays null** — no `"REDACTED"` sentinel for originally-empty fields.
- **Opt-out**: a tool with empty `returns` passes the body through untouched ([redact.ts:51](../src/middleware/redact.ts#L51)). Covered by a structural test in [redact.coverage.test.ts](../src/middleware/redact.coverage.test.ts).

---

## Phase 8 — response assembly

```
payload = {
  status: 200,
  tool: "get_patient_appointments",
  data: { ...redacted body... }
}

handler returns to McpServer:
  {
    content: [{ type:"text", text: JSON.stringify(payload, null, 2) }],
    isError: false
  }

McpServer wraps in JSON-RPC:
  { jsonrpc:"2.0", id:1, result: { content:[...], isError:false } }

Transport writes to HTTP:
  HTTP/1.1 200 OK
  content-type: application/json
  mcp-session-id: 7d3f2a...
  { "jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"…"}]}}

Express emits response → back to Claude.
```

Claude parses `content[0].text`, which is the JSON string, and has a redacted view of the data.

---

## Where each layer lives in the codebase

| Layer | File | Key lines |
|---|---|---|
| Bootstrap, CORS, routing | [src/index.ts](../src/index.ts) | 21-170 |
| JWT verification | [src/auth/jwtVerify.ts](../src/auth/jwtVerify.ts) | 19-47 |
| Session + transport wiring | [src/index.ts](../src/index.ts) | 76-101 |
| Tool registry | [src/services/toolRegistry.ts](../src/services/toolRegistry.ts) | 20-62 |
| Upstream HTTP client | [src/services/apiClient.ts](../src/services/apiClient.ts) | 27-116 |
| Redaction walker | [src/middleware/redact.ts](../src/middleware/redact.ts) | 50-82 |
| Redaction plan compiler | [src/middleware/redact.ts](../src/middleware/redact.ts) | 15-36 |
| Config loader | [src/config/schema.ts](../src/config/schema.ts) | 67-93 |
| Tool data | [src/config/tools.json](../src/config/tools.json) | (whole file) |

---

## Three invariants worth remembering

1. **The Bearer token is passed through, not minted.** Claude → you → .NET. Edge verifies, forwards unchanged. .NET verifies again. No token translation, no impersonation.
2. **Redaction is declarative, not imperative.** The pipeline knows nothing about *what* PII looks like. It reads [tools.json](../src/config/tools.json). Change the data, change the behaviour — no code change.
3. **Session state is just a token holder.** The `sessionBox` closure is the only per-session state. Kill the session, nothing leaks. No per-user caches, no per-user DB connections, no ALB stickiness required.

---

## End-to-end, one page

```
   Claude                       Your server                       .NET API
   ──────                       ───────────                       ────────
POST /mcp  ────────────────────▶
                              [CORS, JSON parse]
                              ┌─── handleMcp ───────────┐
                              │ • Bearer present?       │
                              │ • verifyCognitoToken()  │────JWKS fetch──▶ Cognito
                              │     iss, exp, sig       │◀─────────────── (cached)
                              │     token_use, client_id│
                              │ • find/create session   │
                              │     (createSession      │
                              │      installAllTools)   │
                              │ • refresh userToken     │
                              └───transport.handleRequest
                              ┌─── Transport ───────────┐
                              │ parse JSON-RPC          │
                              │ dispatch to McpServer   │
                              └───────────┬─────────────┘
                              ┌─── McpServer ───────────┐
                              │ lookup tool             │
                              │ zod-validate args       │
                              └───────────┬─────────────┘
                              ┌─── tool handler ────────┐
                              │ callUpstream(tool,args, │
                              │              userToken) │─── HTTPS + Bearer ──▶
                              │                         │                      .NET API
                              │                         │◀──── JSON response ──
                              │ redact(plan, body)      │
                              │   ├ drop undeclared     │
                              │   └ replace pii fields  │
                              │ wrap { status,tool,data}│
                              └───────────┬─────────────┘
                              [JSON-RPC response]
                              [HTTP response]
        ◀──────────────────────
```
