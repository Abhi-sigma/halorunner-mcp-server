/* eslint-disable no-console */
/**
 * Simulate the MCP tool calls Claude would chain for a typical question,
 * against our live MCP server (no Anthropic API, no Claude model).
 *
 * Prompt simulated: "List any patient who has debt, then drill into the top one."
 *
 * Steps:
 *   1. Interactive OAuth (loopback + PKCE) → Cognito access token
 *   2. MCP: initialize session
 *   3. MCP: tools/call list_patients_with_debt (page 1, pageSize 10)
 *   4. MCP: tools/call get_debt_aging_summary
 *   5. Pick the top debtor from step 3, call get_patient_invoices
 *
 * Each tool call prints: request args → HTTP status → a summary of the
 * redacted response as Claude would see it.
 *
 * Usage:
 *   tsx scripts/simulate.ts
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";

const MCP_URL = process.env.MCP_URL ?? "https://gilbert-practice-character-open.trycloudflare.com";

// ---------- OAuth (identical shape to e2e-api-test.ts) ---------------------

async function getCognitoToken(): Promise<string> {
  const { port, codePromise, close } = await startLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const regRes = await fetch(`${MCP_URL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "mcp-simulator" })
  });
  if (!regRes.ok) throw new Error(`/oauth/register → ${regRes.status}`);
  const reg = (await regRes.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("base64url");

  const authUrl = new URL(`${MCP_URL}/oauth/authorize`);
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email phone profile");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  console.log(`\nOpen this URL in your browser to log in:\n${authUrl.toString()}\n`);
  console.log(`Waiting for callback on http://127.0.0.1:${port} …`);

  const { code, state: gotState } = await codePromise;
  close();
  if (gotState !== state) throw new Error("state mismatch");

  const tokRes = await fetch(`${MCP_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: reg.client_id,
      redirect_uri: redirectUri
    }).toString()
  });
  if (!tokRes.ok) throw new Error(`/oauth/token → ${tokRes.status} ${await tokRes.text()}`);
  const tokens = (await tokRes.json()) as { access_token: string };
  console.log("✓ Got Cognito access token\n");
  return tokens.access_token;
}

function startLoopback() {
  return new Promise<{ port: number; codePromise: Promise<{ code: string; state: string }>; close: () => void }>((resolve) => {
    let resolveCode: (v: { code: string; state: string }) => void = () => undefined;
    const codePromise = new Promise<{ code: string; state: string }>(r => { resolveCode = r; });
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (code && state) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h2>OK — return to terminal.</h2>");
        resolveCode({ code, state });
      } else {
        res.writeHead(400).end("missing code/state");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, codePromise, close: () => server.close() });
    });
  });
}

// ---------- MCP protocol helpers -------------------------------------------

let currentSessionId: string | undefined;

async function mcpCall(token: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${MCP_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
      ...(currentSessionId ? { "mcp-session-id": currentSessionId } : {})
    },
    body: JSON.stringify(body)
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) currentSessionId = sid;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${res.status}: ${text.slice(0, 400)}`);

  // JSON-RPC notifications have no `id` and return 202 Accepted with empty body.
  const isNotification = typeof body === "object" && body !== null && !("id" in body);
  if (isNotification || res.status === 202 || text.length === 0) return undefined;

  // MCP Streamable HTTP returns either JSON or text/event-stream. The one
  // relevant JSON-RPC response comes through as an SSE `data:` line.
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const dataLine = text.split("\n").find(l => l.startsWith("data: "));
    if (!dataLine) throw new Error("no SSE data in response");
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

async function initialize(token: string) {
  const resp = await mcpCall(token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "gp-mcp-simulator", version: "0.1.0" }
    }
  });
  console.log("── initialize ── session-id:", currentSessionId);
  const serverInfo = (resp as { result?: { serverInfo?: unknown } }).result?.serverInfo;
  if (serverInfo) console.log("   serverInfo:", JSON.stringify(serverInfo));
  // Send initialized notification (MCP handshake requirement)
  await mcpCall(token, { jsonrpc: "2.0", method: "notifications/initialized" });
}

async function listTools(token: string) {
  const resp = await mcpCall(token, { jsonrpc: "2.0", id: randomUUID(), method: "tools/list" });
  const tools = ((resp as { result?: { tools?: Array<{ name: string }> } }).result?.tools) ?? [];
  return tools.map(t => t.name);
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const resp = await mcpCall(token, {
    jsonrpc: "2.0", id: randomUUID(), method: "tools/call",
    params: { name, arguments: args }
  });
  const result = (resp as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } }).result;
  const texts = (result?.content ?? []).map(c => c.text).filter((t): t is string => !!t).join("\n");
  let parsed: unknown = texts;
  try { parsed = JSON.parse(texts); } catch { /* keep as string */ }
  return { isError: result?.isError === true, payload: parsed };
}

// ---------- The actual simulation ------------------------------------------

interface DebtorRow {
  patientId: string;
  patientName: string;
  totalDebt: number;
  invoiceCount: number;
  oldestAgeDays: number;
  oldestBucket: string;
  pipelineStatus: string;
  assignedTo: string;
}

interface ListPatientsResult {
  status: number;
  tool: string;
  data: {
    success: boolean;
    data: { page: number; pageSize: number; totalCount: number; items: DebtorRow[] };
  };
}

function printSection(title: string) {
  console.log("\n" + "═".repeat(73));
  console.log(title);
  console.log("═".repeat(73));
}

async function main() {
  const token = await getCognitoToken();

  printSection("Step 1. Initialize MCP session + list tools");
  await initialize(token);
  const tools = await listTools(token);
  console.log("Tools visible:", tools.length);
  tools.forEach(t => console.log("  •", t));

  printSection('Step 2. Call list_patients_with_debt (pageSize=10)');
  const debtors = (await callTool(token, "list_patients_with_debt", { pageSize: 10 })).payload as ListPatientsResult;
  if (!debtors?.data?.data?.items) {
    console.log(JSON.stringify(debtors, null, 2));
    return;
  }
  const { totalCount, items } = debtors.data.data;
  console.log(`HTTP ${debtors.status}  — ${items.length} rows returned, totalCount=${totalCount}\n`);
  console.log("idx | patientId | patientName  | totalDebt | inv | oldestDays | bucket      | status      | assignedTo");
  console.log("----+-----------+--------------+-----------+-----+------------+-------------+-------------+-----------");
  items.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(3)} | ` +
      `${String(r.patientId).padEnd(9)} | ` +
      `${(r.patientName ?? "").toString().slice(0, 12).padEnd(12)} | ` +
      `${("$" + r.totalDebt).padStart(9)} | ` +
      `${String(r.invoiceCount).padStart(3)} | ` +
      `${String(r.oldestAgeDays).padStart(10)} | ` +
      `${(r.oldestBucket ?? "").padEnd(11)} | ` +
      `${(r.pipelineStatus ?? "").padEnd(11)} | ` +
      `${r.assignedTo ?? ""}`
    );
  });
  console.log("\nNote: `patientName` column above is what Claude sees AFTER redaction (should be \"REDACTED\").");

  printSection("Step 3. Call get_debt_aging_summary (practice-wide)");
  const aging = (await callTool(token, "get_debt_aging_summary", {})).payload as {
    status: number;
    data?: { data?: { totalDebt: number; totalPatients: number; totalInvoices: number; [k: string]: unknown } };
  };
  const a = aging?.data?.data;
  if (a) {
    console.log(`HTTP ${aging.status}  — total debt $${a.totalDebt}, ${a.totalPatients} patients, ${a.totalInvoices} invoices\n`);
    for (const key of Object.keys(a)) {
      if (!key.startsWith("bucket")) continue;
      const b = a[key] as { label: string; patientCount: number; invoiceCount: number; totalAmount: number };
      console.log(`  ${b.label.padEnd(12)}  ${String(b.patientCount).padStart(4)} pts  ${String(b.invoiceCount).padStart(4)} inv  $${b.totalAmount}`);
    }
  } else {
    console.log(JSON.stringify(aging, null, 2));
  }

  if (items.length > 0) {
    const top = items[0];
    if (!top) return;
    printSection(`Step 4. Drill into top debtor (patientId=${top.patientId}) → get_patient_invoices`);
    const inv = (await callTool(token, "get_patient_invoices", { patientId: top.patientId })).payload as {
      status: number;
      data?: { data?: { patientName: string; totalDebt: number; buckets?: Array<{ label: string; invoiceCount: number; bucketTotal: number; invoices: Array<{ invoiceId: number; invoiceDate: string; total: number; ageDays: number; providerName: string; payerLabel: string }> }> } };
    };
    const d = inv?.data?.data;
    if (d) {
      console.log(`HTTP ${inv.status}  — patientName=${d.patientName}  totalDebt=$${d.totalDebt}\n`);
      for (const bucket of d.buckets ?? []) {
        console.log(`  ${bucket.label}: ${bucket.invoiceCount} invoice(s), $${bucket.bucketTotal}`);
        for (const invoice of bucket.invoices) {
          console.log(
            `    #${invoice.invoiceId}  ${invoice.invoiceDate}  $${invoice.total}  ` +
            `${invoice.ageDays}d old  ${invoice.providerName}  (${invoice.payerLabel})`
          );
        }
      }
    } else {
      console.log(JSON.stringify(inv, null, 2));
    }
  }

  printSection("Done");
  console.log("The same sequence is what Claude would chain if a user asked:");
  console.log('  "List any patient who has debt, then show me their invoices."');
  console.log();
}

main().catch(err => {
  console.error("\n✗", err);
  process.exit(1);
});
