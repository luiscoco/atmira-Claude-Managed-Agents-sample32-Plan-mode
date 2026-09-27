# Concept 7: Hooks with `PreToolUse` / `PostToolUse`, step by step

This file explains how Concept 7 (**Hooks**) was added to the Claude Agent SDK Lab.
It builds on Concept 3 ([Tab3-Built-in-tools.md](Tab3-Built-in-tools.md)) for the `sandbox/` folder and on Concept 4
([Tab4-Permissions.md](Tab4-Permissions.md)) for the idea of deciding a tool call in code.

**Goal:** run your own functions at fixed points of the agent loop: **before** a tool call (to allow, deny or rewrite
it) and **after** it (to add feedback for the model, or to stop the run).

| Concept | Topic | Route |
|---|---|---|
| 7 | Hooks: `PreToolUse` / `PostToolUse` | `/api/c7/query` |

## Step 1: Where hooks live

Hooks are set in `Options.hooks`: a map from an **event name** to a list of **matchers**. Each matcher has a regex
`matcher` (tested against the tool name) and a list of callbacks:

```ts
const options: Options = {
  hooks: {
    PreToolUse: [{ matcher: "Write|Edit|Bash", hooks: [guard] }], // before the tool runs
    PostToolUse: [{ hooks: [audit] }],                            // after it ran; no matcher = every tool
  },
};
```

A callback is an async function:

```ts
const myHook: HookCallback = async (input, toolUseID, { signal }) => {
  // input.hook_event_name tells you which event fired
  return {}; // HookJSONOutput
};
```

`input` depends on the event:

| Event | Main fields of `input` |
|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `session_id`, `cwd`, `permission_mode` |
| `PostToolUse` | the same plus `tool_response` and `duration_ms` |

The SDK knows many more events (`UserPromptSubmit`, `Stop`, `SessionStart`, `SubagentStop`, ...). This concept only
uses the two tool events.

## Step 2: What a hook can answer

| Return value | Effect |
|---|---|
| `{}` | No opinion. The call continues exactly as before. |
| `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" \| "deny" \| "ask", permissionDecisionReason } }` | Decides the call before the permission system does. The model reads the reason. |
| `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }` | The tool runs with `updatedInput` instead of the model's input. |
| `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }` | Extra text the model reads together with the tool result. |
| `{ continue: false, stopReason }` | Ends the whole run. `result.terminal_reason` is `"hook_stopped"`. |

When several hooks answer the same call, they all run, and **deny wins over ask, and ask wins over allow**.

## Step 3: Hooks vs `canUseTool`

Both can decide a tool call in code, so why have two?

| | `canUseTool` (Concept 4) | `PreToolUse` hook |
|---|---|---|
| When it runs | Only for calls that would "ask" | For **every** matching call, even read-only ones |
| Filtering | You check `toolName` yourself | `matcher` regex |
| After the call | Nothing | `PostToolUse` sees the result |
| How many | One function | Many, combined by precedence |

## Step 4: Server route

**File:** [server/concepts/07-hooks.ts](server/concepts/07-hooks.ts)

The browser sends the names of the hooks to turn on. The server builds `options.hooks` from them. There are five hooks,
and each one shows a different kind of answer:

| Hook | Registered on | Returns |
|---|---|---|
| `audit` | `PreToolUse` + `PostToolUse`, every tool | `{}`: only observes |
| `guard` | `PreToolUse`, matcher `Write\|Edit\|Bash` | `allow`, or `deny` for paths outside `sandbox/` and `rm` commands |
| `stamp` | `PreToolUse`, matcher `Write` | `updatedInput`: adds a header comment to `.md` files |
| `lint` | `PostToolUse`, matcher `Write` | `additionalContext` when a `.md` file has no `Source:` line |
| `limit` | `PreToolUse`, every tool | `continue: false` + `deny` from the 4th tool call on |

The run uses `permissionMode: "default"` with no `canUseTool` and no `allowedTools`. So the **only** thing that can let
`Write` run is a hook that says `allow`, like `guard`.

The guard is Concept 4's policy, written as a hook:

```ts
const guard: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolInput = input.tool_input as Record<string, unknown>;
  // ...outside sandbox/ or a delete command:
  //   return decide("deny", "Guard hook: ...");
  return decide("allow", "Guard hook: inside sandbox/ and not destructive.");
};
```

`stamp` shows `updatedInput`. It only takes effect together with `permissionDecision: "allow"`:

```ts
return {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...toolInput, content: `${STAMP}\n${toolInput.content}` },
  },
};
```

`lint` shows that `PostToolUse` can't undo a call, but it can talk to the model:

```ts
return {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `Lint hook: summary.md has no "Source: <file>" line. ... Rewrite the file with it.`,
  },
};
```

`limit` shows `continue: false`. **Careful:** in this SDK version, `continue: false` stops the loop *after* the
current tool call. The call itself still runs, and so does any other call the model made in the same turn. To also block
it, the hook denies it:

```ts
return {
  continue: false,
  stopReason: reason,
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
};
```

Every hook is wrapped by `traced()`, which streams a `hook` SSE event with the `input` and the `output`, so the UI can
show each call. Functions can't be serialized, so the echoed `options` shows `[Function guard]` under each matcher.

A small `GET /api/c7/file?path=...` route returns the content of one sandbox file, so you can see what `stamp` and
`lint` changed.

## Step 5: Browser flow

**File:** [src/concepts/Concept07Hooks.tsx](src/concepts/Concept07Hooks.tsx)

1. Pick a scenario, or tick hooks and tools yourself.
2. **Run query() with hooks** posts `{ prompt, tools, hooks }` to `/api/c7/query`.
3. Each `hook` event is added to the **hook calls** card: event, hook name, tool, input, and the answer (`allow`,
   `deny`, `continue: false`, or `{}`).
4. When the run ends, the file list reloads. Click a file to see its content.
5. The `result` card shows `terminal_reason` and `permission_denials`.

## Things to try in Concept 7

1. **1 · No hooks**: Write is denied, as in Concept 3. Then run **3 · Guard allows**: same prompt, and now it works.
2. **2 · Observe everything**: `audit` fires for `Read` and `Glob`, which `canUseTool` never sees. Compare `duration_ms`.
3. **4 · Guard denies**: find the `permissionDecisionReason` text inside the `tool_result` in the raw stream.
4. **5 · Rewrite the input**: open `summary.md`. The first line is not in the model's `tool_use` input.
5. **6 · Feedback after a call**: count the `Write` calls. The second one comes from the `lint` feedback.
6. **7 · Stop the run**: only `a.txt` to `c.txt` exist, and `terminal_reason` is `hook_stopped`. Untick `guard` to see
   that `limit` alone does not grant permission.
7. Tick `guard` and `stamp` together and ask for `../outside.md`: `guard` says `deny`, `stamp` says `allow`, and
   `deny` wins.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/07-hooks.ts` | New route that builds `options.hooks` from five example hooks |
| `server/index.ts` | Mounts the route on `/api/c7` |
| `src/concepts/Concept07Hooks.tsx` | Hooks UI with scenarios and a timeline of hook calls |
| `src/App.tsx` | Adds the Hooks tab |
| `src/styles.css` | Tags for `PreToolUse` / `PostToolUse` and clickable file names |
| `Tab7-Hooks.md` | This explanation |
