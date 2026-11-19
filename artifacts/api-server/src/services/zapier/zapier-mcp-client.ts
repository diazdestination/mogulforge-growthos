import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * One session uses either the server-specific managed bearer at Zapier's
 * fixed endpoint or a legacy encrypted URL with the platform Embed bearer.
 * - Nothing here decides *what* to call. Capability bindings and policies do.
 * - Raw tool results never leave this module untouched: callers receive a
 *   parsed JSON value plus its digest, and the digest is what gets persisted.
 */

export const ZAPIER_MCP_ALLOWED_HOSTS = ["mcp.zapier.com"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ZapierMcpError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "invalid_server_url"
      | "connect_failed"
      | "unauthorized"
      | "tool_failed"
      | "tool_missing"
      | "timeout"
      | "task_limit"
      | "malformed_result",
    readonly indeterminate = false,
  ) {
    super(message);
    this.name = "ZapierMcpError";
  }
}

export type ZapierMcpConfig = {
  embedId: string;
  embedSecret: string;
};

export function zapierMcpConfig(env: NodeJS.ProcessEnv = process.env): ZapierMcpConfig | null {
  const embedId = env.ZAPIER_MCP_EMBED_ID?.trim();
  const embedSecret = env.ZAPIER_MCP_EMBED_SECRET?.trim();
  if (!embedId || !embedSecret) return null;
  return { embedId, embedSecret };
}

export function zapierMcpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return zapierMcpConfig(env) !== null;
}

/** Accept only HTTPS URLs on Zapier's MCP host; reject anything with userinfo. */
export function validateZapierServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ZapierMcpError("The Zapier MCP server URL is not a valid URL.", "invalid_server_url");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ZapierMcpError("The Zapier MCP server URL must be an https URL without credentials.", "invalid_server_url");
  }
  const host = url.hostname.toLowerCase();
  if (!ZAPIER_MCP_ALLOWED_HOSTS.some((allowed) => host === allowed)) {
    throw new ZapierMcpError("The Zapier MCP server URL must be hosted by Zapier.", "invalid_server_url");
  }
  return url;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Key-sorted canonical JSON so digests do not depend on object key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type ZapierToolSummary = { name: string; description: string | null };

export type ZapierToolCallResult = {
  /** Parsed JSON when the tool returned JSON text, otherwise the raw text. */
  value: unknown;
  /** SHA-256 of the canonical result bytes. */
  digest: string;
  isError: boolean;
};

type ToolContent = { type?: string; text?: string };

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as ToolContent[])
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function parseToolText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function classifyTransportError(error: unknown): ZapierMcpError {
  if (error instanceof ZapierMcpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("mcpauthorizationerror")) {
    return new ZapierMcpError("Zapier rejected the connection credential.", "unauthorized");
  }
  if (normalized.includes("task limit") || normalized.includes("task_limit")) {
    return new ZapierMcpError("The connected Zapier account reached its task limit.", "task_limit");
  }
  if (normalized.includes("abort") || normalized.includes("timeout") || normalized.includes("timed out")) {
    return new ZapierMcpError("Zapier did not answer in time; the effect may have occurred.", "timeout", true);
  }
  return new ZapierMcpError("Could not reach the connected Zapier MCP server.", "connect_failed");
}

export type ZapierMcpSession = {
  listTools(): Promise<ZapierToolSummary[]>;
  /** Raw tool call. Writes must only be reached through the execution ledger. */
  callTool(name: string, args: Record<string, unknown>): Promise<ZapierToolCallResult>;
};

/**
 * Open a session, run `fn`, and always close the transport. One session per
 * logical operation keeps session ids from leaking across tenants.
 */
export async function withZapierMcpSession<T>(
  serverUrl: string,
  fn: (session: ZapierMcpSession) => Promise<T>,
  options: { timeoutMs?: number; config?: ZapierMcpConfig | null } = {},
): Promise<T> {
  let url: URL;
  let bearer: string;
  let sensitiveUrl: string | null = null;
  if (serverUrl.startsWith("{")) {
    let envelope: { version?: unknown; source?: unknown; connectionToken?: unknown };
    try {
      envelope = JSON.parse(serverUrl);
    } catch {
      throw new ZapierMcpError("Invalid managed credential.", "not_configured");
    }
    if (envelope?.version !== 1 || envelope.source !== "mogulforge" ||
        typeof envelope.connectionToken !== "string" || !/^[!-~]{1,4096}$/.test(envelope.connectionToken)) {
      throw new ZapierMcpError("Invalid managed credential.", "not_configured");
    }
    url = new URL("https://mcp.zapier.com/api/v1/connect");
    bearer = envelope.connectionToken;
  } else {
    const config = options.config === undefined ? zapierMcpConfig() : options.config;
    if (!config) throw new ZapierMcpError("Legacy Zapier credentials are unavailable.", "not_configured");
    url = validateZapierServerUrl(serverUrl);
    bearer = config.embedSecret;
    sensitiveUrl = url.href;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client({ name: "mogulforge-growthos", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { redirect: "error", headers: { Authorization: `Bearer ${bearer}` } },
    fetch: async (resource, init) => {
      const target = resource instanceof Request ? resource.url : String(resource);
      if (target !== url.href) throw new ZapierMcpError("Unexpected Zapier transport destination.", "connect_failed");
      return fetch(resource, { ...init, redirect: "error" });
    },
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw classifyTransportError(error);
  }
  const rejectCredentialEcho = (value: unknown, dispatched = false): void => {
    if (typeof value === "string") {
      if (value.includes(bearer) || (sensitiveUrl && value.includes(sensitiveUrl))) {
        throw new ZapierMcpError("Zapier returned an unsafe response.", "malformed_result", dispatched);
      }
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        rejectCredentialEcho(key, dispatched);
        rejectCredentialEcho(child, dispatched);
      }
    }
  };
  const session: ZapierMcpSession = {
    async listTools() {
      try {
        const result = await client.listTools(undefined, { timeout: timeoutMs });
        rejectCredentialEcho(result.tools);
        return result.tools.map((tool) => ({ name: tool.name, description: tool.description ?? null }));
      } catch (error) {
        throw classifyTransportError(error);
      }
    },
    async callTool(name, args) {
      let raw: { content?: unknown; isError?: boolean };
      try {
        raw = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as {
          content?: unknown;
          isError?: boolean;
        };
      } catch (error) {
        const failure = classifyTransportError(error);
        if (failure.code === "connect_failed") {
          throw new ZapierMcpError("Zapier did not confirm the action outcome.", "connect_failed", true);
        }
        throw failure;
      }
      const text = textOf(raw.content);
      rejectCredentialEcho(text, true);
      const value = parseToolText(text);
      rejectCredentialEcho(value, true);
      return { value, digest: sha256Hex(canonicalJson(value)), isError: Boolean(raw.isError) };
    },
  };
  try {
    return await fn(session);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

/** Zapier agentic-mode meta tools GrowthOS relies on. */
export const ZAPIER_META_TOOLS = {
  inspect: "inspect_zapier_actions",
  discover: "discover_zapier_actions",
  enable: "enable_zapier_action",
  connections: "list_zapier_connections",
  executeRead: "execute_zapier_read_action",
  executeWrite: "execute_zapier_write_action",
} as const;

export function detectServerMode(tools: ZapierToolSummary[]): "agentic" | "managed" | "unknown" {
  const names = new Set(tools.map((tool) => tool.name));
  if (names.has(ZAPIER_META_TOOLS.executeWrite) || names.has(ZAPIER_META_TOOLS.inspect)) return "agentic";
  return tools.length > 0 ? "managed" : "unknown";
}

const RESULT_SUMMARY_KEYS = [
  "id",
  "Id",
  "ID",
  "url",
  "link",
  "htmlLink",
  "html_link",
  "status",
  "DocNumber",
  "doc_number",
  "invoice_number",
  "InvoiceNumber",
  "sid",
  "message_id",
  "count",
] as const;

/** Bounded, allow-listed view of a provider result. Raw results stay out of the DB. */
export function summarizeZapierResult(value: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    summary.count = value.length;
    return summary;
  }
  if (!value || typeof value === "object") {
    const record = (value ?? {}) as Record<string, unknown>;
    const nested = (record.results ?? record.result ?? record.data) as unknown;
    if (Array.isArray(nested)) summary.count = nested.length;
    const single = Array.isArray(nested) && nested.length === 1 ? nested[0] : nested;
    const source = single && typeof single === "object" && !Array.isArray(single) ? (single as Record<string, unknown>) : record;
    for (const key of RESULT_SUMMARY_KEYS) {
      const item = source[key];
      if (typeof item === "string") summary[key] = item.slice(0, 200);
      else if (typeof item === "number" || typeof item === "boolean") summary[key] = item;
      if (Object.keys(summary).length >= 8) break;
    }
  }
  return summary;
}
