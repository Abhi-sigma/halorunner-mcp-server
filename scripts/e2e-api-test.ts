/* eslint-disable no-console */
/**
 * End-to-end test of the MCP server via the Anthropic Messages API.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... tsx scripts/e2e-api-test.ts "your question here"
 *
 * Does in one run:
 *   1. Registers a dynamic client with the MCP server's /oauth/register.
 *   2. Prints an authorize URL for you to click (opens Cognito Hosted UI).
 *   3. Starts a local HTTP listener to catch the callback.
 *   4. Exchanges the code for a Cognito access token via /oauth/token.
 *   5. Calls the Anthropic Messages API with `mcp_servers` pointing at our tunnel.
 *   6. Pretty-prints the assistant's text plus any MCP tool calls + results.
 *
 * The MCP server URL is read from the MCP_URL env var, or falls back to the
 * tunnel URL below. Point it at mcp.api.ygpapp.com once deployed.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { AddressInfo } from "node:net";

const MCP_URL = process.env.MCP_URL ?? "https://gilbert-practice-character-open.trycloudflare.com";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL ?? "claude-opus-4-7";
const PROMPT = process.argv.slice(2).join(" ") || "List any patient who has debt.";

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY env var is required.");
  process.exit(1);
}

async function getCognitoToken(): Promise<string> {
  // --- Start loopback listener on a random free port -----------------------
  const { port, codePromise, close } = await startLoopback();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // --- DCR: register a client on our MCP server ----------------------------
  const regRes = await fetch(`${MCP_URL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "e2e-api-test" })
  });
  if (!regRes.ok) throw new Error(`/oauth/register → ${regRes.status} ${await regRes.text()}`);
  const reg = (await regRes.json()) as { client_id: string };
  console.log(`\n✓ DCR client_id: ${reg.client_id}`);

  // --- PKCE + state --------------------------------------------------------
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("base64url");

  // --- Build the authorize URL --------------------------------------------
  const authUrl = new URL(`${MCP_URL}/oauth/authorize`);
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email phone profile");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  console.log(`\nOpen this URL in your browser to log in:\n${authUrl.toString()}\n`);
  console.log("Waiting for OAuth callback on http://127.0.0.1:" + port + " …");

  // --- Wait for the browser to hit our loopback ---------------------------
  const { code, state: returnedState } = await codePromise;
  close();
  if (returnedState !== state) throw new Error("state mismatch — aborting");
  console.log(`✓ Got authorization code`);

  // --- Exchange for Cognito tokens via our /oauth/token --------------------
  const tokenRes = await fetch(`${MCP_URL}/oauth/token`, {
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
  if (!tokenRes.ok) throw new Error(`/oauth/token → ${tokenRes.status} ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as { access_token: string; expires_in: number };
  console.log(`✓ Got Cognito access_token (expires in ${tokens.expires_in}s)`);
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
      const error = u.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`OAuth error: ${error} (${u.searchParams.get("error_description") ?? ""})`);
        return;
      }
      if (code && state) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h2>Authentication complete.</h2><p>You can close this tab and return to the terminal.</p>");
        resolveCode({ code, state });
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unexpected path");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, codePromise, close: () => server.close() });
    });
  });
}

interface AnthropicResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "mcp_tool_use"; id: string; name: string; server_name: string; input: unknown }
    | { type: "mcp_tool_result"; tool_use_id: string; is_error: boolean; content: Array<{ type: string; text?: string }> }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string }
  >;
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
  model?: string;
}

async function callAnthropic(token: string, prompt: string): Promise<AnthropicResponse> {
  const body = {
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
    mcp_servers: [
      {
        type: "url",
        url: `${MCP_URL}/mcp`,
        name: "gp-mcp",
        authorization_token: token
      }
    ],
    tools: [{ type: "mcp_toolset", mcp_server_name: "gp-mcp" }],
    betas: ["mcp-client-2025-11-20"]
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-11-20"
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${text}`);
  return JSON.parse(text) as AnthropicResponse;
}

function renderResponse(resp: AnthropicResponse) {
  console.log(`\n─── Response ${"─".repeat(60)}`);
  console.log(`model: ${resp.model}  stop_reason: ${resp.stop_reason}`);
  if (resp.usage) console.log(`tokens: in=${resp.usage.input_tokens} out=${resp.usage.output_tokens}`);
  console.log(`${"─".repeat(73)}\n`);

  for (const block of resp.content) {
    if (block.type === "text") {
      console.log((block as { text: string }).text);
      console.log();
    } else if (block.type === "mcp_tool_use") {
      const b = block as { id: string; name: string; server_name: string; input: unknown };
      console.log(`🔧 ${b.server_name}:${b.name}  (${b.id})`);
      console.log("   input: " + JSON.stringify(b.input));
      console.log();
    } else if (block.type === "mcp_tool_result") {
      const b = block as { tool_use_id: string; is_error: boolean; content: Array<{ type: string; text?: string }> };
      console.log(`↩  ${b.is_error ? "ERROR" : "ok"}  for ${b.tool_use_id}`);
      for (const c of b.content) {
        if (c.type === "text" && c.text) {
          const lines = c.text.split("\n");
          const preview = lines.length > 20 ? lines.slice(0, 20).join("\n") + `\n   … ${lines.length - 20} more lines` : c.text;
          console.log(preview.split("\n").map(l => "   " + l).join("\n"));
        }
      }
      console.log();
    }
  }
}

async function main() {
  console.log(`MCP server: ${MCP_URL}`);
  console.log(`Model:      ${MODEL}`);
  console.log(`Prompt:     ${PROMPT}`);

  const token = await getCognitoToken();
  console.log("\nCalling Anthropic Messages API with MCP server …");
  const resp = await callAnthropic(token, PROMPT);
  renderResponse(resp);
}

main().catch(err => {
  console.error("\n✗", err);
  process.exit(1);
});
