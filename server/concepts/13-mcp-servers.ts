/**
 * CONCEPT 13 — External MCP servers: stdio, http (and sse), next to the in-process "sdk" servers of Concept 5
 *
 *   options.mcpServers = {
 *     notes:     { type: "stdio", command, args, env },          -> Claude Code STARTS this program as a child process
 *     inventory: { type: "http", url, headers },                  -> Claude Code CONNECTS to a running server (Streamable HTTP)
 *     clock:     createSdkMcpServer({ ... }),                     -> type "sdk": runs inside THIS Node process (Concept 5)
 *   }
 *   (type: "sse" has the same shape as "http"; it is the older, deprecated MCP transport.)
 *
 * Part A: one query() per run. What system/init reports for each server (connected / failed / needs-auth / pending),
 *         and how the tools of an external server are named and allowed: mcp__<server>__<tool>, like Concept 5.
 * Part B: a live session (streaming input, Concept 12) managed at run time:
 *         q.mcpServerStatus(), q.toggleMcpServer(), q.reconnectMcpServer(), q.setMcpServers().
 *
 * The external servers of this lab:
 *   notes     mcp-servers/notes-server.ts, a separate Node program (stdio)
 *   inventory the /api/c13/mcp route below: an MCP server over HTTP, protected by a bearer token
 *   broken    a stdio command that does not exist, to see a failed server
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createSdkMcpServer,
  query,
  tool,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept13 = Router();

const MODEL = "claude-haiku-4-5-20251001";
// Claude Code connects to the inventory server and the notes process posts its log here, so both need the lab's own URL.
const LAB_URL = `http://localhost:${process.env.LAB_PORT ?? 3001}`;
const NOTES_SERVER = path.resolve("mcp-servers", "notes-server.ts");
export const INVENTORY_TOKEN = "lab-secret-token";

// ---------------------------------------------------------------------------------------------
// What the MCP servers themselves see. External servers run outside query(), so their log lines
// come through this emitter (the notes process POSTs them; the inventory route emits them directly).
// ---------------------------------------------------------------------------------------------

type McpLog = { server: string; transport: string; method: string; pid?: number; status?: number; detail?: unknown };
const mcpLog = new EventEmitter();

concept13.post("/log", (req, res) => {
  mcpLog.emit("log", req.body as McpLog);
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------------------------
// The "inventory" MCP server over Streamable HTTP, mounted on this Express app at /api/c13/mcp.
// Stateless: every HTTP request gets a new McpServer + transport. The stock lives in this module,
// so it is shared by every client and every session (it is YOUR server, not Claude Code's).
// ---------------------------------------------------------------------------------------------

const stock = new Map([
  ["KB-01", { name: "Mechanical keyboard", qty: 12 }],
  ["MS-02", { name: "Wireless mouse", qty: 0 }],
  ["MN-27", { name: "27-inch monitor", qty: 4 }],
]);

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

function inventoryServer() {
  const server = new McpServer({ name: "lab-inventory", version: "1.0.0" });
  server.registerTool(
    "list_products",
    { description: "List every product with its SKU, name and units in stock.", annotations: { readOnlyHint: true } },
    async () => text([...stock].map(([sku, p]) => ({ sku, ...p }))),
  );
  server.registerTool(
    "reserve",
    {
      description: "Reserve units of a product. Fails if the SKU is unknown or there is not enough stock.",
      inputSchema: { sku: z.string().describe("Product SKU, e.g. KB-01"), qty: z.number().int().positive().describe("Units to reserve") },
    },
    async ({ sku, qty }) => {
      const p = stock.get(sku);
      if (!p) return { ...text(`Unknown SKU ${sku}. Known: ${[...stock.keys()].join(", ")}`), isError: true };
      if (p.qty < qty) return { ...text(`Only ${p.qty} unit(s) of ${sku} left.`), isError: true };
      p.qty -= qty;
      return text({ sku, reserved: qty, left: p.qty });
    },
  );
  return server;
}

concept13.post("/mcp", async (req, res) => {
  // One JSON-RPC message (or a batch) per request: initialize, notifications/initialized, tools/list, tools/call, ...
  const methods = [req.body].flat().map((m: any) => (m?.method === "tools/call" ? `tools/call ${m.params?.name}` : m?.method));
  const log = (status: number) => mcpLog.emit("log", { server: "inventory", transport: "http", method: methods.join(", "), status, detail: [req.body].flat()[0]?.params?.arguments });

  // The `headers` of the http config arrive here. A real server would validate an OAuth token instead.
  if (req.headers.authorization !== `Bearer ${INVENTORY_TOKEN}`) {
    log(401);
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or wrong bearer token" }, id: null });
    return;
  }
  const server = inventoryServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  log(res.statusCode);
});

// Stateless servers have no GET stream (server-to-client notifications) and no sessions to DELETE.
concept13.all("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

concept13.get("/stock", (_req, res) => res.json([...stock].map(([sku, p]) => ({ sku, ...p }))));
concept13.post("/stock/reset", (_req, res) => {
  stock.get("KB-01")!.qty = 12;
  stock.get("MS-02")!.qty = 0;
  stock.get("MN-27")!.qty = 4;
  res.json([...stock].map(([sku, p]) => ({ sku, ...p })));
});

// ---------------------------------------------------------------------------------------------
// The server configs the tab can choose from
// ---------------------------------------------------------------------------------------------

export type ServerName = "notes" | "inventory" | "clock" | "broken";
export type Token = "right" | "wrong" | "none";

/** A config per server. "clock" is built fresh each time: an sdk server holds a live McpServer instance. */
function serverConfig(name: ServerName, token: Token = "right"): McpServerConfig {
  switch (name) {
    case "notes":
      return {
        type: "stdio",
        command: process.execPath, // the same node.exe that runs this server: no PATH lookup
        args: ["--import", "tsx", NOTES_SERVER],
        env: { NOTES_DIR: SANDBOX, LAB_LOG_URL: `${LAB_URL}/api/c13/log` },
      };
    case "inventory":
      return {
        type: "http",
        url: `${LAB_URL}/api/c13/mcp`,
        ...(token !== "none" && { headers: { Authorization: `Bearer ${token === "right" ? INVENTORY_TOKEN : "not-the-token"}` } }),
      };
    case "broken":
      return { type: "stdio", command: "lab-mcp-server-that-does-not-exist", args: ["--stdio"] };
    case "clock":
      return createSdkMcpServer({
        name: "clock",
        version: "1.0.0",
        tools: [
          tool("now", "Get the current date and time on the lab server.", {}, async () => text({ now: new Date().toString() }), {
            annotations: { readOnlyHint: true },
          }),
        ],
      });
  }
}

function buildServers(names: ServerName[], token?: Token) {
  return Object.fromEntries(names.map((n) => [n, serverConfig(n, token)]));
}

/** The `instance` of an sdk server is a live object: show a placeholder when the config is sent as JSON. */
function printable(servers: Record<string, McpServerConfig>) {
  return Object.fromEntries(Object.entries(servers).map(([k, s]) => [k, s.type === "sdk" ? { type: "sdk", name: s.name, instance: "[McpServer]" } : s]));
}

const baseOptions = (): Options => ({
  model: MODEL,
  tools: [], // no built-in tools: every tool in this concept comes from an MCP server
  cwd: SANDBOX,
  settingSources: [],
  strictMcpConfig: true, // only the servers in mcpServers; the machine's own MCP servers stay out
});

// ---------------------------------------------------------------------------------------------
// Part A: one query() with the chosen servers
// ---------------------------------------------------------------------------------------------

concept13.post("/query", (req, res) => {
  const body = req.body as { prompt: string; servers: ServerName[]; allowedTools: string[]; token?: Token };
  const { abort, send, pipe } = openSse(req, res);

  const mcpServers = buildServers(body.servers, body.token);
  const options: Options = { ...baseOptions(), mcpServers, allowedTools: body.allowedTools };
  send("options", { ...options, mcpServers: printable(mcpServers) });

  const onLog = (l: McpLog) => send("mcp_log", l);
  mcpLog.on("log", onLog);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } })).finally(() => mcpLog.off("log", onLog));
});

// ---------------------------------------------------------------------------------------------
// Part B: a live session whose MCP servers change while it runs
// ---------------------------------------------------------------------------------------------

/** The push queue from Concepts 10 and 12. */
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    stream: stream(),
    push: (text: string) => {
      queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } });
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
  };
}

type Session = { q: Query; input: ReturnType<typeof inputQueue>; send: (event: string, data: unknown) => void; startedAt: number };
const sessions = new Map<string, Session>();

concept13.post("/session", (req, res) => {
  const { servers = ["notes", "inventory"] } = req.body as { servers?: ServerName[] };
  const { abort, send, pipe } = openSse(req, res);

  const mcpServers = buildServers(servers);
  // Allow every tool of every server this lab can add, so Part B is about the servers, not about permissions.
  const options: Options = { ...baseOptions(), mcpServers, allowedTools: ["mcp__notes", "mcp__inventory", "mcp__clock", "mcp__broken"] };

  const id = randomUUID();
  const input = inputQueue();
  const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
  sessions.set(id, { q, input, send, startedAt: Date.now() });

  const onLog = (l: McpLog) => send("mcp_log", l);
  mcpLog.on("log", onLog);
  send("session", { id });
  send("options", { ...options, mcpServers: printable(mcpServers), prompt: "[AsyncIterable<SDKUserMessage>]" });
  pipe(q).finally(() => {
    sessions.delete(id);
    mcpLog.off("log", onLog);
  });
});

/** Wraps a control route: finds the session, runs the action, reports errors as 409 (as in Concept 12). */
function control(name: (body: any) => string, action: (q: Query, body: any, s: Session) => Promise<unknown> | unknown) {
  return async (req: Request, res: Response) => {
    const s = sessions.get(req.body.id);
    if (!s) {
      res.status(409).json({ error: "No open session with that id (it already ended)." });
      return;
    }
    const method = name(req.body);
    const ms = Date.now() - s.startedAt;
    try {
      const result = await action(s.q, req.body, s);
      s.send("control", { method, ms, result });
      res.json({ ok: true, result });
    } catch (err) {
      s.send("control", { method, ms, error: String(err) });
      res.status(409).json({ error: String(err) });
    }
  };
}

concept13.post("/send", control((b) => `push "${b.text}"`, (_q, { text }, s) => void s.input.push(text)));

concept13.post("/status", control(() => "q.mcpServerStatus()", (q) => q.mcpServerStatus()));

concept13.post(
  "/toggle",
  control(
    (b) => `q.toggleMcpServer("${b.name}", ${b.enabled})`,
    (q, { name, enabled }) => q.toggleMcpServer(name, enabled),
  ),
);

concept13.post(
  "/reconnect",
  control(
    (b) => `q.reconnectMcpServer("${b.name}")`,
    (q, { name }) => q.reconnectMcpServer(name),
  ),
);

// setMcpServers replaces the set IT manages. A server from options.mcpServers stays until a call names it; from then on
// it belongs to that set, and the next call that leaves it out removes it (tested: see Tab13-MCP-servers.md, Step 8).
concept13.post(
  "/set-servers",
  control(
    (b) => `q.setMcpServers({ ${(b.servers as string[]).join(", ")} })`,
    (q, { servers }) => q.setMcpServers(buildServers(servers)),
  ),
);

concept13.post("/end", control(() => "close input", (_q, _b, s) => s.input.close()));
