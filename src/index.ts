import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { loadToolsConfig } from "./config/schema.js";
import { buildRedactionPlans } from "./middleware/redact.js";
import { verifyCognitoToken } from "./auth/jwtVerify.js";
import { oauthRouter } from "./auth/oauth.js";
import { installAllTools } from "./services/categoryDiscovery.js";

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

async function main() {
  const e = env();
  const config = await loadToolsConfig();
  const plans = buildRedactionPlans(config);

  logger.info(
    {
      tools: config.tools.length,
      categories: Object.keys(config.categories).length,
      piiFields: Array.from(plans.values()).reduce((sum, p) => sum + p.piiPaths.size, 0),
      apiBaseUrl: e.API_BASE_URL
    },
    "gp-mcp-server starting"
  );

  const app = express();

  // CORS — MCP requests from Claude.ai come from a browser origin.
  // The session-id header must be exposed so Claude can read it from responses.
  const allowedOrigins = e.CORS_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins.includes("*") ? true : allowedOrigins,
      credentials: false,
      allowedHeaders: ["authorization", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"],
      exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
      methods: ["GET", "POST", "DELETE", "OPTIONS"]
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Health check for ALB.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  // MCP Authorization Server + Protected Resource metadata + DCR bridge.
  // See src/auth/oauth.ts for the full endpoint map.
  app.use(oauthRouter());

  // MCP transport: one McpServer + one StreamableHTTPServerTransport per session.
  // Session state (which categories are loaded, the current Bearer token) lives
  // in the closure below, keyed by MCP session id.
  interface Session {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    userToken: string;
  }
  const sessions = new Map<string, Session>();

  async function createSession(userToken: string): Promise<Session> {
    const server = new McpServer({ name: "gp-mcp-server", version: "0.1.0" });

    const sessionBox = { userToken };
    installAllTools(server, config, plans, () => sessionBox);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        logger.info({ sessionId: id }, "mcp session initialized");
        sessions.set(id, { transport, server, userToken: sessionBox.userToken });
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        logger.info({ sessionId: transport.sessionId }, "mcp session closed");
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);

    // Return a handle; the real session gets indexed in onsessioninitialized.
    return { transport, server, userToken: sessionBox.userToken };
  }

  async function handleMcp(req: Request, res: Response) {
    const auth = req.header("authorization");
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      return unauthorized(req, res);
    }
    const token = auth.slice(7).trim();

    try {
      await verifyCognitoToken(token);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "jwt verification failed");
      return unauthorized(req, res);
    }

    const sessionId = req.header("mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      // Only a fresh InitializeRequest may create a new session.
      if (req.method === "POST" && isInitializeRequest(req.body)) {
        session = await createSession(token);
      } else {
        // Spec: unknown mcp-session-id → HTTP 404 so the client
        // drops its stale ID and re-initializes automatically.
        // (A 400 looks like a malformed request and clients do NOT retry.)
        if (sessionId) {
          logger.info({ sessionId }, "stale mcp-session-id, returning 404");
        }
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found; please re-initialize." },
          id: null
        });
        return;
      }
    } else {
      // Refresh the token on every call — tokens rotate, session is long-lived.
      session.userToken = token;
    }

    await session.transport.handleRequest(req, res, req.body);
  }

  function unauthorized(_req: Request, res: Response) {
    const resourceUrl = `${e.PUBLIC_BASE_URL}${PROTECTED_RESOURCE_PATH}`;
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceUrl}"`)
      .json({ error: "unauthorized" });
  }

  // All MCP traffic goes through a single path, three HTTP methods.
  app.post("/mcp", handleMcp);
  app.get("/mcp", handleMcp);
  app.delete("/mcp", handleMcp);

  app.listen(e.PORT, () => {
    logger.info({ port: e.PORT, publicBaseUrl: e.PUBLIC_BASE_URL }, "gp-mcp-server listening");
  });
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
