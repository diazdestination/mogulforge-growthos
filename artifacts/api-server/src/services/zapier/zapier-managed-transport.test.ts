import { afterEach, expect, it, vi } from "vitest";
import { withZapierMcpSession } from "./zapier-mcp-client";

const token = "synthetic-managed-bearer";
const credential = JSON.stringify({
  version: 1,
  source: "mogulforge",
  serverReference: "fixture",
  connectionToken: token,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "uses the fixed endpoint and server token with Embed present=%s",
  async (embed) => {
    vi.stubEnv("ZAPIER_MCP_EMBED_ID", embed ? "unrelated" : "");
    vi.stubEnv("ZAPIER_MCP_EMBED_SECRET", embed ? "other-secret" : "");
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, options: RequestInit) => {
        expect(String(url)).toBe("https://mcp.zapier.com/api/v1/connect");
        expect(options.redirect).toBe("error");
        expect(new Headers(options.headers).get("authorization")).toBe(
          "Bearer " + token,
        );
        if (options.method === "GET")
          return new Response(null, { status: 405 });
        const request = JSON.parse(String(options.body));
        methods.push(request.method);
        if (request.id === undefined)
          return new Response(null, { status: 202 });
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: request.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "synthetic", version: "1" },
              }
            : {
                tools: [
                  {
                    name: "inspect_zapier_actions",
                    inputSchema: { type: "object" },
                  },
                ],
              };
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      }),
    );
    await expect(
      withZapierMcpSession(credential, (session) => session.listTools()),
    ).resolves.toEqual([{ name: "inspect_zapier_actions", description: null }]);
    expect(methods).toContain("tools/list");
  },
);

it("redacts transport errors and closes the session after a failed connection", async () => {
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const close = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("redirect error including " + token);
    }),
  );
  const err = await withZapierMcpSession(credential, (session) =>
    session.listTools(),
  ).catch((error) => error);
  expect(err.code).toBe("connect_failed");
  expect(err.message).not.toContain(token);
  expect(close).toHaveBeenCalled();
  close.mockRestore();
});

it("rejects a provider redirect without requesting the Location destination", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    urls.push(String(url));
    expect(init.redirect).toBe("error");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://other.example/redirect" },
    });
  });
  await expect(
    withZapierMcpSession(credential, (s) => s.listTools()),
  ).rejects.toMatchObject({ code: "connect_failed" });
  expect(urls).toEqual(["https://mcp.zapier.com/api/v1/connect"]);
});

it.each(["description", "nested value", "nested key"] as const)("blocks escaped credential echoes in a %s", async location => {
  const bearer = 'synthetic-"quoted"-token';
  const stored = JSON.stringify({ version:1, source:"mogulforge", connectionToken:bearer });
  const escaped = JSON.stringify(bearer).replace("synthetic", "\\u0073ynthetic");
  const nested = location === "nested key" ? `[{${escaped}:true}]` : `[{"details":[${escaped}]}]`;
  vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
    if (options.method === "GET") return new Response(null, {status:405});
    const request = JSON.parse(String(options.body));
    if (request.id === undefined) return new Response(null, {status:202});
    const result = request.method === "initialize" ? {
      protocolVersion:request.params.protocolVersion, capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}
    } : request.method === "tools/list" ? { tools:[{name:"inspect",description:bearer,inputSchema:{type:"object"}}] } :
      { content:[{type:"text",text:nested}] };
    return Response.json({jsonrpc:"2.0",id:request.id,result});
  });
  const result = withZapierMcpSession(stored, async session => {
    if (location === "description") return session.listTools();
    return session.callTool("inspect",{});
  });
  await expect(result).rejects.toMatchObject({code:"malformed_result", indeterminate:location !== "description", message:"Zapier returned an unsafe response."});
});
