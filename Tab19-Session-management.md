# Session management

This file explains how Concept 19 (**Session management**) was added to the Claude Agent SDK Lab.
Concept 6 ([Tab6-Sessions.md](Tab6-Sessions.md)) used one option, `resume`, to continue a conversation. The SDK has
more options that decide **which** session a `query()` writes to, and a set of functions that read and change
sessions **without** starting Claude Code.

There are two parts:

- **A. Where does the next turn go?** `continue`, `resume`, `forkSession`, `resumeSessionAt`, `sessionId` and
  `persistSession: false`, each compared with the sessions that existed before the run.
- **B. The sessions on disk.** `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `renameSession()`,
  `tagSession()`, `forkSession()` and `deleteSession()`.

| Concept | Topic | Routes |
|---|---|---|
| 19 | `continue`, `resume`, `forkSession`, `resumeSessionAt`, `sessionId`, `persistSession`, `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `renameSession()`, `tagSession()`, `forkSession()`, `deleteSession()` | `/api/c19/turn`, `/sessions`, `/sessions/:id`, `/sessions/:id/rename`, `/tag`, `/fork`, `/delete`, `/reset` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/19-session-management.ts` | **New**: the routes |
| `server/index.ts` | Mounts the router on `/api/c19` |
| `src/concepts/Concept19SessionManagement.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `.gitignore` | Ignores `session-lab/` |
| `Tab1-query().md` | Adds Concept 19 to the table of concepts |
| `Tab19-Session-management.md` | This explanation |

No CSS was added.

---

## Step 1: Read the type definitions

The code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

**Options** (on `query()`):

```ts
type Options = {
  continue?: boolean;        // "Continue the most recent conversation in the current directory". Not with resume
  resume?: string;           // "Session ID to resume. Loads the conversation history"
  forkSession?: boolean;     // "resumed sessions will fork to a new session ID rather than continuing". Use with resume
  resumeSessionAt?: string;  // "only resume messages up to and including the message with this UUID". Use with resume
  sessionId?: string;        // "Use a specific session ID ... Cannot be used with continue or resume unless forkSession"
  persistSession?: boolean;  // default true. false: "Sessions will not be saved to ~/.claude/projects/"
};
```

**Functions** (imported from the package like `query`). Each one reads or writes the transcript files directly:

```ts
listSessions({ dir?, limit?, offset? }): Promise<SDKSessionInfo[]>
getSessionInfo(sessionId, { dir? }): Promise<SDKSessionInfo | undefined>
getSessionMessages(sessionId, { dir?, limit?, offset? }): Promise<SessionMessage[]>   // [] if not found
renameSession(sessionId, title, { dir? }): Promise<void>
tagSession(sessionId, tag | null, { dir? }): Promise<void>
forkSession(sessionId, { dir?, upToMessageId?, title? }): Promise<{ sessionId }>
deleteSession(sessionId, { dir? }): Promise<void>                                     // throws if not found

type SDKSessionInfo = { sessionId; summary; lastModified; fileSize?; customTitle?; firstPrompt?; gitBranch?; cwd?; tag?; createdAt? };
type SessionMessage = { type: "user" | "assistant" | "system"; uuid; session_id; message; parent_tool_use_id; ... };
```

`dir` is a project directory, meaning the `cwd` the session ran in. Without `dir`, every project is searched.

## Step 2: Try it before writing the lab

A scratch script called the SDK directly, with the `CLAUDE*` variables removed and no tools. It ran two turns
(*colour is green*, then *fruit is mango*) and then tried each option and function on that session.

| Test | Result |
|---|---|
| `resume: A` | Same id `A`. The turn is added to it |
| `continue: true` | Same id `A`: the most recent session in `cwd` |
| `resume: A, forkSession: true` | A **new** id. It knows both facts. `A` is not changed |
| `resume: A, resumeSessionAt: <uuid of turn 1's answer>` | The **same** id `A`, but `getSessionMessages(A)` now shows turn 1 and the new turn: turn 2 was dropped. The model answered *fruit: unknown* |
| The streamed `assistant.uuid` vs the transcript | The same uuid. `resumeSessionAt` accepts either |
| `persistSession: false`, then `resume` it | Not in `listSessions()`. `resume` → `No conversation found with session ID: …` (no `init`, $0) |
| `sessionId: <uuid>` | `init.session_id` is that uuid |
| `sessionId` + `resume`, no `forkSession` | The process exits: `--session-id can only be used with --continue or --resume if --fork-session is also specified` |
| `sessionId` + `resume` + `forkSession` | Works: the fork gets your id |
| `resume: <an id that does not exist>` | `error_during_execution`, `No conversation found…`, $0 |
| `listSessions({ dir })` | Newest first. A `summary` like *Favourite colour green*: the CLI generated a title, and it is also in `customTitle` |
| `forkSession(A, { upToMessageId })` (function) | New id, **new uuids** for every message, only the messages up to that uuid. Title *… (fork)*. About 15 ms, no process |
| `renameSession`, `tagSession` | `summary` and `customTitle` become the new title; `tag` appears |
| `deleteSession(id)` twice | The second throws `Session … not found in project directory for <dir>` |
| `getSessionMessages(<missing id>)` | `[]`, no throw |
| Where is the file? | `~/.claude/projects/<cwd with every non-alphanumeric character as "-">/<sessionId>.jsonl` |

Two more things came out of it:

- **Haiku's thinking adds entries.** Each turn had an extra `assistant` entry with only a `thinking` block, and
  `resumeSessionAt` at that entry kept the rest of the turn anyway. The lab sets `thinking: { type: "disabled" }`, so
  each turn is exactly one `user` and one `assistant` entry.
- **Long paths break `dir`.** The first run used a folder in the Windows temp directory (an 8.3 `LUIS~1.COC` path).
  The project folder name went over 200 characters, so it was cut short and a hash was added, and
  `getSessionMessages(id, { dir })` returned `[]`. The lab folder is inside the project, so its name is short.

---

# Part A: Where does the next turn go?

## Step 3: One route, seven modes

**File:** [server/concepts/19-session-management.ts](server/concepts/19-session-management.ts)

Every run uses the same base, in its own folder:

```ts
const LAB = path.resolve("session-lab");

const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 1,
  thinking: { type: "disabled" },
  cwd: LAB,
};
```

`cwd: LAB` matters twice: `continue` picks the most recent session **of that folder**, and `listSessions({ dir: LAB })`
lists only the lab's sessions, not your own Claude Code history.

The browser sends a `mode`, and the server turns it into options. The browser never sends option names:

```ts
switch (mode) {
  case "new":       return {};
  case "continue":  return { continue: true };
  case "resume":    return { resume: sessionId };
  case "fork":      return { resume: sessionId, forkSession: true };
  case "resumeAt":  return { resume: sessionId, resumeSessionAt: at };
  case "customId":  return { sessionId: randomUUID() };
  case "ephemeral": return { persistSession: false };
}
```

`sessionId` and `at` must match a uuid pattern. `resume`, `fork` and `resumeAt` need a session, and `resumeAt` also
needs a message. Anything else becomes an `error` event before `query()` is called.

## Step 4: The verdict

To say where a turn went, the route lists the sessions **before** the run, reads `init.session_id` during it, and
checks the disk **after** it:

```ts
const before = await listSessions({ dir: LAB });
// ... for await (const msg of q): if (msg.type === "system" && msg.subtype === "init") written = msg.session_id;
const info = await getSessionInfo(written, { dir: LAB });
send("verdict", {
  sessionId: written,
  isNew: !before.some((s) => s.sessionId === written),
  persisted: Boolean(info),
  turnsBefore, turnsAfter,   // turns of the resumed session before, and of the written one after
});
```

The run card shows it in one line, for example `init.session_id 698a0805 → an existing session · the session you
resumed · turns in it: 1 → 2`. The session it wrote to is then selected in Part B.

Run the presets in this order:

| # | Mode | Prompt | What you see |
|---|---|---|---|
| 1 | New session | Remember colour | A new session, 1 turn |
| 2 | `resume` | Remember fruit | Same session, turns 1 → 2 |
| 3 | `resume + forkSession` | Ask both | A new session, 3 turns: *green, mango*. The original still has 2 |
| 4 | `continue` | (any) | It goes to the **fork**, because the fork is now the most recent session |
| 5 | `resumeSessionAt` on turn 1 | Ask both | The **same** id as the original, turns 2 → 2: turn 2 is gone and the new turn replaced it. *green, unknown* |
| 6 | `sessionId` | Say OK | A new session whose id is the one in the options card |
| 7 | `persistSession: false` | Say OK | An answer and an `init.session_id`, but **not written to disk**. It never appears in Part B |

Row 5 is the surprise. `resumeSessionAt` does not make a copy: it rewrites the session you resumed. If you want to
keep the original, add `forkSession: true` too, or fork first with the function (Part B).

> **`continue` needs no id, and that is its risk.** It takes whatever session was modified last in `cwd`. In row 4
> that was the fork, not the session you were "in". Use `resume` with a stored id when it matters which session you
> continue.

---

# Part B: The sessions on disk

## Step 5: List and read

`GET /sessions` returns `listSessions({ dir: LAB })` plus the transcript folder:

```ts
const TRANSCRIPTS = path.join(os.homedir(), ".claude", "projects", LAB.replace(/[^a-zA-Z0-9]/g, "-"));
```

`GET /sessions/:id` reads one session. `getSessionMessages()` returns the conversation **chain**: it follows each
entry's parent back from the newest one, so turns dropped by `resumeSessionAt` are not returned (they are still in the
file, which is why the file keeps growing). The route groups the chain into turns:

```ts
for (const m of messages) {
  if (m.type === "user") turns.push({ prompt: textOf(m), promptUuid: m.uuid, answer: "", lastUuid: m.uuid });
  else if (m.type === "assistant") { turn.answer += textOf(m); turn.lastUuid = m.uuid; }
}
```

`lastUuid` is the uuid to pass to `resumeSessionAt` or `upToMessageId` to keep a turn **whole**. The SDK's own
comment on `resumeDropsTurn` says the same: *"fork at the KEPT turn's last chain entry"*.

## Step 6: Change a session

Each button calls one function, with `{ dir: LAB }`:

| Button | Call | Result |
|---|---|---|
| Rename | `renameSession(id, title)` | `summary` and `customTitle` change. A few ms |
| Tag | `tagSession(id, tag)`, or `null` when the box is empty | `tag` appears or is cleared |
| forkSession() — full copy | `forkSession(id)` | A new session *… (fork)*. The fork is selected |
| forkSession() up to here | `forkSession(id, { upToMessageId: turn.lastUuid })` | A copy that ends at that turn, with new uuids |
| Use for resumeSessionAt | (nothing yet) | Picks the turn and switches Part A to `resumeSessionAt` |
| deleteSession() | `deleteSession(id)` | The file is removed. You are asked to confirm first |
| Delete all lab sessions | `deleteSession()` for each listed session | An empty lab, to start again |

None of them starts Claude Code or calls the model, so they cost nothing.

**The function and the option both fork, in different ways.** `forkSession()` copies the file now, with no turn, and
you `resume` the copy later. `forkSession: true` forks as part of a `query()` that runs a turn. Both leave the
original alone. The JSDoc of `forkSession()` adds that its copy starts **without** file checkpoints (Concept 17):
*"file-history snapshots are not copied"*, so `rewindFiles()` has nothing to rewind there. This was not tried here.

**Only lab sessions can be changed.** Before calling a function, the server checks that the id is a uuid **and** that
`listSessions({ dir: LAB })` lists it. Without `dir`, `deleteSession()` searches every project, so a uuid from your own
Claude Code history would be deleted too.

---

## What to take away

1. **A session is a file**: `~/.claude/projects/<cwd>/<sessionId>.jsonl`. The `cwd` decides the folder.
2. **`resume` continues, `forkSession` copies, `resumeSessionAt` cuts.** Only the fork gets a new id. A cut keeps the
   id and drops the later turns from the chain.
3. **`continue: true` is "the latest session in cwd"**, whatever that is. Prefer `resume` with a stored id.
4. **`sessionId` lets you choose the id.** With `resume` or `continue` it needs `forkSession`.
5. **`persistSession: false` writes nothing.** You still get a `session_id`, but it cannot be resumed.
6. **The session functions work on the files directly.** No process, no model, no cost. Always pass `dir`.
7. **Keep turns whole.** Give `resumeSessionAt` / `upToMessageId` the **last** uuid of the turn you want to keep.

## Things to try in Concept 19

1. After row 3, select the **original** session and send *Ask both* with plain `resume`. What does it know, and what
   does the fork know?
2. Use `resumeSessionAt` on turn 1, then open *getSessionInfo() and the raw chain*. Did `fileSize` go down?
3. Run `continue` twice in a row, then fork, then `continue` again. Which session does each one go to?
4. `forkSession() up to here` on turn 1, then `resume` the copy with *Ask both*. Compare it with row 5: same answer,
   but which one kept the original?
5. Rename a session, then fork it with the function. What is the fork's title?

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite page and select **19. Session management**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps. Only one sample can run at a time
(they all use port 3001). Start it from a normal terminal, not from inside Claude Code (see Tab16). Costs on Haiku:
about $0.0003 to $0.002 per turn in Part A. Part B makes no model call.

The routes can also be called without the UI:

```powershell
'{"mode":"new","prompt":"Remember: my favourite colour is green. Reply with one word: OK."}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c19/turn -H "Content-Type: application/json" -d "@body.json"
# copy "sessionId" from the "verdict" event, then:
curl.exe http://localhost:3001/api/c19/sessions
curl.exe http://localhost:3001/api/c19/sessions/<sessionId>
curl.exe -X POST http://localhost:3001/api/c19/sessions/<sessionId>/fork -H "Content-Type: application/json" -d "{}"
Remove-Item body.json
```
