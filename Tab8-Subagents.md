# Concept 8: Subagents with `options.agents` and the `Agent` tool, step by step

This file explains how Concept 8 (**Subagents**) was added to the Claude Agent SDK Lab.
It builds on Concept 3 ([Tab3-Built-in-tools.md](Tab3-Built-in-tools.md)) for the `sandbox/` folder, on Concept 4
([Tab4-Permissions.md](Tab4-Permissions.md)) for permission rules, and on Concept 7 ([Tab7-Hooks.md](Tab7-Hooks.md)) for
hooks.

**Goal:** let the main agent hand parts of a task to specialist agents. Each one has its own system prompt, tools and
model, and each one sends back a single report.

| Concept | Topic | Route |
|---|---|---|
| 8 | Subagents: `options.agents` + the `Agent` tool | `/api/c8/query` |

## Step 1: Defining subagents

Subagents are set in `Options.agents`: a map from a **name** to an `AgentDefinition`:

```ts
const options: Options = {
  tools: ["Agent", "Read", "Glob", "Grep", "Write"], // "Agent" is what lets the main agent delegate
  agents: {
    researcher: {
      description: "Reads files in the working folder and answers questions about them.", // read by the main agent
      prompt: "You are a researcher. ...",                                                 // the subagent's system prompt
      tools: ["Read", "Glob", "Grep"],                                                     // omit = inherit all tools
      model: "haiku",                                                                      // alias, full id or "inherit"
    },
  },
};
```

| Field | What it does |
|---|---|
| `description` | The main agent reads it to decide **when** to use this subagent. Write it like a job title plus limits. |
| `prompt` | The subagent's system prompt. |
| `tools` | Which tools it may use. Omitted = all of the parent's. `[]` = none. |
| `model` | `"haiku"`, `"sonnet"`, `"opus"`, a full model id, or `"inherit"` (same model as the main agent). |
| `disallowedTools`, `maxTurns`, `effort`, `permissionMode`, `background`, ... | Other limits for this one agent. |

The main agent then calls the built-in `Agent` tool:

```json
{ "subagent_type": "researcher", "description": "Find open tasks", "prompt": "Read data/tasks.json and ..." }
```

**The subagent starts with a fresh context.** It sees only its own system prompt and that `prompt`, not the
conversation. Whatever it needs has to be in the prompt the main agent writes.

## Step 2: Following a subagent in the stream

Everything a subagent does is tagged with the id of the `Agent` tool_use that started it:

| Message | `parent_tool_use_id` |
|---|---|
| Main agent's `assistant` / `user` messages | `null` |
| Subagent's `assistant` (tool_use) and `user` (tool_result) messages | the `Agent` tool_use id |

By default only the subagent's **tool** blocks are forwarded. `forwardSubagentText: true` also forwards its text, so
you can show a full nested transcript.

The SDK also emits `system` messages for each subagent:

| Message | Useful fields |
|---|---|
| `system/task_started` | `tool_use_id`, `subagent_type`, `is_backgrounded`, `prompt` |
| `system/task_notification` | `tool_use_id`, `status`, `summary`, `usage.{total_tokens, tool_uses, duration_ms}` |

And two hook events: `SubagentStart` (`agent_id`, `agent_type`) and `SubagentStop` (`last_assistant_message`, plus
`agent_transcript_path`).

## Step 3: Foreground vs background

In this SDK version, the `Agent` tool **runs subagents in the background by default**. Its input has a
`run_in_background` flag, and the model usually leaves it unset. In the background:

1. The `Agent` tool_result is only `"Async agent launched successfully..."`.
2. The main agent answers right away, and the first `result` arrives **before** the subagent is done.
3. The report comes later in `task_notification.summary`. It wakes the main agent up again, which gives a second turn
   and a **second `result`**.

That is right for long jobs, but confusing for a first look. So the route has a `foreground` switch: a Concept 7
`PreToolUse` hook that rewrites every `Agent` call:

```ts
const foreground: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolInput = input.tool_input as Record<string, unknown>;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",                                   // updatedInput needs "allow"
      updatedInput: { ...toolInput, run_in_background: false },
    },
  };
};
// hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [foreground] }] }
```

In the foreground the main agent waits, and the report **is** the `Agent` tool_result.

## Step 4: Server route

**File:** [server/concepts/08-subagents.ts](server/concepts/08-subagents.ts)

The browser sends which subagents to define, the session `tools`, `forwardSubagentText` and `foreground`. The server
has three definitions, and each one shows a different setting:

| Subagent | `tools` | `model` | Shows |
|---|---|---|---|
| `researcher` | `Read`, `Glob`, `Grep` | `haiku` | A read-only specialist on a cheaper model |
| `writer` | `Read`, `Write` | `inherit` | The only one that can change files |
| `critic` | `[]` | (default) | No tools: it only reasons over the text in its prompt |

Other settings, and why:

| Setting | Why |
|---|---|
| `permissionMode: "acceptEdits"` | Subagents use the same permission rules as the main agent. This lets the writer's `Write` run inside `cwd`. |
| `settingSources: []` | Without it, agents from your own `~/.claude/agents/` would be offered too. |
| `disallowedTools: ["Agent(general-purpose)", "Agent(Explore)", ...]` | Claude Code always offers its **built-in** subagents, and the model often picks `general-purpose` over yours. The permission rule `Agent(<name>)` blocks one subagent type and keeps the `Agent` tool. |
| `SubagentStart` / `SubagentStop` hooks | They only observe. Each call is streamed as a `hook` SSE event. |

`GET /api/c8/agents` returns the three definitions, so the UI table shows exactly what the server uses.

## Step 5: Browser flow

**File:** [src/concepts/Concept08Subagents.tsx](src/concepts/Concept08Subagents.tsx)

1. Pick a scenario, or tick subagents, tools and switches yourself.
2. **Run query() with subagents** posts `{ prompt, tools, agents, forwardSubagentText, foreground }` to `/api/c8/query`.
3. `buildDelegations()` groups the flat stream by the `Agent` tool_use id. Each group gets the input, the subagent's
   steps (messages whose `parent_tool_use_id` matches), `task_started` / `task_notification`, and the report.
4. The **delegations** card shows one block per subagent run: its prompt (all it knows), its tool calls, and its
   report.
5. The main agent's answer only uses messages with `parent_tool_use_id: null`. Every `result` is shown, because a
   background run has two.

## Things to try in Concept 8

1. **1 · Delegate**: find the researcher's `Read` in the raw stream and check its `parent_tool_use_id`.
2. **2 · Pick by description**: the prompt names no agent, and the main agent picks `writer`. Remove "Delegate to the
   best-suited subagent:" from the prompt: the main agent usually does the job itself, since it has the same tools.
3. **3 · Chain**: read the critic's prompt. The main agent copied the list into it, because the critic can't see
   anything else.
4. **4 · Parallel**: both `task_started` messages arrive before either `task_notification`.
5. **5 · Tool isolation**: the researcher has no `Write`, even though the session does, so it can only explain why it
   can't do the job.
6. **6 · Forward text**: compare with scenario 1. The subagent's own text is now in the delegation.
7. **7 · No Agent tool**: the agents are defined, but without `"Agent"` in `tools` nothing is delegated.
8. **8 · Background**: the default mode. Look for the placeholder tool_result, `task_notification.summary`, and the
   two `result` cards.
9. Untick `Write` in `tools` and run scenario 2: the writer only has `Read` left. A subagent gets the tools in both
   its own list and the session pool.
10. Ask the writer for `summary.md`: Claude Code refuses a subagent's `Write` of a report-like file ("Subagents should
    return findings as text..."), and the main agent writes it itself.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/08-subagents.ts` | New route with three `AgentDefinition`s, the `foreground` hook and subagent hooks |
| `server/index.ts` | Mounts the route on `/api/c8` |
| `src/concepts/Concept08Subagents.tsx` | Subagents UI with scenarios and a card per delegation |
| `src/App.tsx` | Adds the Subagents tab |
| `src/styles.css` | Styles for delegation blocks |
| `Tab8-Subagents.md` | This explanation |
| `README.md` | The steps followed to build this concept, and what the tests changed |
