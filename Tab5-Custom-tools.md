# Concept 5: Custom tools with `createSdkMcpServer` + `tool()`, step by step

This file explains how Concept 5 (**Custom tools**) was added to the Claude Agent SDK Lab, in the order the work was done.
It builds on Concepts 3 and 4 ([Tab3-Built-in-tools.md](Tab3-Built-in-tools.md), [Tab4-Permissions.md](Tab4-Permissions.md)):
the agent can already use Claude Code's built-in tools, and you decide which calls may run.

**Goal:** give the agent tools that **you** write. A custom tool is a TypeScript function in this Node server. The SDK
exposes it to the model through an **in-process MCP server**, so there is no extra process, port or config file.

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/05-custom-tools.ts` | **New**: two MCP servers (`tasks`, `clock`), `POST /query`, `GET /tools`, `GET /tasks` |
| `server/index.ts` | Mount the new router on `/api/c5` |
| `src/concepts/Concept05CustomTools.tsx` | **New**: the Concept 5 tab |
| `src/App.tsx` | Add the tab to the navigation |
| `src/styles.css` | Style for the collapsible "Tool definitions" card |
| `Tab1-query().md` | Status table, project structure, Step 9 section |

---

## Step 1: Read the two functions in the SDK

The dependencies were installed (`npm install`, `npm rebuild esbuild`), then `sdk.d.ts` (version `0.3.281`) was searched:

```ts
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,                                   // a zod "raw shape": { title: z.string(), ... }
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean },
): SdkMcpToolDefinition<Schema>;

function createSdkMcpServer(options: {
  name: string; version?: string; instructions?: string;
  tools?: SdkMcpToolDefinition<any>[];
  alwaysLoad?: boolean; timeout?: number;
}): McpSdkServerConfigWithInstance;                     // { type: "sdk", name, instance: McpServer }

// Options
mcpServers?: Record<string, McpServerConfig>;           // stdio, sse, http, or "sdk" (in-process)
```

What the types say:

- The schema is a zod **shape** (a plain object of zod types), not `z.object(...)`. Zod 3 and Zod 4 both work.
- `args` in the handler is **typed from the schema**: `{ title: string }`, with no casting.
- The handler returns an MCP `CallToolResult`: `{ content: [{ type: "text", text }], isError? }`.
  The SDK doesn't re-export that type, so the code takes it from the handler's return type:
  ```ts
  type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;
  ```
- The server config contains a **live** `McpServer` object (`instance`). It can't be serialized, so it can't go into a
  settings file. It only exists in the process that called `query()`.

## Step 2: Write the tools

**New file:** [server/concepts/05-custom-tools.ts](server/concepts/05-custom-tools.ts).

Two servers, chosen so that each one shows something built-in tools can't do:

| Server | Tool | Schema | What it shows |
|---|---|---|---|
| `tasks` | `list_tasks` | `{ status: z.enum(["all","open","done"]).default("all") }` | Read your app's data. `readOnlyHint: true` |
| `tasks` | `add_task` | `{ title: z.string().min(3).max(60) }` | Change data with your own code. zod rules are enforced |
| `tasks` | `complete_task` | `{ id: z.number().int().positive() }` | Return `isError: true` when the id doesn't exist |
| `clock` | `now` | `{ timeZone: z.string().optional() }` | Give the model a fact it can't know: the current time |

The `tasks` tools edit `sandbox/data/tasks.json`, the file Concept 3 seeds, so **Reset sandbox/** puts it back.
Each handler follows the same pattern:

```ts
tool(
  "complete_task",
  "Mark a task as done, by id.",
  { id: z.number().int().positive().describe("The task id") },
  async ({ id }) => {                    // id: number, inferred from the schema
    const all = await readTasks();
    const task = all.find((t) => t.id === id);
    if (!task) return fail(`No task with id ${id}. Existing ids: ...`);   // { content, isError: true }
    task.done = true;
    await saveTasks(all);
    return ok(task);                                                       // { content: [{ type: "text", text: JSON }] }
  },
);
```

`.describe()` is worth adding to every field: the text goes into the JSON Schema, and the model reads it.

## Step 3: Build one server set per run

```ts
const defs = makeTools((server, toolName, args, result) => send("tool_handler", { server, toolName, args, result }));
const mcpServers = Object.fromEntries(
  body.servers.map((name) => [name, createSdkMcpServer({ name, version: "1.0.0", tools: defs[name] })]),
);

query({ prompt, options: { tools: body.tools, mcpServers, allowedTools, cwd: SANDBOX, settingSources: [], strictMcpConfig: true } });
```

Three decisions:

1. **A new server per `query()`.** The server holds a live `McpServer` instance. Creating it per run also lets each
   run's handlers send SSE events to **that** run's browser tab.
2. **Every handler is wrapped** (`logged(...)`), so the UI gets a `tool_handler` event with the exact arguments your
   code received and the result it returned. This is how you can see that the zod check happens **before** your code.
3. **`strictMcpConfig: true`** (from Concept 3) keeps the machine's own MCP servers out. `system/init → mcp_servers`
   lists only `tasks` and/or `clock`, with `"source": "sdk"`.

The echoed `options` event replaces `instance` with `"[McpServer]"`, because a live object can't be sent as JSON.

## Step 4: Show what the model receives

`GET /api/c5/tools` turns each zod shape into the JSON Schema that is sent to the model, using Zod 4's `z.toJSONSchema`:

```json
{
  "name": "mcp__tasks__add_task",
  "inputSchema": {
    "type": "object",
    "properties": { "title": { "type": "string", "minLength": 3, "maxLength": 60, "description": "Short title, 3 to 60 characters" } },
    "required": ["title"],
    "additionalProperties": false
  }
}
```

Note the name: the model never sees `add_task`, it sees **`mcp__<server>__<tool>`**. You use that same name in
`allowedTools`, in `canUseTool`, in `permission_denials` and (in Concept 7) in hooks.

## Step 5: Write the React tab

**New file:** [src/concepts/Concept05CustomTools.tsx](src/concepts/Concept05CustomTools.tsx), registered in [src/App.tsx](src/App.tsx).

- Checkboxes for `mcpServers` (`tasks`, `clock`) and for built-in `tools` (`Read`, `Write`, `Bash`), plus an `allowedTools` field.
- **Tool definitions** (collapsible): the JSON Schema of every tool, from `GET /api/c5/tools`.
- **sandbox/data/tasks.json**: the file before and after the run.
- **system/init**: the `mcp_servers` and their status, and the full `tools` list with the `mcp__` names.
- **Tool calls**: each `tool_use` paired with its `tool_result`, as in Concept 3.
- **Handler ran in the server**: the `tool_handler` events. If a tool call has no matching entry here, your code never ran.
- **Eight scenario buttons**, one lesson each.

## Step 6: Type-check and test every scenario

`npx tsc -p .` exited with 0 and `npx vite build` succeeded. A Node script then ran each scenario against the server
with Haiku and printed the `tool_use`, `tool_result` and `tool_handler` events:

| Scenario | `allowedTools` | Result |
|---|---|---|
| 1 · Something the model can't know | `mcp__clock` | `now({ timeZone: "Europe/Madrid" })` ran; the answer has the real time |
| 2 · Allow one tool | `mcp__tasks__list_tasks` | All 4 tools in `init.tools`; `list_tasks({ status: "open" })` ran |
| 3 · Tools that change data | `mcp__tasks` | `add_task` → id 4, `complete_task(3)`, `list_tasks`; `tasks.json` changed on disk |
| 4 · Handler returns `isError` | `mcp__tasks` | Handler returned `isError: true`; the model said task 99 doesn't exist and listed the real ids |
| 5 · zod rejects the input | `mcp__tasks` | `tool_result` is `MCP error -32602: Input validation error ... too_small`; **no handler event** |
| 6 · Not in `allowedTools` | (none) | `is_error`: *"Claude requested permissions to use mcp__clock__now, but you haven't granted it yet."*; listed in `permission_denials` |
| 7 · Server not attached | `mcp__clock, mcp__tasks` | `init.tools` has only `mcp__clock__now`; the model asked which task system the user meant |
| 8 · Built-in + custom | `mcp__tasks__add_task` | `Read notes.txt` (not asked: read-only), then `add_task` for the TODO line |

An invalid time zone (`Mars/Olympus_Mons`) was also tried: the handler caught the `RangeError` and returned `isError: true`.
Each run cost about $0.004 to $0.012 with Haiku. `sandbox/` was reset after the tests.

## What to take away

1. **A custom tool is a function plus a schema.** `tool()` pairs them, `createSdkMcpServer()` groups them, and
   `options.mcpServers` hands them to `query()`. It all runs in your process, so a handler can use your database,
   your APIs and your in-memory state.
2. **The model sees `mcp__<server>__<tool>`.** Use that name everywhere: `allowedTools`, `canUseTool`, `permission_denials`.
   `mcp__tasks` allows a whole server.
3. **zod is enforced before your code runs** (scenario 5). Invalid input never reaches the handler; the model gets a
   validation error and can fix its call. Put limits in the schema, not in `if` statements.
4. **Report failures with `isError: true`** (scenario 4), with a message the model can act on. It is the tool
   equivalent of the deny `message` in Concept 4.
5. **Custom tools are not trusted automatically** (scenario 6). They go through the same permission check as `Write`.
   `readOnlyHint` is only a hint to the client: it didn't skip the check. Allow them in `allowedTools` or answer in `canUseTool`.
6. **`allowedTools` never adds tools** (scenario 7). If the server is not in `mcpServers`, the tool doesn't exist.
7. **The permission check guards the call, not your code.** Once a call is allowed, the handler runs with all the
   rights of your server. `add_task` wrote to disk without `Write` being enabled. Validate inside the handler anything
   the schema can't express.

## Running the app

Everything in [Tab2-Options.md → Running the app](Tab2-Options.md#running-the-app) applies, using the `sample5` folder.
Then open **http://localhost:5173** and select **5. Custom tools**.

To call the endpoint without the UI (PowerShell):

```powershell
'{"prompt":"What time is it now in Madrid?","model":"claude-haiku-4-5-20251001","servers":["clock"],"tools":[],"allowedTools":["mcp__clock"],"permissionMode":"default"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c5/query -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json

curl.exe http://localhost:3001/api/c5/tools   # the JSON Schema of every tool
curl.exe http://localhost:3001/api/c5/tasks   # the current sandbox/data/tasks.json
```

Look for `event: tool_handler` lines between the `event: message` lines: that is your handler running.
