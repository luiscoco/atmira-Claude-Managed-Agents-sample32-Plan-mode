# Concept 13: External MCP servers, step by step

This file explains how Concept 13 (**External MCP servers**) was added to the Claude Agent SDK Lab.
Concept 5 ([Tab5-Custom-tools.md](Tab5-Custom-tools.md)) served tools from an **in-process** MCP server
(`createSdkMcpServer`, `type: "sdk"`). Here the MCP server is a **separate program**: Claude Code either starts it
(`stdio`) or connects to it over the network (`http`). There are two parts:

- **A. One `query()` with external servers.** The config of each transport, what `system/init` reports, and how
  failures look.
- **B. Managing servers while a session runs.** `mcpServerStatus()`, `toggleMcpServer()`, `reconnectMcpServer()` and
  `setMcpServers()` on a streaming-input session (Concept 12).

| Concept | Topic | Routes |
|---|---|---|
| 13 | External MCP servers: `stdio`, `http` (`sse`), status, runtime management | `/api/c13/query`, `/session`, `/send`, `/status`, `/toggle`, `/reconnect`, `/set-servers`, `/end`, and the MCP server itself on `/api/c13/mcp` |

**Files touched:**

| File | Change |
|---|---|
| `mcp-servers/notes-server.ts` | **New**: a standalone MCP server over **stdio** (a separate Node program) |
| `server/concepts/13-mcp-servers.ts` | **New**: the **http** MCP server (`/api/c13/mcp`), the server configs, Part A and Part B routes |
| `server/index.ts` | Mounts the router on `/api/c13` |
| `src/concepts/Concept13McpServers.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | Transport tags (`stdio`/`http`/`sdk`) and status badges |
| `package.json` | `@modelcontextprotocol/sdk` as a direct dependency (it was already installed by the Agent SDK) |
| `tsconfig.json` | Type-checks `mcp-servers/` too |
| `Tab1-query().md` | Adds Concept 13 to the table of concepts |

---

## Step 1: Read the type definitions

From `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`0.3.281`):

```ts
type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;

type McpStdioServerConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; timeout?: number; alwaysLoad?: boolean };
type McpHttpServerConfig  = { type: 'http'; url: string; headers?: Record<string, string>; timeout?: number; alwaysLoad?: boolean; ... };
type McpSSEServerConfig   = { type: 'sse';  url: string; headers?: Record<string, string>; ... };   // same shape, older transport
type McpSdkServerConfigWithInstance = { type: 'sdk'; name: string; instance: McpServer };           // Concept 5

type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: McpServerStatusConfig;
  source?: string;                 // "sdk" for in-process servers, a config scope ("dynamic", "project", ...) otherwise
  tools?: { name: string; description?: string; annotations?: {...} }[];
};

interface Query {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  reconnectMcpServer(serverName: string): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;  // { added, removed, errors }
}
```

The key difference from Concept 5: **stdio, http and sse configs are plain JSON.** They describe *where* the server is.
Claude Code (the CLI process that `query()` starts) does the connecting. An `sdk` config holds a live object, and
only your process can serve it.

## Step 2: Write a stdio server

**New file:** [mcp-servers/notes-server.ts](mcp-servers/notes-server.ts). It uses the official MCP TypeScript SDK
(`@modelcontextprotocol/sdk`, already in `node_modules` because the Agent SDK depends on it):

```ts
const server = new McpServer({ name: "lab-notes", version: "1.0.0" });

server.registerTool(
  "search_notes",
  { description: "Find every line in the notes that contains a text ...", inputSchema: { text: z.string().min(2) }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: JSON.stringify(hits) }] }),
);

await server.connect(new StdioServerTransport());
```

Tools: `list_notes`, `search_notes`, and `server_process` (returns its own pid, parent pid, cwd and which env
variables it received, so you can *see* that it is another process).

Three rules for a stdio server:

1. **stdout belongs to the protocol.** A `console.log()` would corrupt the JSON-RPC stream. Log to stderr.
2. **Its configuration comes from `env`**: here `NOTES_DIR` (which folder to read) and `LAB_LOG_URL`.
3. **It could be any language.** Claude Code just sees a process that speaks MCP on stdin/stdout.

To show the tab *when* the process runs, it POSTs a small log line to `LAB_LOG_URL` (the lab server's
`/api/c13/log` route) when it starts and on every tool call.

The config that starts it:

```ts
notes: {
  type: "stdio",
  command: process.execPath,                       // the same node.exe: no PATH lookup
  args: ["--import", "tsx", NOTES_SERVER],         // absolute path to mcp-servers/notes-server.ts
  env: { NOTES_DIR: SANDBOX, LAB_LOG_URL: `${LAB_URL}/api/c13/log` },
}
```

## Step 3: Write an http server

The **inventory** server is Streamable HTTP, mounted on the lab's own Express app at `/api/c13/mcp`. It is
**stateless**: every request gets a new `McpServer` + transport:

```ts
concept13.post("/mcp", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${INVENTORY_TOKEN}`) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized ..." }, id: null });
    return;
  }
  const server = inventoryServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

Tools: `list_products` (read-only) and `reserve` (changes the stock, returns `isError` if there is not enough).
The stock is a `Map` in this module, so it outlives every query and is shared by all of them. **Reset stock** puts
it back.

The config that connects to it, with a header chosen in the UI (right token, wrong token, or none):

```ts
inventory: { type: "http", url: `${LAB_URL}/api/c13/mcp`, headers: { Authorization: "Bearer lab-secret-token" } }
```

`sse` would have the same shape (`type: "sse"`, `url`, `headers`). It is the older MCP transport. New servers use
Streamable HTTP, so this lab doesn't include an sse server.

## Step 4: The route for Part A

```ts
const options: Options = {
  model: MODEL,                     // Haiku
  tools: [],                        // no built-in tools: every tool comes from an MCP server
  mcpServers: buildServers(body.servers, body.token),
  allowedTools: body.allowedTools,  // mcp__notes, mcp__inventory__list_products, ...
  cwd: SANDBOX,
  settingSources: [],
  strictMcpConfig: true,            // only these servers; the machine's own MCP config stays out
};
```

The four servers the tab can pick: `notes` (stdio), `inventory` (http), `clock` (an sdk server, for comparison with
Concept 5) and `broken` (a stdio command that doesn't exist).

External servers run outside `query()`, so their log lines can't come through the message stream. An
`EventEmitter` collects them (the notes process POSTs to `/api/c13/log`, the http route emits directly) and the
route forwards them as `mcp_log` SSE events. The tab shows them as **What the MCP servers saw**.

---

# Part A: One query() with external servers

## Step 5: What happens, tested

Every scenario ran against the real SDK with Haiku.

**All four servers** (`notes`, `inventory`, `clock`, `broken`), asking about TODO notes, monitor stock and the pid:

```
  993ms  inventory  server/discover            HTTP 400    <- Claude Code probes first; the server doesn't know it
 1010ms  inventory  initialize                 HTTP 200
 1035ms  inventory  notifications/initialized  HTTP 202
 1137ms  inventory  tools/list                 HTTP 200
 1680ms  notes      process started            pid 31344, cwd ...\sample13\sandbox
 1719ms  system/init mcp_servers: notes connected (dynamic) · inventory connected (dynamic) · broken failed (dynamic) · clock connected (sdk)
         tools: mcp__clock__now, mcp__inventory__list_products, mcp__inventory__reserve, mcp__notes__list_notes, ...
 3737ms  tool_use mcp__notes__search_notes {"text":"TODO"}      -> notes: tools/call search_notes, 1 hit
 3757ms  tool_use mcp__inventory__list_products {}             -> inventory: tools/call list_products
 3795ms  tool_use mcp__notes__server_process {}                -> pid 31344, parentPid 18916
 5854ms  result/success  4 turns  $0.0076
```

What this run shows:

- **Everything connects before the first turn.** The http handshake and the stdio process start both happen
  before `system/init`.
- **The stdio process is a child of Claude Code, not of the lab server.** Its `parentPid` is the Claude Code CLI
  process. Its `cwd` is `options.cwd` (the sandbox).
- **`env` is added to the environment, it does not replace it.** `server_process` reported `ANTHROPIC_API_KEY: true`
  although only `NOTES_DIR` and `LAB_LOG_URL` were in `env`. A stdio server inherits the environment, including your
  secrets. Only run stdio servers you trust.
- **`source`** is `dynamic` for servers given in `options.mcpServers` and `sdk` for in-process ones.
- **For the model, all four are the same**: `mcp__<server>__<tool>`, exactly like Concept 5.

| Scenario | Result |
|---|---|
| 1 · stdio | The notes process started, `search_notes` found `notes.txt` line 5, `server_process` returned its pid |
| 2 · http | The full handshake in *What the MCP servers saw*, then `tools/call list_products`: "4 units" |
| 3 · Wrong token (and *no headers*) | `server/discover` 401, `initialize` 401 → `inventory: failed`, `tools: []`. **`result/success`**: *"I don't have access to an inventory management tool..."* |
| 4 · A server that can't start | `broken: failed`, `notes: connected`, the answer listed `notes.txt` |
| 5 · Allow one tool | `reserve` → `system/permission_denied`, `permission_denials: ["mcp__inventory__reserve"]`, stock unchanged |
| 6 · All transports | The run above |

Two lessons from scenario 3:

1. **A failed server does not fail the run.** There is no error and no exception. The server's tools are simply
   missing, and the model answers without them. If a server is required, **check `system/init.mcp_servers`** (or
   `mcpServerStatus()`) yourself, and stop the run when it isn't `connected`.
2. **401 means `failed`, not `needs-auth`.** `needs-auth` is for servers that support the MCP OAuth flow (a 401 with
   OAuth metadata). This server only checks a static header.

---

# Part B: Managing servers while a session runs

## Step 6: The live session

The session route reuses the input queue from Concepts 10 and 12. `allowedTools` allows all four servers, so Part B
is about servers, not about permissions. Each control is one small route, wrapped in the same `control()` helper as
Concept 12 (find the session → run → `409` on error):

| Route | Calls |
|---|---|
| `POST /status` | `await q.mcpServerStatus()` |
| `POST /toggle` | `await q.toggleMcpServer(name, enabled)` |
| `POST /reconnect` | `await q.reconnectMcpServer(name)` |
| `POST /set-servers` | `await q.setMcpServers(buildServers(names))` → `{ added, removed, errors }` |
| `POST /send`, `/end` | push a user message, close the input |

The tab asks for a fresh `mcpServerStatus()` after every control, so the status table always matches the session.

## Step 7: Status, toggle and reconnect, tested

Started with `notes`, `inventory` and `broken`:

| Step | Result |
|---|---|
| `mcpServerStatus()` right after start | All three **`pending`**: MCP startup doesn't block `query()`. They connect before the first turn runs |
| after turn 1 | `notes` and `inventory` **`connected`**, with `serverInfo` (`lab-notes@1.0.0`) and their `tools`. `broken` **`failed`** with `error: "Connection closed"` |
| `toggleMcpServer("inventory", false)` | Status `disabled`. The next turn's `system/init` has no inventory tools, and the model said *"I don't have access to an inventory tool"* |
| `toggleMcpServer("inventory", true)` | The http server saw a **new handshake** (`initialize` → `tools/list`); the tools came back |
| `reconnectMcpServer("notes")` | A **new process**: pid 5240 → 16312, `uptimeMs` back to ~1,100 |
| `reconnectMcpServer("broken")` | **Throws** `Error: Connection closed` (the route answers 409) |

`mcpServerStatus()` also returns each server's full `config`, **including http `headers`**, so be careful before you
show it to users or write it to logs.

## Step 8: `setMcpServers()`, tested

The SDK comment says it "replaces the current set of dynamically-added MCP servers". A test started a session with
`notes` + `inventory` from `options.mcpServers`, then called `setMcpServers` five times:

| Call | `added` | `removed` | Servers after |
|---|---|---|---|
| (start) | | | notes, inventory |
| `setMcpServers({ clock })` | clock | – | notes, inventory, **clock** |
| `setMcpServers({ notes })` | notes | clock | notes, inventory |
| `setMcpServers({})` | – | notes | inventory |
| `setMcpServers({ notes, inventory })` | notes, inventory | – | notes, inventory (a **new** notes process) |
| `setMcpServers({})` | – | notes, inventory | (none) |

So `setMcpServers()` **replaces the set it manages**, and:

- Servers from `options.mcpServers` are **not** in that set at first. `setMcpServers({ clock })` kept them.
- **Naming** a server takes it over. `setMcpServers({ notes })` "added" notes, but kept the running process (same
  config, no restart). From then on, a call that leaves it out removes it, and its process stops.
- `sdk` servers work too: `clock` was added mid-session and `mcp__clock__now` ran in the next turn.

## What to take away

1. **Three transports, one tool name.** `stdio` (Claude Code starts a process), `http`/`sse` (Claude Code connects to
   a URL), `sdk` (your process). The model always sees `mcp__<server>__<tool>`, and `allowedTools` works the same.
2. **External configs are plain JSON.** The same objects work in `.mcp.json` or `claude mcp add`. Only `sdk` servers
   need your process.
3. **A stdio server is a child of Claude Code.** It gets `options.cwd` and inherits the whole environment, and `env`
   only adds to it.
4. **A failed server fails silently.** Check `mcp_servers[].status` in `system/init` (or `mcpServerStatus()`) when
   a server is required.
5. **Servers are live state you can manage.** In a streaming session you can disable, re-enable, restart, add and
   remove servers. Each change shows up in the next turn's `system/init`.
6. **`strictMcpConfig: true`** keeps every earlier concept's safety: only the servers you pass, never the machine's
   own MCP configuration.

## Things to try in Concept 13

1. Scenario 5 with `allowedTools: mcp__inventory`: reserve 3 monitors, then 3 more. The second call returns
   `isError` (*Only 1 unit(s) of MN-27 left.*). Press **Reset stock** afterwards.
2. In `notes-server.ts`, add a `console.log("hi")` at the top and run scenario 1 again. What status does `notes` get?
   (Remove it afterwards.)
3. In Part B, disable `notes`, then call `reconnectMcpServer("notes")`. Does reconnecting enable it again?
4. Change the notes config in `13-mcp-servers.ts` to `command: "node"` (a `PATH` lookup) instead of
   `process.execPath`, and check that it still starts on your machine.
5. Add `alwaysLoad: true` to the inventory config. The SDK says it blocks startup until the server is connected, and
   never defers its tools behind tool search. Compare the time to `system/init`.

## Running the app

Same as the other tabs: `npm run dev`, then open http://localhost:5173 and select **13. MCP servers**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

> The http server's URL and the notes log URL both use `http://localhost:3001` (the lab server). If you run the
> router on another port, set `LAB_PORT`. As with every sample, stop the other samples first: they all use port 3001.

Part A without the UI (PowerShell):

```powershell
'{"prompt":"How many 27-inch monitors are in stock?","servers":["inventory"],"allowedTools":["mcp__inventory"],"token":"right"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c13/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

Look for `event: mcp_log` lines: that is the MCP server itself, logging what it received.
