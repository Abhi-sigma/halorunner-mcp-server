import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import type {
  ClientStore,
  CodeStore,
  IssuedCode,
  PendingAuth,
  PendingStore,
  RegisteredClient,
  Stores
} from "./stores.js";

/**
 * DynamoDB-backed Stores for multi-instance and durable operation.
 *
 * Table assumptions:
 *   mcp_clients        PK: client_id (S)    — 30 day sliding TTL on last_used_at
 *   mcp_pending_auths  PK: state     (S)    — 5 min TTL
 *   mcp_codes          PK: code      (S)    — 60 sec TTL, single-use
 *
 * Each table has DynamoDB native TTL enabled on attribute `ttl_epoch_s`
 * (epoch seconds). Single-use semantics on pending/codes are enforced by
 * DeleteItem with ReturnValues: ALL_OLD — atomic, at-most-one caller wins.
 */

const CLIENT_TTL_MS  = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 5  * 60 * 1000;
const CODE_TTL_MS    = 60 * 1000;

const toTtlEpochS = (ms: number) => Math.floor((Date.now() + ms) / 1000);

export interface DynamoTables {
  clients: string;
  pending: string;
  codes: string;
}

function makeDocClient(region?: string): DynamoDBDocumentClient {
  const base = new DynamoDBClient(region ? { region } : {});
  return DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true }
  });
}

// -- ClientStore ------------------------------------------------------------

class DynamoClientStore implements ClientStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async get(id: string): Promise<RegisteredClient | null> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table,
      Key: { client_id: id }
    }));
    if (!Item) return null;
    // TTL is server-enforced but delete can lag up to 48h — double-check.
    if (Date.now() - (Item.last_used_at as number) > CLIENT_TTL_MS) return null;
    return toRegisteredClient(Item);
  }

  async create(input: { redirect_uris: string[]; client_name?: string }): Promise<RegisteredClient> {
    const now = Date.now();
    const client: RegisteredClient = {
      client_id: `mcp_${randomBytes(16).toString("base64url")}`,
      redirect_uris: input.redirect_uris,
      client_name: input.client_name,
      created_at: now,
      last_used_at: now
    };
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { ...client, ttl_epoch_s: toTtlEpochS(CLIENT_TTL_MS) }
    }));
    return client;
  }

  async touch(id: string): Promise<void> {
    const now = Date.now();
    await this.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: { client_id: id },
      UpdateExpression: "SET last_used_at = :now, ttl_epoch_s = :ttl",
      ExpressionAttributeValues: {
        ":now": now,
        ":ttl": toTtlEpochS(CLIENT_TTL_MS)
      },
      ConditionExpression: "attribute_exists(client_id)"
    })).catch((err: unknown) => {
      // Silently swallow "conditional check failed" — client expired between
      // get() and touch(). Any other error bubbles up.
      if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
    });
  }
}

function toRegisteredClient(item: Record<string, unknown>): RegisteredClient {
  return {
    client_id: String(item.client_id),
    redirect_uris: (item.redirect_uris as string[]) ?? [],
    client_name: item.client_name as string | undefined,
    created_at: Number(item.created_at),
    last_used_at: Number(item.last_used_at)
  };
}

// -- PendingStore -----------------------------------------------------------

class DynamoPendingStore implements PendingStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async put(state: string, entry: PendingAuth): Promise<void> {
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { state, ...entry, ttl_epoch_s: toTtlEpochS(PENDING_TTL_MS) }
    }));
  }

  async take(state: string): Promise<PendingAuth | null> {
    const { Attributes } = await this.ddb.send(new DeleteCommand({
      TableName: this.table,
      Key: { state },
      ReturnValues: "ALL_OLD"
    }));
    if (!Attributes) return null;
    const entry = toPendingAuth(Attributes);
    if (Date.now() - entry.created_at > PENDING_TTL_MS) return null;
    return entry;
  }
}

function toPendingAuth(item: Record<string, unknown>): PendingAuth {
  return {
    client_id: String(item.client_id),
    claude_redirect_uri: String(item.claude_redirect_uri),
    claude_state: item.claude_state as string | undefined,
    claude_code_challenge: String(item.claude_code_challenge),
    claude_code_challenge_method: "S256",
    our_cognito_verifier: String(item.our_cognito_verifier),
    requested_scope: item.requested_scope as string | undefined,
    created_at: Number(item.created_at)
  };
}

// -- CodeStore --------------------------------------------------------------

class DynamoCodeStore implements CodeStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async put(code: string, entry: IssuedCode): Promise<void> {
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { code, ...entry, ttl_epoch_s: toTtlEpochS(CODE_TTL_MS) }
    }));
  }

  async take(code: string): Promise<IssuedCode | null> {
    const { Attributes } = await this.ddb.send(new DeleteCommand({
      TableName: this.table,
      Key: { code },
      ReturnValues: "ALL_OLD"
    }));
    if (!Attributes) return null;
    const entry = toIssuedCode(Attributes);
    if (Date.now() - entry.created_at > CODE_TTL_MS) return null;
    return entry;
  }
}

function toIssuedCode(item: Record<string, unknown>): IssuedCode {
  return {
    client_id: String(item.client_id),
    cognito_tokens: item.cognito_tokens as IssuedCode["cognito_tokens"],
    claude_code_challenge: String(item.claude_code_challenge),
    claude_code_challenge_method: "S256",
    created_at: Number(item.created_at)
  };
}

// -- Factory ----------------------------------------------------------------

export function dynamoStores(tables: DynamoTables, region?: string): Stores {
  const ddb = makeDocClient(region);
  return {
    clients: new DynamoClientStore(ddb, tables.clients),
    pending: new DynamoPendingStore(ddb, tables.pending),
    codes:   new DynamoCodeStore(ddb, tables.codes)
  };
}
