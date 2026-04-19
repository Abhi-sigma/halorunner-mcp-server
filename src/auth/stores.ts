import { randomBytes } from "node:crypto";

// -- Types ------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
  last_used_at: number;
}

export interface PendingAuth {
  client_id: string;
  claude_redirect_uri: string;
  claude_state?: string;
  claude_code_challenge: string;
  claude_code_challenge_method: "S256";
  our_cognito_verifier: string;
  requested_scope?: string;
  created_at: number;
}

/** Opaque Cognito tokens exactly as returned by /oauth2/token. */
export interface CognitoTokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface IssuedCode {
  client_id: string;
  cognito_tokens: CognitoTokenResponse;
  claude_code_challenge: string;
  claude_code_challenge_method: "S256";
  created_at: number;
}

// -- Store interfaces (narrow; easy to swap to DynamoDB later) --------------

export interface ClientStore {
  get(id: string): Promise<RegisteredClient | null>;
  create(input: { redirect_uris: string[]; client_name?: string }): Promise<RegisteredClient>;
  touch(id: string): Promise<void>;
}

export interface PendingStore {
  put(state: string, entry: PendingAuth): Promise<void>;
  /** get-and-delete; returns null if missing OR expired (entry is removed either way). */
  take(state: string): Promise<PendingAuth | null>;
}

export interface CodeStore {
  put(code: string, entry: IssuedCode): Promise<void>;
  /** get-and-delete; returns null if missing OR expired. Single-use by design. */
  take(code: string): Promise<IssuedCode | null>;
}

export interface Stores {
  clients: ClientStore;
  pending: PendingStore;
  codes: CodeStore;
}

// -- In-memory implementation -----------------------------------------------

const CLIENT_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days, refreshed on use
const PENDING_TTL_MS = 5  * 60 * 1000;           // 5 min
const CODE_TTL_MS    = 60 * 1000;                // 60 sec
const MAX_CLIENTS    = 10_000;                   // safety cap

class InMemoryClientStore implements ClientStore {
  private m = new Map<string, RegisteredClient>();

  async get(id: string): Promise<RegisteredClient | null> {
    const c = this.m.get(id);
    if (!c) return null;
    if (Date.now() - c.last_used_at > CLIENT_TTL_MS) {
      this.m.delete(id);
      return null;
    }
    return c;
  }

  async create(input: { redirect_uris: string[]; client_name?: string }): Promise<RegisteredClient> {
    if (this.m.size >= MAX_CLIENTS) {
      // LRU evict by last_used_at
      let oldestId: string | null = null;
      let oldestUsed = Infinity;
      for (const [id, c] of this.m) {
        if (c.last_used_at < oldestUsed) { oldestUsed = c.last_used_at; oldestId = id; }
      }
      if (oldestId) this.m.delete(oldestId);
    }
    const now = Date.now();
    const client: RegisteredClient = {
      client_id: `mcp_${randomBytes(16).toString("base64url")}`,
      redirect_uris: input.redirect_uris,
      client_name: input.client_name,
      created_at: now,
      last_used_at: now
    };
    this.m.set(client.client_id, client);
    return client;
  }

  async touch(id: string): Promise<void> {
    const c = this.m.get(id);
    if (c) c.last_used_at = Date.now();
  }
}

class InMemoryPendingStore implements PendingStore {
  private m = new Map<string, PendingAuth>();

  async put(state: string, entry: PendingAuth): Promise<void> {
    this.m.set(state, entry);
  }

  async take(state: string): Promise<PendingAuth | null> {
    const e = this.m.get(state);
    if (!e) return null;
    this.m.delete(state);
    if (Date.now() - e.created_at > PENDING_TTL_MS) return null;
    return e;
  }
}

class InMemoryCodeStore implements CodeStore {
  private m = new Map<string, IssuedCode>();

  async put(code: string, entry: IssuedCode): Promise<void> {
    this.m.set(code, entry);
  }

  async take(code: string): Promise<IssuedCode | null> {
    const e = this.m.get(code);
    if (!e) return null;
    this.m.delete(code);
    if (Date.now() - e.created_at > CODE_TTL_MS) return null;
    return e;
  }
}

export function inMemoryStores(): Stores {
  return {
    clients: new InMemoryClientStore(),
    pending: new InMemoryPendingStore(),
    codes:   new InMemoryCodeStore()
  };
}
