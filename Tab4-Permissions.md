# Concept 4: Permissions with `canUseTool`, step by step

This file explains how Concept 4 (**Permissions**) was added to the Claude Agent SDK Lab, in the order the work was done.
It builds on Concept 3 ([Tab3-Built-in-tools.md](Tab3-Built-in-tools.md)), which ended with this lesson:

> With no `canUseTool`, "ask" means "deny". A headless `query()` has nobody to ask.

**Goal:** give the agent somebody to ask. `canUseTool` is an async function that the SDK **awaits** before it runs a
tool call that needs permission. In this tab, that function waits for **you** to press a button in the browser.

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/04-permissions.ts` | **New**: the Concept 4 route, the pending-request `Map` and `POST /api/c4/decide` |
| `server/concepts/03-tools.ts` | `SANDBOX` is now exported, so Concept 4 reuses the same folder |
| `server/index.ts` | Mount the new router on `/api/c4` |
| `src/concepts/Concept04Permissions.tsx` | **New**: the Concept 4 tab with the approval cards |
| `src/App.tsx` | Add the tab to the navigation |
| `src/styles.css` | Approval card style |
| `Tab1-query().md` | Status table, project structure, Step 8 section |

---

## Step 1: Read the callback's type in the SDK

The dependencies were installed (`npm install`, `npm rebuild esbuild`), then `sdk.d.ts` (version `0.3.281`) was searched:

```ts
canUseTool?: CanUseTool;   // "Called before each tool execution to determine if it should be allowed, denied, or prompt the user."

type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal;              // fires if the run is aborted
  suggestions?: PermissionUpdate[]; // what to return for an "always allow" button
  blockedPath?: string;             // e.g. a Bash command touching a path outside the allowed folders
  decisionReason?: string;          // why this call needs permission
  title?: string; displayName?: string; description?: string;  // ready-made prompt text, when present
  toolUseID: string;                // the id of the tool_use block
  ...
}) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };
```

The compiled SDK (`sdk.mjs`) also contains two warnings that explain **when the callback is not called**:

- `canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call…`
- `canUseTool will not be invoked for: … Bare allowedTools entries auto-approve the whole tool before the callback is consulted.`

So the callback is the **last** step. Read-only tools, `allowedTools` and the `permissionMode` all decide first.

## Step 2: Turn a callback into a round trip to the browser

The problem: the SDK calls `canUseTool` on the **server**, but the person who decides is in the **browser**.
The SSE stream only goes from server to browser, so the answer needs its own route:

1. `canUseTool` creates an id, stores the promise's `resolve` in a `Map`, and returns the promise **unresolved**.
2. It sends a `permission_request` event over the same SSE stream as the messages.
3. The SDK waits. The run is paused.
4. The browser shows a card. A button click POSTs `{ id, choice }` to `/api/c4/decide`.
5. The route looks up the id, builds a `PermissionResult`, and calls `resolve`. The run continues.

```ts
const pending = new Map<string, Pending>();

const askTheUser: CanUseTool = (toolName, input, opts) =>
  new Promise((resolve) => {
    const id = randomUUID();
    pending.set(id, {
      input,
      suggestions: opts.suggestions,
      resolve: (decision) => {
        pending.delete(id);
        send("permission_decision", { id, toolName, decision });
        resolve(decision);
      },
    });
    send("permission_request", { id, toolName, input, toolUseID: opts.toolUseID, title: opts.title, /* … */ });
    // If the run is cancelled, don't leave the callback hanging.
    opts.signal.addEventListener("abort", () => pending.get(id)?.resolve({ behavior: "deny", message: "Run aborted." }));
  });
```

The original `input` and the SDK's `suggestions` stay on the server. The browser only sends its choice, an optional
deny message, and an edited input if it changed one.

## Step 3: Map the four buttons to a `PermissionResult`

**File:** [server/concepts/04-permissions.ts](server/concepts/04-permissions.ts), route `POST /api/c4/decide`

| Button | `PermissionResult` |
|---|---|
| **Allow** | `{ behavior: "allow", updatedInput: input }` |
| **Allow with edited input** | `{ behavior: "allow", updatedInput: <your JSON> }` |
| **Allow always (session)** | `{ behavior: "allow", updatedInput, updatedPermissions: suggestions }`, each with `destination: "session"` |
| **Deny** | `{ behavior: "deny", message }` |
| **Deny + interrupt** | `{ behavior: "deny", message, interrupt: true }` |

Why force `destination: "session"`? The suggestions say **where** a rule would be saved. The test in Step 6 showed
that for Bash the SDK suggests `destination: "localSettings"`, which means writing `.claude/settings.local.json`
to disk. A lab that sets `settingSources: []` should not create settings files, so the rule only lives for the current run.

## Step 4: Add a second approver: a policy written in code

`canUseTool` is just a function, so it doesn't need a human. The `policy` approver decides in code:

```ts
const policy: CanUseTool = async (toolName, input) => {
  const file = typeof input.file_path === "string" ? path.resolve(SANDBOX, input.file_path) : undefined;
  const rel = file && path.relative(SANDBOX, file);
  if (file && (!rel || rel.startsWith("..") || path.isAbsolute(rel)))
    return { behavior: "deny", message: `Policy: ${toolName} is only allowed inside sandbox/, not ${file}.` };
  if (toolName === "Bash" && /\b(rm|del|rmdir|Remove-Item)\b/.test(String(input.command)))
    return { behavior: "deny", message: "Policy: commands that delete files are not allowed." };
  return { behavior: "allow", updatedInput: input };
};
```

`path.relative` is used instead of `startsWith`, because on Windows the model may write the drive letter in a
different case. The server wraps the policy so the UI also receives a `permission_decision` event (with `auto: true`).
This is how a production app usually works: code approves the safe cases, and only the rest goes to a human.

## Step 5: Write the React tab

**File:** [src/concepts/Concept04Permissions.tsx](src/concepts/Concept04Permissions.tsx)

- **Form:** a `canUseTool` select (`askTheUser` or `policy`), `permissionMode`, `allowedTools`, and a checkbox per tool.
  The `sandbox/` folder and its **Reset** button reuse the Concept 3 routes (`/api/c3/files`, `/api/c3/reset`).
- **Approval card** (`PermissionCard`): one per pending `permission_request`. It shows `title`, `decisionReason` and
  `blockedPath` when the SDK sends them, the `input` as editable JSON, a deny-message field and the four buttons.
  "Allow always" is disabled when the SDK sent no `suggestions`.
- **canUseTool calls card:** every request with its decision, answered by **you** or by the **policy**. An
  `updatedInput` that is only the original input echoed back is hidden, so real edits stand out.
- **Seven scenario buttons**, one per way of answering. The options echo shows `canUseTool: "[Function askTheUser]"`,
  because a function can't be sent as JSON.

## Step 6: Type-check and test every scenario

`npx tsc -p .` exited with 0 and `npx vite build` succeeded. Then the server was started, and a Node script ran the
seven scenarios. It read the SSE stream and answered each `permission_request` by POSTing to `/api/c4/decide`,
resetting `sandbox/` between runs:

| Scenario | Answer | What happened |
|---|---|---|
| 1 · Approve a write | Allow | `Read` was never asked about. `Write` was asked once. `summary.md` created, `success` |
| 2 · Deny with a message | Deny "Name it SUMMARY.txt instead", then Allow | The model read the message and wrote `SUMMARY.txt`. `permission_denials: [Write]` |
| 3 · Edit the input | Allow with `file_path` → `edited.txt` | `edited.txt` was created. The answer still said "I've created `hello.txt`" |
| 4 · Always allow | Allow always | Asked once. The suggestion was `setMode: acceptEdits`, so `b.txt` and `c.txt` were written without asking |
| 5 · Bash + interrupt | Allow `touch`, Deny + interrupt `rm` | `ls` was never asked about (rule `Bash(ls:*)`). `rm` → `result/error_during_execution`, then an `error` event. `notes.txt` kept |
| 6 · Policy in code | (no human) | `ok.txt` allowed. `../outside.txt` and `rm notes.txt` denied with the policy's messages |
| 7 · allowedTools wins | (none) | `Write` in `allowedTools`, so no request reached the callback |

No file was created outside `sandbox/`, and no `.claude/` settings folder appeared. Each run cost about $0.006 to $0.018 with Haiku.

## What to take away

1. **`canUseTool` is the last step.** It is only called for calls that would "ask". Read-only tools, `allowedTools`
   (scenario 7) and `permissionMode` decide first, and `bypassPermissions` skips it completely.
2. **The SDK waits for as long as you take.** There is no deadline, so always handle `signal` to release a
   pending request when the run is aborted.
3. **A deny `message` is feedback.** The model reads it as the `tool_result` and adapts (scenario 2).
4. **`updatedInput` changes what really runs, and the model is not told** (scenario 3). If the model must know, say so
   in a deny message instead.
5. **`interrupt: true` ends the run**, with `error_during_execution` and a thrown error, like `maxTurns` in Concept 3.
6. **"Always allow" means returning the SDK's `suggestions`.** Check their `destination` before returning them,
   or you may write settings files to disk.
7. **A callback can be code, not a person** (scenario 6). Approve the safe cases in code and ask a human for the rest.

## Running the app

Everything in [Tab2-Options.md → Running the app](Tab2-Options.md#running-the-app) applies, using the `sample4` folder.
Then open **http://localhost:5173** and select **4. Permissions**.

To call the endpoint without the UI (PowerShell), you need two tabs, because the run waits for your answer:

```powershell
# Tab 1: start the run and keep the stream open. Copy the "id" of the permission_request event.
'{"prompt":"Create hello.txt containing hi.","model":"claude-haiku-4-5-20251001","tools":["Write"],"allowedTools":[],"permissionMode":"default","approver":"ui"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c4/query -H "Content-Type: application/json" -d "@body.json"

# Tab 2: answer it (choice: allow | allow_always | deny | deny_interrupt)
'{"id":"<paste the id>","choice":"allow"}' | Set-Content decide.json
curl.exe -X POST http://localhost:3001/api/c4/decide -H "Content-Type: application/json" -d "@decide.json"
Remove-Item body.json, decide.json
```
