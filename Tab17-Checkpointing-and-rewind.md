# File checkpointing & rewind, step by step

This file explains how Concept 17 (**File checkpointing & rewind**) was added to the Claude Agent SDK Lab.
From Concept 3 on, the agent has changed real files with `Write` and `Edit`. Until now, nothing could undo that.
With **file checkpointing**, Claude Code backs up each file before changing it, and `rewindFiles()` puts the files
back as they were at any user message.

There are two parts:

- **A. A live session.** One checkpoint per user message. Preview (`dryRun`) and rewind to any of them, and see what
  is *not* rewound: changes made through Bash, and the conversation itself.
- **B. After the query has ended.** A string prompt closes its `Query`, so you rewind by **resuming** the session.

| Concept | Topic | Routes |
|---|---|---|
| 17 | `enableFileCheckpointing`, `Query.rewindFiles()` (`dryRun`), `RewindFilesResult`, the user message `uuid`, `extraArgs: { "replay-user-messages": null }`, rewind after `resume` | `/api/c17/session`, `/send`, `/rewind`, `/end`, `/oneshot`, `/resume-rewind` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/17-checkpointing.ts` | **New**: the six routes |
| `server/index.ts` | Mounts the router on `/api/c17` |
| `src/concepts/Concept17Checkpointing.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `.gitignore` | Ignores `checkpoint-lab/`, which the server recreates |
| `Tab1-query().md` | Adds Concept 17 to the table of concepts |
| `Tab17-Checkpointing-and-rewind.md` | This explanation |

No CSS was added. `checkpoint-lab/` is not in the repository: every run empties its folder and writes the two seed
files, `plan.md` and `config.json`.

---

## Step 1: Read the type definitions

The code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
type Options = {
  enableFileCheckpointing?: boolean;
  // "When enabled, files can be rewound to their state at any user message using Query.rewindFiles()."
  // "File checkpointing creates backups of files before they are modified"
};

interface Query {
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  // "Requires file checkpointing to be enabled via the enableFileCheckpointing option."
}

type RewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];   // absolute paths
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;     // only on a real rewind: symlinks and other files it refused to touch
};

type SDKUserMessage       = { type: "user"; message; parent_tool_use_id; uuid?: UUID; ... };  // what you send
type SDKUserMessageReplay = { type: "user"; message; uuid: UUID; session_id; isReplay: true };  // what comes back
```

`rewindFiles()` wants the **uuid of a user message**. Two questions follow: where does that uuid come from, and what
does "their state at a user message" mean exactly? The types don't say, so the next step tried it.

## Step 2: Try it before writing the lab

Scratch scripts called `query()` directly on a folder with one file, in three turns: `Write` a new file, `Edit` two
files, then a Bash `echo > file` plus another `Write`.

| Test | Result |
|---|---|
| Streaming input, `uuid` set on each `SDKUserMessage` you push | That uuid **is** the checkpoint id. With replay on, the echo has the same uuid |
| String prompt, no `extraArgs` | No user message comes back, so you never learn a uuid |
| String prompt + `extraArgs: { "replay-user-messages": null }` | The message is echoed with `isReplay: true` and its `uuid` |
| `rewindFiles(uuid of message 2)` | Files as they were **before** message 2 ran (= after message 1). A file `Write` created later is **deleted** |
| `rewindFiles(uuid of message 3)` after rewinding to 1 | Works: you can rewind **forward** too |
| `{ dryRun: true }` | `filesChanged`, `insertions`, `deletions`; nothing on disk changes |
| Real rewind | `{ canRewind: true, skippedLinks: 0 }`: it does **not** list the files. Preview first if you need the list |
| A uuid that is not a checkpoint | `{ canRewind: false, error: "No file checkpoint found for this message." }` (no throw) |
| A file Bash created (`echo > bash-note.txt`) | **Never** touched by any rewind |
| Bash `sed -i` on `plan.md`, which `Edit` had changed before | The next rewind **overwrites** the Bash change with the backup |
| `enableFileCheckpointing` off, `dryRun` | `{ canRewind: false, error: "File rewinding is not enabled." }` |
| `enableFileCheckpointing` off, real rewind | **Throws** `File rewinding is not enabled.` |
| String prompt, `q.rewindFiles()` after the loop | **Throws** `Query closed before response received` |
| New `query({ resume: sessionId })`, then `rewindFiles(uuid)` | Works, about 2 s, the checkpoints are saved with the session |
| After a rewind, ask the model "from memory" | Not reliable: once it described the old content, once it answered with the rewound one |

> **Why `acceptEdits` and not `dontAsk`?** With `dontAsk` and `allowedTools: ["Bash(echo:*)"]`, the command
> `echo 'x' > bash-note.txt` was **denied** (the redirect writes a file), and the model quietly used `Write` instead,
> which *is* tracked, so the lesson disappeared. `acceptEdits` approves edits and filesystem commands (`echo > file`,
> `sed -i`, `rm`…) inside `cwd`. Anything else would ask `canUseTool`, and there is none, so it is denied.

---

# Part A: A live session

## Step 3: One checkpoint per user message

`/session` opens a streaming input session (the push queue from Concept 12) on `checkpoint-lab/live`:

```ts
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  tools: ["Read", "Write", "Edit", "Bash"],
  allowedTools: ["Read"],
  permissionMode: "acceptEdits",
  settingSources: [],
  strictMcpConfig: true,
  maxTurns: 8,
  extraArgs: { "replay-user-messages": null },
};

const q = query({ prompt: input.stream, options: { ...BASE, cwd: LIVE, enableFileCheckpointing: checkpointing } });
```

`/send` makes the uuid itself, so the browser knows the checkpoint id at once, without waiting for the echo:

```ts
const uuid = randomUUID();
session.send("checkpoint", { uuid, text, turn: session.turns });
session.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text }, uuid });
```

After every `result`, the server sends a `files` event with what is really on disk, so you can check each rewind
against the files, not against what the model says.

## Step 4: Preview and rewind

Every message card has two buttons. Both call `/rewind`, which only needs the live `Query`:

```ts
const result = await q.rewindFiles(uuid, { dryRun });
```

The browser sends a uuid (checked against a uuid pattern), never a path. `filesChanged` is shortened to names.

Run the presets in order, then try the buttons:

| Action | What you see |
|---|---|
| 1. Edit plan.md | `plan.md` gains `- update the docs` (`Edit`, tracked) |
| 2. Version + changelog | `changelog.md` created (`Write`), `config.json` → `1.1.0` (`Edit`) |
| 3. Change it with Bash | `bash-note.txt` created, `plan.md` changed by `sed -i`: both **not tracked** |
| Preview on message #1 | `plan.md`, `changelog.md`, `config.json` would change, +2 −4 |
| Rewind to before #2 | `changelog.md` is gone, `config.json` is `1.0.0`, `plan.md` has the Edit but **not** the `sed` change, `bash-note.txt` is still there |
| Rewind to before #3 | Forward again: `changelog.md` is back, `config.json` is `1.1.0` |
| Rewind to before #1 | The seed files, plus `bash-note.txt` |
| Ask from memory | The model may or may not know the files changed. Use *Read the files again* |

Two rules come out of this table:

1. **Only the file tools are tracked** (`Write` and `Edit` here; the docs add `NotebookEdit`). A file that only Bash
   touched is invisible to rewind. A file that is tracked is restored from its backup, which **erases** anything Bash
   did to it in between.
2. **Only the files are rewound, not the conversation.** The model still has every turn in its context. If you want
   the conversation to go back too, also resume the session at an earlier message (`resume` from Concept 6, plus the
   `resumeSessionAt` option). That was not tried in this lab.

Untick `enableFileCheckpointing` and start again: *Preview* shows `canRewind: false`, and *Rewind* throws
`File rewinding is not enabled.`, which shows up as an error on that card.

---

# Part B: After the query has ended

## Step 5: The uuid from a string prompt

`/oneshot` runs one string prompt on `checkpoint-lab/oneshot`. There is no `SDKUserMessage` of yours to put a uuid
on, so the uuid comes from the echo that `replay-user-messages` turns on:

```ts
if (msg.type === "user" && "isReplay" in msg && msg.isReplay && !checkpoint) {
  checkpoint = { uuid: msg.uuid, sessionId: msg.session_id };
  send("checkpoint", checkpoint);
}
```

After the loop, the route tries `q.rewindFiles(uuid, { dryRun: true })` on the same `Query`, and the tab shows the
error: `Query closed before response received`. A string prompt closes the input after one message, so when
`for await` ends the process is gone (Concept 12, Part C, found the same with `setModel()`).

## Step 6: Resume, rewind, close

`/resume-rewind` opens a **new** `query()` on the same session. Its input is an empty push queue, so it never sends
a message: no turn starts, and the model is not called. Control requests work as soon as the process is up
(Concept 12), so `rewindFiles()` can be called at once:

```ts
const input = inputQueue();
const q = query({ prompt: input.stream, options: { ...BASE, cwd: ONESHOT, enableFileCheckpointing: true, resume: sessionId } });
try {
  const result = await q.rewindFiles(uuid, { dryRun });
  // ...
} finally {
  input.close();
  q.close();
}
```

| Button | Result |
|---|---|
| Preview via resume | About 2 s. `config.json` and `release.md` would change, +1 −2 |
| Rewind via resume | About 2 s. `config.json` back to `1.0.0`, `release.md` deleted |
| (a `sessionId` that does not exist) | `No conversation found with session ID: …` |

The 2 s are the time to start a Claude Code process and load the session. `enableFileCheckpointing: true` must be
set on the resumed query too.

---

## What to take away

1. **`enableFileCheckpointing: true`, then `q.rewindFiles(userMessageUuid)`.** A checkpoint is taken per user message.
2. **The uuid is yours in streaming input.** Set `uuid` on the `SDKUserMessage` you send. With a string prompt, use
   `extraArgs: { "replay-user-messages": null }` and read the echo.
3. **Rewinding to message N gives the files as they were before N ran.** Later files are deleted. Forward works too.
4. **Preview with `dryRun: true`.** A real rewind does not tell you which files it changed.
5. **Bash changes are not tracked.** Files Bash creates stay. Bash changes to a tracked file are overwritten.
6. **The conversation is not rewound.** Tell the model, or make it read the files again.
7. **Rewind needs a live `Query`.** After a string prompt ends, resume the session with an input that sends nothing.
8. **Off means "not enabled".** `dryRun` answers `canRewind: false`; a real rewind throws.

## Things to try in Concept 17

1. Send preset 1 twice. How many checkpoints do you have, and what does rewinding to the second one change?
2. After preset 3, rewind to before #3. Is `plan.md` in capitals? Is `bash-note.txt` still there? Why?
3. Rewind to before #1, then send *Ask from memory*, then *Read the files again*. Do the two answers agree?
4. Ask for `rm config.json` through Bash (`acceptEdits` allows it), then rewind to before that message. Is it back?
5. In Part B, run the prompt, then click *Rewind via resume* twice. What does the second one say?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**17. Checkpointing & rewind**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.
Only one sample can run at a time (they all use port 3001). Costs on Haiku: $0.006 to $0.024 per turn in Part A,
about $0.01 per Part B run. **Preview** and **Rewind** make no model call.

The routes can also be called without the UI:

```powershell
'{"prompt":"Use the Edit tool to change the version in config.json to 2.0.0. Reply with one word: done."}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c17/oneshot -H "Content-Type: application/json" -d "@body.json"
# copy "uuid" and "sessionId" from the "checkpoint" event, then:
'{"sessionId":"<sessionId>","uuid":"<uuid>","dryRun":true}' | Set-Content body.json
curl.exe -X POST http://localhost:3001/api/c17/resume-rewind -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
