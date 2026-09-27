# CLAUDE.md & memory

This file explains how Concept 22 (**CLAUDE.md & memory**) was added to the Claude Agent SDK Lab.
Memory files are markdown files that Claude Code adds to the context: `CLAUDE.md`, `CLAUDE.local.md`, the user's
`~/.claude/CLAUDE.md`, `.claude/rules/*.md`, nested `CLAUDE.md` files in subfolders, and the files they import with
`@path`. Concept 9 ([Tab9-System-prompts.md](Tab9-System-prompts.md)) loaded one `CLAUDE.md`. This concept shows
**which** files are read, **when**, and how to see and control it from the SDK.

**Goal:** know which memory files reach the model for a given `settingSources` and `cwd`, which ones load only later,
how to check it (`InstructionsLoaded`, `getContextUsage().memoryFiles`), and how auto memory saves notes between
sessions.

| Concept | Topic | Routes |
|---|---|---|
| 22 | `settingSources` (`project`, `local`, `user`), `CLAUDE.md`, `CLAUDE.local.md`, `@imports`, `.claude/rules/*.md` with and without `paths:`, nested `CLAUDE.md`, parent folders, `claudeMdExcludes`, the `InstructionsLoaded` hook (`load_reason`, `trigger_file_path`, `parent_file_path`), `getContextUsage().memoryFiles`, auto memory (`autoMemoryEnabled`, `autoMemoryDirectory`, `MEMORY.md`), `omitClaudeMd`, reload after `/compact` | `/api/c22/files`, `/reset`, `/run` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `memory-project/` | **New**: 7 memory files and 2 code files, each memory file with a `Marker:` line |
| `server/concepts/22-claude-md-memory.ts` | **New**: the three routes |
| `server/index.ts` | Mounts the router on `/api/c22` |
| `src/concepts/Concept22ClaudeMdMemory.tsx` | **New**: the tab (Parts A and B) |
| `src/App.tsx` | Adds the tab |
| `.gitignore` | Ignores `memory-lab/` |
| `Tab1-query().md` | Adds Concept 22 to the table |
| `Tab22-CLAUDE-md-and-memory.md` | This explanation |

---

## Step 1: The memory files

```
memory-project/                          <- the agent's cwd
├── CLAUDE.md                            🟦 PROJECT     session start ("project")
├── CLAUDE.local.md                      🟪 LOCAL       session start ("local")
├── docs/style.md                        🟨 IMPORT      pulled in by "@docs/style.md" in CLAUDE.md
├── .claude/rules/testing.md             🟩 RULE        session start (no paths:)
├── .claude/rules/api-validation.md      🟧 PATH-RULE   when a file matching api/**/*.js is read
├── api/CLAUDE.md                        🟥 NESTED      when a file inside api/ is read
├── api/orders.js
└── web/app.js

memory-lab/                              <- recreated by the server (gitignored)
├── home/CLAUDE.md                       ⬜ USER        session start ("user"), a fake ~/.claude
└── auto-memory/                         where auto memory writes (Step 6)
```

Each memory file has one `Marker:` line and one rule (*call it Orbit*, *start with "Hi Ana,"*, *use node:test*…).
The default prompt asks the model to copy every `Marker:` line it can see.

`CLAUDE.md` imports a file with a line of its own:

```markdown
- Code style: @docs/style.md
```

A rule with `paths:` loads only for matching files:

```markdown
---
paths:
  - "api/**/*.js"
---

- Marker: 🟧 PATH-RULE (...)
- Every API handler must validate its input with assertOrder() before using it.
```

## Step 2: `settingSources` decides what is read

| `settingSources` | Loaded at the start | Tested with |
|---|---|---|
| `[]` | Nothing. The model finds no marker | scenario 2 |
| `["project"]` | `CLAUDE.md`, `docs/style.md` (import), `.claude/rules/testing.md` | 1 |
| `["project", "local"]` | The same, plus `CLAUDE.local.md` | 3 |
| `["user", "project"]` | `<CLAUDE_CONFIG_DIR>/CLAUDE.md`, plus the project files | 4 |

**No system prompt is needed.** The lab's base options have no `systemPrompt` at all, and `CLAUDE.md` still loads.
With the `claude_code` preset (scenario 10) the same three files load, but the run costs about **3×** more
($0.0075 against $0.0023) because the system prompt is much bigger. Concept 9 used the preset together with
`settingSources: ["project"]`; it is `settingSources` that loads `CLAUDE.md`.

**The user file, without touching yours.** The `"user"` source reads `CLAUDE.md` from the Claude Code config folder.
The lab sets `env: { ...process.env, CLAUDE_CONFIG_DIR: "memory-lab/home" }`, so your real `~/.claude/CLAUDE.md`
is never read. That folder also receives the CLI's own files (`.claude.json`, `projects/`…), and the run
authenticates with `ANTHROPIC_API_KEY` from `.env`.

## Step 3: Seeing what was loaded

Two sources, shown side by side in the tab:

**The `InstructionsLoaded` hook** fires once per file, when it is read:

```text
session_start     Project  memory-project/CLAUDE.md
include           Project  memory-project/docs/style.md               parent_file_path: memory-project/CLAUDE.md
session_start     Project  memory-project/.claude/rules/testing.md
nested_traversal  Project  memory-project/api/CLAUDE.md               trigger_file_path: memory-project/api/orders.js
path_glob_match   Project  memory-project/.claude/rules/api-validation.md  globs: ["api/**/*.js"], trigger_file_path: …/orders.js
```

`memory_type` is `User`, `Project`, `Local` or `Managed`. A lazy load also carries a `prompt_id`.

**`q.getContextUsage().memoryFiles`** lists `{ path, type, tokens }` for every memory file in the context
(here 50, 41 and 35 tokens).

They do not tell the same story:

| | `InstructionsLoaded` | `memoryFiles` |
|---|---|---|
| Session-start files | Yes, **but not always** (below) | Yes, every time |
| Nested and path rules (lazy) | Yes, with the trigger file | **No**, not even after the file was read |
| Auto memory's `MEMORY.md` | **No** | Yes, as type `AutoMem` |
| After `/compact` | Yes, again, with `load_reason: "compact"` | Same list |

**The hook can miss the session-start calls.** In about 60 runs, 4 got no `session_start` calls at all while
`memoryFiles` listed the files and the model quoted their markers. Three of them were the first run with a fresh
`CLAUDE_CONFIG_DIR`. The tab prints a ⚠ line when `memoryFiles` has a file the hook never reported. Use the hook to
audit or react, and `memoryFiles` when you need to know what is in the context.

## Step 4: Files that load later

| Scenario | What the model reads | Loaded then |
|---|---|---|
| 5 | `api/orders.js` | `api/CLAUDE.md` (`nested_traversal`) and `api-validation.md` (`path_glob_match`) |
| 6 | `web/app.js` | Nothing: no rule matches, and `web/` has no `CLAUDE.md` |
| 9 | `api/orders.js`, then writes a test | Same as 5. The answer follows every file: *Hi Ana,*, `node:test`, single quotes, a comment naming Orbit |

A lazy file arrives **after** the `Read` result, inside the same turn. In scenario 5 the model's second message quotes
five markers: the three from the start, plus 🟥 and 🟧.

**Starting in a subfolder** (scenario 7, `cwd: memory-project/api`):

- `api/CLAUDE.md` is now read at **session start**, and so is the parent folder's `CLAUDE.md`. Claude Code walks up
  from `cwd`. (No `CLAUDE.md` exists above `memory-project/` in this course folder, or it would load too.)
- `.claude/rules/testing.md` of the parent still loads.
- **`docs/style.md` did not load.** The parent's `@docs/style.md` import was not followed from the subfolder, in
  every run.

## Step 5: `claudeMdExcludes`

```ts
settings: { claudeMdExcludes: ["**/.claude/rules/testing.md", "**/api/CLAUDE.md"] }
```

Globs are matched against the **absolute** path, hence the `**/`. In scenario 8 `testing.md` is gone from the
start, and reading `api/orders.js` loads only the path rule, not `api/CLAUDE.md`. It applies to user, project and
local files (managed ones can't be excluded).

## Step 6: Auto memory

With auto memory on, the model keeps notes of its own between sessions:

```ts
settings: { autoMemoryEnabled: true, autoMemoryDirectory: "memory-lab/auto-memory" }
systemPrompt: { type: "preset", preset: "claude_code" }   // required, see below
tools: ["Read", "Write", "Edit"]
```

| # | Setup | Prompt | Result |
|---|---|---|---|
| 11 | preset + auto memory | *Remember … my favourite colour is teal. Save it … and add it to the MEMORY.md index.* | `Write user_preferences.md`, `Write MEMORY.md`. 4 turns, ≈ $0.009 |
| 12 | same, **new session** | *What is my favourite colour?* | `MEMORY.md` in `memoryFiles` (`AutoMem`, 19 tokens). *Teal*, 1 turn |
| 13 | preset, auto memory **off** | same | `MEMORY.md` not loaded. *UNKNOWN* |
| — | auto memory, **no preset** | *Remember…* | The model tried to edit `CLAUDE.md` instead. Denied (no `Write` rule), nothing saved |

What it writes:

```markdown
<!-- MEMORY.md: the index, loaded at session start -->
- [Favourite colour is teal](user_preferences.md) — User's colour preference

<!-- user_preferences.md: one memory, read when needed -->
---
name: user_favorite_color
description: "User's favourite colour is teal"
metadata:
  node_type: memory
  type: user
  originSessionId: afe30465-…
  modified: 2026-09-25T14:40:38.329Z
---
User's favourite colour is teal.
```

- **Only `MEMORY.md` is loaded**. The memory files are read on demand. In one run of the plain prompt
  (*"Remember … teal."*) Haiku wrote `user_preferences.md` but **no index**, and the next session answered
  *UNKNOWN*. That is why scenario 11 asks for the index.
- **The preset is required.** The instructions on how to use `MEMORY.md` are part of Claude Code's system prompt.
- **Writes into `autoMemoryDirectory` need no `allowedTools` rule.** `Write` is in `tools` only; the same `Write`
  into `CLAUDE.md` was denied.
- **Always set `autoMemoryDirectory`.** The default is `~/.claude/projects/<sanitized-cwd>/memory/`, in your real
  home. The lab sets it on every run, and keeps `autoMemoryEnabled: false` unless the switch is on.
  (`autoMemoryDirectory` is ignored in a committed `.claude/settings.json`; through `options.settings` it works.)

## Step 7: Subagents and `omitClaudeMd`

```ts
agents: {
  checker: { description: "...", prompt: "...", tools: [], model: "haiku", background: false, omitClaudeMd: true },
}
```

| # | `omitClaudeMd` | The subagent's answer (the `Agent` tool result) |
|---|---|---|
| 14 | `false` | The three markers: a subagent gets the memory files too |
| 15 | `true` | *"There are no lines that start with 'Marker:'"* |

The main agent keeps its files: in 15 it reported the subagent's answer, then listed the markers from its own
context, even though the prompt said not to.

Two things the tests showed:

- In one probe without `background: false` the model started the subagent **in the background**. The `result`
  arrived first and the run ended while the subagent was still working. The lab sets `background: false` and asks
  for the foreground in the prompt.
- A foreground subagent's own messages are **not** streamed. Its answer is the `tool_result` of the `Agent` call,
  wrapped in a *"[Subagent hand-back] … The report follows:"* preamble and an `agentId: … <usage>` footer. The tab
  strips both.

## Step 8: After `/compact`

Scenario 16 sends *"Say OK."* and then `/compact` in one session. After the `compact_boundary` (1,839 → 988 tokens)
every memory file is read again:

```text
compact  Project  memory-project/CLAUDE.md
include  Project  memory-project/docs/style.md
compact  Project  memory-project/.claude/rules/testing.md
```

The summary replaced the conversation the files were part of, so they are put back. `/compact` costs a model call
(≈ $0.01 here).

**Tested but left out:** `verbatimPrompts: true` (Concept 21) changed nothing here. Session-start, nested and path
rule files all still loaded.

## Step 9: Server routes

**File:** [server/concepts/22-claude-md-memory.ts](server/concepts/22-claude-md-memory.ts)

```ts
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: PROJECT,                                                     // memory-project/
  settingSources: ["project"],
  settings: { autoMemoryEnabled: false, autoMemoryDirectory: AUTO }, // never ~/.claude/projects/.../memory/
  tools: ["Read"], allowedTools: ["Read"],
  strictMcpConfig: true, persistSession: false, maxTurns: 6,
};
```

- `GET /files` returns every `.md` in `memory-project/` with its kind (`project`, `local`, `import`, `rule`,
  `path rule`, `nested`), its frontmatter and body, plus the fake user file and whatever auto memory has written.
- `POST /reset` recreates `memory-lab/` (also done when the server starts).
- `POST /run` takes `{ prompts, switches }`: 1 to 4 prompts, sent one after the other in one session (streaming
  input, as in Concept 21's `/session`). The switches are **names** checked against fixed lists: `noProject`,
  `local`, `user` (they build `settingSources`), `subdir`, `exclude`, `preset`, `autoMemory`, `agent`,
  `omitClaudeMd`. It streams a `hook` event per `InstructionsLoaded` call and a `memory` event with
  `getContextUsage().memoryFiles` after `system/init` and after each `result`. Paths are sent relative to the
  sample folder, and `env` is never echoed (it holds the API key).

The run stops after 120 s and logs one line per result.

## Step 10: Browser flow

**File:** [src/concepts/Concept22ClaudeMdMemory.tsx](src/concepts/Concept22ClaudeMdMemory.tsx)

1. **A · The memory files**: each file, its kind, its marker, and what makes it load. Click a name to see it. Below:
   the auto-memory folder, with a **reset** link.
2. **B · A run**: 16 scenarios, or your own prompts (one per line) and switches. The **What was loaded** table has one
   row per memory file: the `InstructionsLoaded` calls (reason, `memory_type`, ms, trigger or parent) and the
   `memoryFiles` tokens after `init` and at the end. Files that never loaded are dimmed. Then: the subagent's
   answer, the answer, one `result` per prompt, the options, and the message log.

## What to take away

1. **`settingSources` loads memory, not the system prompt.** `"project"` for `CLAUDE.md` and rules, `"local"` for
   `CLAUDE.local.md`, `"user"` for `~/.claude/CLAUDE.md`. `[]` loads none.
2. **Some files load later.** A nested `CLAUDE.md` and a rule with `paths:` arrive when Claude reads a matching file.
   Put folder-specific rules there, not in the root `CLAUDE.md`.
3. **`cwd` matters.** Claude Code walks up to parent folders, so anything above your `cwd` is read too.
4. **To see what loaded, use both sources.** `InstructionsLoaded` gives the reason and the trigger, but it can miss
   session-start calls and never reports `MEMORY.md`. `memoryFiles` gives tokens, but no lazy files.
5. **`claudeMdExcludes` removes files by absolute-path glob.**
6. **Auto memory needs the preset, a `Write` tool, and an index.** Point `autoMemoryDirectory` somewhere you control.
7. **Subagents get the memory files** unless `omitClaudeMd: true`.

## Things to try in Concept 22

1. **1**, then **2**, **3**, **4**: the same prompt with each `settingSources`.
2. **5** and **6**: which file triggered what. Then add `web/CLAUDE.md` and run **6** again (no restart needed).
3. Change `paths:` in `.claude/rules/api-validation.md` to `"web/**/*.js"` and run **5** and **6**.
4. **7 · Start in api/**: compare the table with **1**.
5. **11**, **12**, **13** in that order. Then remove the index sentence from the prompt, **reset**, and try again.
6. **9 · Does it obey?**: edit `CLAUDE.local.md` to another name and run it again.
7. **14** and **15**: the same subagent with and without `omitClaudeMd`.

Costs on Haiku: $0.002 to $0.008 per scenario without the preset, $0.003 to $0.008 with it, $0.004 to $0.017 for
**11**, and about $0.012 for **16**.

## Running the app

Same as the other tabs: `npm run dev`, then open the Vite URL and select **22. CLAUDE.md & memory**. See
[Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

To call the endpoints without the UI:

```powershell
curl.exe http://localhost:3001/api/c22/files

'{"prompts":["Read api/orders.js. Then list every Marker line you can see."],"switches":["local"]}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c22/run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json

curl.exe -X POST http://localhost:3001/api/c22/reset
```
