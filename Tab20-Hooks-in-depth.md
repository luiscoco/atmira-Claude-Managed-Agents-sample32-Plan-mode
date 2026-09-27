# Concept 20: Hooks in depth, the whole agent loop

This file explains how Concept 20 (**Hooks in depth**) was added to the Claude Agent SDK Lab.
Concept 7 ([Tab7-Hooks.md](Tab7-Hooks.md)) hooked tool calls with `PreToolUse` and `PostToolUse`. `options.hooks`
accepts every name in `HOOK_EVENTS`, so you can also run code when the prompt arrives, when a call would ask for
permission, when a call fails, around a subagent, and when the model wants to **stop**.

**Goal:** know which events really fire in an SDK run, what each one can answer, and how a hook fails.

| Concept | Topic | Routes |
|---|---|---|
| 20 | `HOOK_EVENTS`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse` `updatedToolOutput`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStart` / `SubagentStop`, `MessageDisplay`, `systemMessage`, `continue: false`, `timeout`, `{ async: true }` | `/api/c20/run` (SSE), `/files`, `/file`, `/reset` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/20-hooks-in-depth.ts` | **New**: the routes and the 11 example hooks |
| `server/index.ts` | Mounts the router on `/api/c20` |
| `src/concepts/Concept20HooksInDepth.tsx` | **New**: the tab (scenarios, events grid, timeline) |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The events grid and dimmed observer rows |
| `.gitignore` | Ignores `hooks-lab/` |
| `Tab1-query().md` | Adds Concept 20 to the table |
| `Tab20-Hooks-in-depth.md` | This explanation |

---

## Step 1: Which events fire in an SDK run

`HOOK_EVENTS` (SDK `0.3.281`) has 33 names. A probe registered a callback on **all** of them and ran several
prompts. These are the events that reached a callback, in the order they fire:

| Event | When | Main `input` fields |
|---|---|---|
| `UserPromptSubmit` | Before the prompt reaches the model | `prompt` |
| `PreToolUse` | Before a tool call | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | The call would "ask" (no allow rule, no `canUseTool`) | `tool_name`, `tool_input`, `permission_suggestions` |
| `PostToolUse` | After a call that worked | + `tool_response`, `duration_ms` |
| `PostToolUseFailure` | After a call that failed (`PostToolUse` does **not** fire) | + `error` |
| `PostToolBatch` | After all the calls of one turn | `tool_calls[]` |
| `SubagentStart` / `SubagentStop` | Around a subagent | `agent_id`, `agent_type`, `last_assistant_message` |
| `MessageDisplay` | Each assistant text block | `delta`, `final` |
| `Stop` | The model wants to finish | `stop_hook_active`, `last_assistant_message` |

Inside a subagent, `PreToolUse` / `PostToolUse` fire too, and their input carries `agent_id` and `agent_type`.

**What did not fire (tested):**

- `SessionStart` and `SessionEnd`, with a string prompt and in streaming input mode. Their `additionalContext`
  never reached the model.
- `PermissionDenied`, even in `permissionMode: "dontAsk"`. A `system/permission_denied` message is streamed instead.
- `includeHookEvents: true` added no `hook_started` / `hook_response` messages for callback hooks.

## Step 2: What a hook can answer

Valid on **every** event:

| Answer | Effect |
|---|---|
| `{}` | No opinion |
| `systemMessage` | Shown to the **user** as a `system/informational` message. The model never sees it. |
| `continue: false`, `stopReason` | Ends the run |
| `{ async: true, asyncTimeout }` | "Don't wait for me". The run goes on and the answer is ignored. |

Per event (`hookSpecificOutput` unless noted):

| Event | Answer | Effect |
|---|---|---|
| `UserPromptSubmit` | `additionalContext` | Text the model reads next to the prompt |
| `UserPromptSubmit` | `decision: "block"`, `reason` (top level) | The model is not called: 0 turns, $0. The result text starts with `UserPromptSubmit operation blocked by hook:` |
| `PreToolUse` | `permissionDecision`, `updatedInput`, `additionalContext` | Concept 7, plus context for the model |
| `PermissionRequest` | `decision: { behavior: "allow" }` or `{ behavior: "deny", message }` | `canUseTool` as a hook |
| `PostToolUse` | `updatedToolOutput` | Replaces what the **model** sees. The tool and the disk are not changed. |
| `PostToolUseFailure` | `additionalContext` | Explain the error to the model |
| `SubagentStart` | `additionalContext` | Goes to the **subagent**, not to the main agent |
| `Stop` | `decision: "block"`, `reason` (top level) | The model gets `reason` and goes on |

## Step 3: How a hook fails

| The hook… | Result | Meaning |
|---|---|---|
| throws | Ignored. The call **runs**. | **Fail open**: a guard with a bug lets everything through |
| is slower than its matcher's `timeout` | `signal` is aborted, and the call is **not run**. The model reads `PreToolUse hook did not respond before its timeout…` | **Fail closed** |

So a guard should catch its own errors and return `deny`, and give the matcher a `timeout` that fits the work.

## Step 4: Server route

**File:** [server/concepts/20-hooks-in-depth.ts](server/concepts/20-hooks-in-depth.ts)

Every run registers an **observer** on every event: one matcher, no regex, returning `{}`. The hooks the browser
ticks are added on top of it as more matchers:

```ts
for (const event of HOOK_EVENTS) add(event, "observer", observer);
for (const name of picked) add(h.event, name, h.fn, h.matcher, h.timeout);
```

Each callback is wrapped by `traced()`, which streams a `hook` SSE event with the input, the answer (or the
error) and how long it took. The 11 hooks:

| Hook | Event | Shows |
|---|---|---|
| `context` | `UserPromptSubmit` | `additionalContext` |
| `block-secrets` | `UserPromptSubmit` | `decision: "block"` |
| `maintenance` | `UserPromptSubmit` | `continue: false` |
| `redact` | `PostToolUse`, matcher `Read` | `updatedToolOutput` + `systemMessage` |
| `explain-failure` | `PostToolUseFailure` | `additionalContext` after an error |
| `approve-writes` | `PermissionRequest` | allow inside `hooks-lab/`, deny + `message` outside |
| `stop-gate` | `Stop` | `decision: "block"` until the answer has a `Source:` line |
| `subagent-brief` | `SubagentStart` | context for the subagent |
| `crash` | `PreToolUse`, matcher `Read` | a throwing guard |
| `slow` | `PreToolUse`, matcher `Read`, `timeout: 2` | a hook that times out |
| `async-log` | `PostToolUse` | `{ async: true }` |

The stop gate must check `stop_hook_active`, or it could block forever:

```ts
if (input.hook_event_name !== "Stop" || input.stop_hook_active) return {};
if (/^Source: \S+/m.test(input.last_assistant_message ?? "")) return {};
return { decision: "block", reason: 'Stop-gate hook: end your answer with a line "Source: <file you read>".' };
```

The run uses Haiku, no thinking, `persistSession: false`, `cwd: hooks-lab/`. `allowedTools` holds the ticked tools
except `Write`, so `Write` "asks" and `PermissionRequest` fires. The browser sends hook names (checked with
`Object.hasOwn`, so `"constructor"` is not a hook) and tool names from a fixed list, never code or paths.
`/files`, `/file?name=` (only names listed in the folder) and `/reset` let you compare what the model saw with
what is on disk.

## Step 5: Browser flow

**File:** [src/concepts/Concept20HooksInDepth.tsx](src/concepts/Concept20HooksInDepth.tsx)

1. Pick a scenario, or tick hooks and tools yourself.
2. The **HOOK_EVENTS** grid lights up each event the observer saw, with a count and the first-fire order.
3. **Hook calls** is the timeline of the ticked hooks. Tick *show the observer's rows* to see every event.
4. **Shown to the user, not to the model** lists `system/informational` and `system/permission_denied` messages.
5. The result card shows turns, cost, `permission_denials`, and the result text when there was no answer.

## Things to try in Concept 20

1. **1 · Which events fire?** Count the grey events. `SessionStart` stays grey.
2. **2 · Context on every prompt**: the answer gives USD, which the prompt never asked for.
3. **3 · Block a prompt**: 0 turns, $0. `context` ran too: both `UserPromptSubmit` hooks see the prompt.
4. **5 · Redact tool output**: the answer says `[REDACTED]`. Open `config.env`: the key is still there.
5. **6 · Explain a failure**: `PostToolUseFailure` fires instead of `PostToolUse`, and the model goes to `notes.txt`.
6. **7 · Approve writes**: `summary.md` is created, and `../outside.md` is in `permission_denials`.
7. **8 · Don't stop yet**: two `Stop` rows. The second has `stop_hook_active: true`.
8. **9 · Subagents**: show the observer's rows and find the `Glob` call that has `(in counter)`.
9. **10** then **11**: the same guard idea, opposite results. The throwing hook lets the key through. The slow one
   blocks the Read.
10. **12 · Don't wait for me**: the `async` row arrives after the run has moved on.

Costs: $0.0046 to $0.022 per scenario on Haiku. Scenarios 3 and 4 cost $0.

**Note:** even with `persistSession: false`, a subagent leaves a small `.meta.json` under
`~/.claude/projects/<hooks-lab>/<session>/subagents/`.
