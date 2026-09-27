# Plugins in depth

This file explains how Concept 23 (**Plugins in depth**) was added to the Claude Agent SDK Lab.
Concept 11 ([Tab11-Skills.md](Tab11-Skills.md)) loaded a plugin that held one skill. A plugin can hold much more:
**slash commands, subagents, skills, hooks and MCP servers**, all in one folder that any agent can load. This concept
builds one plugin with every part and shows what each part adds to the session and how the host controls it.

**Goal:** know how each part of a plugin is found and named, how to see what a plugin added (with no model call), how
`userConfig` and `${CLAUDE_PLUGIN_ROOT}` reach the plugin's processes, where the host's permissions still apply (and
where they don't), and how to reload a plugin in a live session.

| Concept | Topic | Routes |
|---|---|---|
| 23 | `plugins` (`type: "local"`, `skipMcpDiscovery`), `.claude-plugin/plugin.json`, `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json`, namespacing (`plugin:name`), `${CLAUDE_PLUGIN_ROOT}`, `CLAUDE_PLUGIN_DATA`, `userConfig` + `settings.pluginConfigs`, `strictMcpConfig`, `pluginDelivery` + `initializationResult().plugins_applied`, `supportedAgents()`, `mcpServerStatus()`, `reloadPlugins()` (`error_count`, `holdOnCacheImpact`), plugin hooks vs `allowedTools` / `disallowedTools` | `/api/c23/plugins`, `/reset`, `/inventory`, `/run` (SSE), `/reload` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `plugins/atmira-ops/` | **New**: a plugin with a manifest, a command, an agent, a skill, hooks and an MCP server |
| `plugins/atmira-extra/` | **New**: a plugin with no manifest and a command with the same file name |
| `plugins/broken/` | **New**: a plugin whose `plugin.json` is invalid JSON |
| `server/concepts/23-plugins.ts` | **New**: the five routes |
| `server/index.ts` | Mounts the router on `/api/c23` |
| `src/concepts/Concept23Plugins.tsx` | **New**: the tab (Parts A to D) |
| `src/App.tsx` | Adds the tab |
| `.gitignore` | Ignores `plugins-lab/` |
| `Tab1-query().md` | Adds Concept 23 to the table |
| `Tab23-Plugins.md` | This explanation |

---

## Step 1: One plugin, every part

```
plugins/atmira-ops/                       loaded with { type: "local", path: "plugins/atmira-ops" }
├── .claude-plugin/plugin.json            name "atmira-ops" (the namespace), version 2.1.0, userConfig.team
├── commands/standup.md                   → /atmira-ops:standup <your name>
├── agents/reviewer.md                    → subagent_type "atmira-ops:reviewer"
├── skills/ticket-format/SKILL.md         → Skill "atmira-ops:ticket-format"
├── hooks/hooks.json                      → SessionStart + PreToolUse, both run hooks/audit.mjs
├── hooks/audit.mjs
├── .mcp.json                             → MCP server "plugin:atmira-ops:tickets"
├── mcp/tickets.mjs                          tools list_tickets, get_ticket, server_info
└── data/tickets.json

plugins/atmira-extra/commands/standup.md  no manifest: the name is the folder name
plugins/broken/.claude-plugin/plugin.json invalid JSON (a trailing comma)
```

No part is registered in code: **each one is found by its place in the folder**, and every name gets the plugin's
name in front. The manifest is optional. Without it (`atmira-extra`) the folder name is used and there is no version.

The files that point at the plugin's own folder use `${CLAUDE_PLUGIN_ROOT}`, because the plugin can be installed
anywhere:

```json
// .mcp.json
{ "mcpServers": { "tickets": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/tickets.mjs"],
    "env": { "TICKETS_FILE": "${CLAUDE_PLUGIN_ROOT}/data/tickets.json", "ATMIRA_TEAM": "${user_config.team}" } } } }

// hooks/hooks.json
{ "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/audit.mjs\"" }] }],
    "PreToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/audit.mjs\"" }] }] } }
```

`audit.mjs` adds one line of context at SessionStart (*"Sign every answer about tickets with '— atmira-ops'"*),
denies `get_ticket` for `ATM-999`, and appends one JSON line per call to `$ATMIRA_AUDIT_LOG`, the file the lab reads.

## Step 2: The options

```ts
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: WORK,                                             // plugins-lab/work, an empty folder
  settingSources: [],                                    // only the plugins listed here
  settings: { disableBundledSkills: true },
  plugins: [{ type: "local", path: "plugins/atmira-ops" }],
  tools: ["Skill", "Agent"],                             // Skill runs commands and skills, Agent runs agents
  allowedTools: ["mcp__plugin_atmira-ops_tickets__*", "Skill", "Agent"],
  persistSession: false,
  maxTurns: 8,
};
// every run: env: { ...process.env, CLAUDE_CONFIG_DIR: "plugins-lab/home", ATMIRA_AUDIT_LOG: "<a file per run>" }
```

**Why a fake `CLAUDE_CONFIG_DIR`.** Loading a plugin creates its data folder, `CLAUDE_PLUGIN_DATA`, under
`<config dir>/plugins/data/atmira-ops-inline/`. In the first probe, without a fake home, the folder appeared in the
real `~/.claude/plugins/data/`. The lab therefore always points `CLAUDE_CONFIG_DIR` at `plugins-lab/home`, and the
run authenticates with `ANTHROPIC_API_KEY` from `.env`.

## Step 3: What the session sees, with no model call

`POST /inventory` starts a session whose prompt never sends anything, asks the control methods, and closes it. Cost:
$0. With `atmira-extra` and `broken` added:

```text
reloadPlugins().plugins   atmira-ops@inline 2.1.0, atmira-extra@inline, agents-md@builtin, telemetry@builtin
reloadPlugins().error_count   1                        <- broken is not in the list
initializationResult().commands
   /atmira-ops:standup <your name>
   /atmira-extra:standup
   /atmira-ops:ticket-format                 aliases: ticket-format
initializationResult().agents   atmira-ops:reviewer (+ 5 built-in: claude, Explore, general-purpose, Plan, statusline-setup)
mcpServerStatus()         plugin:atmira-ops:tickets  connected  scope "dynamic"  source "plugin"
                          tools list_tickets, get_ticket, server_info
the plugin's hooks        SessionStart (it runs even though no prompt was sent)
```

- **Namespacing avoids clashes.** Both plugins have `commands/standup.md`, and both exist side by side.
- **A plugin that fails to load is silent.** `broken` is not in `init.plugins`, not in the commands, and nothing is
  written to stderr. Only `reloadPlugins().error_count` counts it. Call it after start-up if you need to know.
- **Plugin MCP servers start in the background.** Straight after `initializationResult()` the server is still
  `pending`. The route polls `mcpServerStatus()` until it is not.
- In `system/init` (Part C) the same plugin is in `plugins` as `{ name, path, source: "atmira-ops@inline", version }`,
  its server in `mcp_servers` with `source: "plugin"`, and its tools as `mcp__plugin_atmira-ops_tickets__<tool>`.

## Step 4: Each part at work

| # | Prompt | What happened | Cost |
|---|---|---|---|
| 1 | `/atmira-ops:standup Ana` | Expanded by the CLI (no `Skill` call) → `list_tickets` → *🧭 Stand-up for Ana · Open: 3 · Top: ATM-101* · *— atmira-ops* | $0.0067, 2 turns |
| 2 | `/standup Ana` | **Not expanded.** The model called `Skill("atmira-ops:standup")` itself, with no `args` | $0.0085, 4 turns |
| 3 | *Write a ticket: the login page freezes on Safari.* | `Skill("atmira-ops:ticket-format", args)` → *🎫 ATM-NEW · Fix login page freezing on Safari* | $0.0078 |
| 4 | *Get ticket ATM-102, then ask the atmira-ops:reviewer agent…* | `get_ticket` → `Agent(subagent_type: "atmira-ops:reviewer")` → *Clear: no* | $0.0111 |
| 7 | *Get ticket ATM-999…* | The plugin's hook denied it: *"hook error: atmira-ops: ATM-999 is confidential."*, listed in `permission_denials` | $0.0074 |
| 8 | `/atmira-extra:standup` | *🪐 atmira-extra stand-up…* | $0.0055, 1 turn |

- **Use the full name.** The `aliases: ["ticket-format"]` of the skill and the short `/standup` were never expanded by
  the CLI. The model received the text and called `Skill` itself. That costs extra turns, and in one probe it
  dropped the argument (*"🧭 Stand-up for "*). Plugin commands are also callable through `Skill`, like skills.
- **The SessionStart hook's context works:** every answer about tickets ended with *— atmira-ops*.
- **Plugin agents run in the background** by default (as in Concepts 8 and 11). `background: false` in the agent's
  frontmatter was tried and **ignored**. The lab adds its own `PreToolUse` hook on `Agent` that sets
  `run_in_background: false`. On that one `Agent` call, **the host's hook and the plugin's hook both ran**.

## Step 5: `userConfig`

The manifest declares an option with a default:

```json
"userConfig": { "team": { "type": "string", "title": "Team name", "description": "...", "default": "Orbit" } }
```

and the host sets it through `settings`, keyed by the plugin id (`<name>@inline` for a local plugin):

```ts
settings: { pluginConfigs: { "atmira-ops@inline": { options: { team: "Nebula" } } } }
```

| # | Setup | `server_info` (the MCP process) | The hook process |
|---|---|---|---|
| 5 | no `pluginConfigs` | `team: "Orbit"`: `${user_config.team}` took the default | only `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` |
| 6 | `team: "Nebula"` | `team: "Nebula"` | **+ `CLAUDE_PLUGIN_OPTION_TEAM=Nebula`** |

The **default reaches `${user_config.…}` but not the hooks**: `CLAUDE_PLUGIN_OPTION_TEAM` exists only when a value
was set. A hook script should have its own fallback.

## Step 6: MCP servers: `skipMcpDiscovery` and `strictMcpConfig`

| # | Option | Plugin server | The rest of the plugin |
|---|---|---|---|
| 9 | `{ type: "local", path, skipMcpDiscovery: true }` | not started | commands, agent, skill and hooks load |
| 10 | `strictMcpConfig: true` | **dropped too** | loads |

Both runs answered *NO TICKETS TOOL*. `skipMcpDiscovery` is for a host that runs the plugin's server itself.
`strictMcpConfig` is easy to miss: most earlier concepts set it, and **with it no plugin MCP server starts**.
(In the first probes, without *"no agent"* in the prompt, the model sent the Explore subagent to look for ticket
files instead.)

## Step 7: Whose permissions?

| # | Setup | `list_tickets` |
|---|---|---|
| 11 | no `mcp__plugin_atmira-ops_tickets__*` rule | **denied**: *"…you haven't granted it yet."* Loading a plugin does not approve its tools |
| 12 | same, and the plugin's hook answers `permissionDecision: "allow"` | **ran**, with no rule from the host |
| 13 | same, plus `disallowedTools: ["mcp__plugin_atmira-ops_tickets__list_tickets"]` | **gone**: `init` lists 2 MCP tools, the model says it has no such tool |

Scenario 12 is the reason to review a plugin before you load it. **A plugin's hooks run with the same power as your
own hooks**: they can approve tools (here any tool, not only the plugin's), change inputs, and run any program on
your machine. In the lab, `ATMIRA_AUTO_APPROVE=1` switches this on in `audit.mjs`. `disallowedTools` is stronger,
because a removed tool never reaches a hook. In 13 the hook still approved `server_info`, which the host had not
allowed either.

## Step 8: `pluginDelivery`

```ts
pluginDelivery: "initialize"   // default "argv": one --plugin-dir flag per plugin
```

The plugin list goes over stdin in the initialize request. Windows refuses a command line over 32,767 characters, so
this matters with many plugins or long paths. `initializationResult().plugins_applied` is `true` only in this mode.
With `"argv"` it is `undefined`. Loading is otherwise the same (scenario 14 and Part B).

## Step 9: `reloadPlugins()` in a live session

`POST /reload` works on a **copy** of `atmira-ops` (`plugins-lab/live-plugin`), so the committed plugin is never
edited. The copy keeps its name, `atmira-ops`, from `plugin.json`.

| Step | Plugin commands | Plugin agents |
|---|---|---|
| 1. Session open | standup, ticket-format | reviewer |
| 2. Wrote `commands/live.md` and `agents/summarizer.md` | **same**: not seen yet | **same** |
| 3. `await q.reloadPlugins({ holdOnCacheImpact: true })` | **live**, standup, ticket-format | reviewer, **summarizer** |
| 4. Prompt `/atmira-ops:live` | *⚡ live command (written after the session started…)*, 1 turn, $0.0055 | |
| 5. Added `tickets2` to `.mcp.json`, `reloadPlugins()` | `mcpServers`: still only `plugin:atmira-ops:tickets` | |

- **`holdOnCacheImpact`** returned `held: false`: the check ran and nothing in the tool list changed.
- **An edited `.mcp.json` was not picked up** by `reloadPlugins()` in this version (step 5), and the model saw no
  `tickets2` tools either. Commands, agents and skills are reloaded, MCP servers from the file are not. Start a new
  session after changing a plugin's MCP config.
- `reloadPlugins()` is a control request, so it needs streaming input (Concept 12). After the first prompt's
  result, the input generator stays open so step 5 can still run. The route calls `next()` by hand instead of
  `break`, because `break` out of `for await` would call `q.return()` and end the session.

## Step 10: Server routes

**File:** [server/concepts/23-plugins.ts](server/concepts/23-plugins.ts)

- `GET /plugins`: every folder in `plugins/`, with its manifest (or the JSON error) and each file with its part
  (`manifest`, `command`, `agent`, `skill`, `hooks`, `mcp`, `file`) and content.
- `POST /reset`: recreates `plugins-lab/` (also done when the server starts).
- `POST /inventory` `{ switches }`: JSON. The session with no prompt from Step 3, closed after the answer.
- `POST /run` `{ prompt, switches }`: SSE. `options`, `control` (`plugins_applied`), an `audit` event per line the
  plugin's hook wrote, and the messages. Stops after 120 s.
- `POST /reload`: SSE. The five steps as `step` events, plus the messages of step 4.

The switches are **names** checked against a fixed list: `noPlugins`, `extra`, `broken`, `skipMcp`, `strict`,
`initialize`, `team`, `noAllow`, `autoApprove`, `denyList`. Paths are sent relative to the sample folder, and `env`
is shown only as the three variables the lab adds (it holds the API key). The per-run audit file is deleted when
the response closes.

## Step 11: Browser flow

**File:** [src/concepts/Concept23Plugins.tsx](src/concepts/Concept23Plugins.tsx)

1. **A · The plugins on disk**: each folder, its manifest (or ⚠ the JSON error), and its files tagged by part. Click
   one to read it.
2. **B · What the session sees**: pick plugins and options, then **Open a session (no model call)**: plugins with
   `error_count`, commands with aliases, plugin agents, MCP servers with their tools, and the SessionStart hook line.
3. **C · A run**: 14 scenarios. The cards show `system/init` (plugins, servers, MCP tools, plugin commands, skills,
   agents), the plugin's hook calls with their `CLAUDE_PLUGIN_*` variables, every tool call with its result (the
   subagent's report unwrapped), the answer, and `result` with `permission_denials`.
4. **D · Reloading plugins**: the five steps in a table and the live command's answer.

## What to take away

1. **A plugin is a folder, and the place of a file is its registration.** `commands/`, `agents/`, `skills/`,
   `hooks/hooks.json` and `.mcp.json`, each namespaced with the manifest name (or the folder name).
2. **Call plugin commands by their full name.** `/atmira-ops:standup` is expanded by the CLI. `/standup` is not.
3. **Check what loaded.** `reloadPlugins().error_count` is the only sign of a broken plugin. `init.plugins`,
   `initializationResult()` and `mcpServerStatus()` (`source: "plugin"`) show the rest, with no model call.
4. **`${CLAUDE_PLUGIN_ROOT}` makes a plugin portable. `CLAUDE_PLUGIN_DATA` lives in the config dir**, so point
   `CLAUDE_CONFIG_DIR` somewhere you control on a server.
5. **`userConfig` defaults fill `${user_config.x}`. Only set values become `CLAUDE_PLUGIN_OPTION_X`.**
6. **`strictMcpConfig: true` drops plugin MCP servers.** `skipMcpDiscovery` does it for one plugin.
7. **Trust is the host's job.** Plugin tools need your `allowedTools` rules, but a plugin *hook* can approve anything.
   Review hooks before loading a plugin, and use `disallowedTools` for what must never run.
8. **`reloadPlugins()` reloads commands, agents and skills in a live session, but not `.mcp.json`.**

## Things to try in Concept 23

1. Part B with each switch. Then fix the trailing comma in `plugins/broken/.claude-plugin/plugin.json` and open a
   session again: `error_count` drops to 0 and `/broken:hello` appears.
2. Delete `.claude-plugin/plugin.json` from a copy of `atmira-ops` and load it: every name changes to the folder name.
3. **5** then **6**, and compare the hook lines: `CLAUDE_PLUGIN_OPTION_TEAM` appears only in 6.
4. **11**, **12**, **13** in order, and read `audit.mjs` to see the one line that made 12 possible.
5. Add `"model": "sonnet"` to `agents/reviewer.md`, open a session in Part B, and check the agent's model.
6. Change `LIVE_COMMAND` in the server and run Part D again.

Costs on Haiku: $0 for Part B, $0.003 to $0.011 per scenario in Part C, and about $0.006 for Part D.

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite URL and select **23. Plugins**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps. `ANTHROPIC_API_KEY` must be in
`.env`, because every run uses the fake `CLAUDE_CONFIG_DIR`. The plugin's hook and MCP server run with `node` from
your `PATH`.

To call the endpoints without the UI:

```powershell
curl.exe http://localhost:3001/api/c23/plugins

'{"switches":["extra","broken"]}' | Set-Content body.json
curl.exe -X POST http://localhost:3001/api/c23/inventory -H "Content-Type: application/json" -d "@body.json"

'{"prompt":"/atmira-ops:standup Ana","switches":["team"]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c23/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json

curl.exe -N -X POST http://localhost:3001/api/c23/reload
curl.exe -X POST http://localhost:3001/api/c23/reset
```
