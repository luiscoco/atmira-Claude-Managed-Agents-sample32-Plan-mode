# Compaction & context

This file explains how Concept 25 (**Compaction & context**) was added to the Claude Agent SDK Lab.
Every request to the model sends the **whole conversation** again, so the context grows with each turn and each
tool result. When it gets close to the window, Claude Code **compacts**: one extra model call writes a summary, and
the summary replaces the old messages. This concept measures the window, fills it on purpose, and watches both kinds
of compaction, the hooks around them, and what the model still knows afterwards.

**Goal:** read `getContextUsage()`, know when auto-compaction fires and how to move that point, use `/compact`, use
the three compaction hooks, and know what a summary keeps and what it loses.

| Concept | Topic | Routes |
|---|---|---|
| 25 | Compaction & context: `getContextUsage()` (categories and `kind`, `autoCompactThreshold`, `isAutoCompactEnabled`), `settings.autoCompactWindow`, `settings.autoCompactEnabled`, `/compact <instructions>`, auto-compaction in the middle of a turn, `system/status` (`compacting`, `compact_result`), `system/compact_boundary` (`trigger`, `pre_tokens`, `post_tokens`, `duration_ms`, `preserved_messages`), the `PreCompact` hook (`systemMessage` adds instructions, `decision: "block"` cancels), `PostCompact` (`compact_summary`), `SessionStart` with `source: "compact"` (`additionalContext`), too-large tool results saved as `<persisted-output>` | `/api/c25/window`, `/code`, `/run` (SSE) |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/25-compaction-context.ts` | **New**: the reports tool, the hooks, the routes |
| `server/index.ts` | Mounts the router on `/api/c25` |
| `src/concepts/Concept25CompactionContext.tsx` | **New**: the tab (Parts A to C) |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The context bar and the per-turn chart |
| `vite.config.ts` | `server.watch.ignored` for the lab folders (see Step 9) |
| `.gitignore` | Ignores `compact-lab/` |
| `Tab1-query().md` | Adds Concept 25 to the table |
| `Tab25-Compaction-and-context.md` | This explanation |

---

## Step 1: What is in the context

The model has no memory between requests. Claude Code sends, every time:

1. the **system prompt**,
2. the **tool definitions** (built-in tools, MCP tools, skills),
3. the **messages**: every user prompt, every answer, every tool call and every tool result so far.

`q.getContextUsage()` (a control method on a live `query()`, like in Concepts 12, 15 and 22) returns this, category
by category. Each row has a `kind`:

| `kind` | Meaning |
|---|---|
| `used` | In the window now: `System prompt`, `System tools`, `MCP tools`, `Skills`, `Messages`… |
| `buffer` | Kept free on purpose: `Autocompact buffer`, or `Compact buffer` when auto-compaction is off |
| `free` | What is left |
| `deferred` | Tool schemas that are **not** in the window (behind `ToolSearch`), listed for information only |

Classify rows by `kind`, never by the English `name`. `detail: "summary"` answers from the last response's usage and
is fast between turns; `detail: "full"` (the default) counts each category with the token-count API.

## Step 2: The empty window, in four setups (Part A)

Part A starts four sessions whose prompt is a generator that never sends anything (`silent()`), so **no model call
is made**. It waits for the `ops` MCP server to connect (`q.mcpServerStatus()`), then calls `getContextUsage()`:

| Setup | Used | Window | `autoCompactThreshold` | Rows worth a look |
|---|---|---|---|---|
| default (`systemPrompt` string, `tools: []`, 1 MCP tool) | 124 | 200,000 | 167,000 | System prompt 16, MCP tools 100 |
| `claude_code` preset | 18,933 | 200,000 | 167,000 | System prompt 3,296, System tools 14,156, **System tools (deferred) 14,177**, Skills 1,373 |
| `settings: { autoCompactWindow: 100_000 }` | 124 | 100,000 | 67,000 | **Autocompact buffer 33,000** |
| `settings: { autoCompactEnabled: false }` | 124 | 200,000 | — | **Compact buffer 3,000**, `isAutoCompactEnabled: false` |

Where the threshold comes from, for Haiku 4.5 (read in the CLI and matched by every measurement):

```
effective window = window − min(max output tokens, 20,000)      200,000 − 20,000 = 180,000
threshold        = effective window − 13,000                    180,000 − 13,000 = 167,000
with autoCompactWindow: 100,000                                 100,000 − 20,000 − 13,000 = 67,000
```

`autoCompactWindow` accepts **100,000 to 1,000,000** tokens (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). The lab uses the
smallest one, so compaction happens in a few turns instead of after 167,000 tokens.

## Step 3: The lab session (Part B)

One session with streaming input (Concept 12): the next prompt is sent only after the previous `result`.

- An MCP tool `read_report(n)` returns a weekly ops report of **45,000 characters (about 16k tokens)**. The top of each
  report has an incident code and an owner (`ORCA-117 · team Madrid`…). Report 2 has **one extra line in the
  middle**: *"the rollback window for ORCA-227 closes on Friday at 17:00"*.
- One turn per report: *"Read report n and tell me its incident code in one line."*
- In `manual` mode, then: `/compact Focus on the ops reports.`
- The last turn asks, without tools, for every incident code and owner, the rollback deadline, and **who is on call**.
  The on-call engineer is in no report: only the `SessionStart` hook can provide it.
- After every `result` the server calls `getContextUsage({ detail: "summary" })`, and the tab draws one column per call.
- At the end the server checks the answer for each fact (the "What the model still knew" table).

```ts
const options: Options = {
  model: "claude-haiku-4-5-20251001",
  systemPrompt: "You are an ops assistant. Answer briefly.",
  tools: [],                                      // only the MCP tool
  mcpServers: { ops: opsServer(...) },
  allowedTools: ["mcp__ops__read_report"],
  settingSources: [],
  persistSession: false,
  env: { ...processEnvWithoutClaude, CLAUDE_CONFIG_DIR: "compact-lab/config" }, // Step 7
  settings: { autoCompactWindow: 100_000 },      // + autoCompactEnabled: false in mode "off"
  hooks: { PreCompact: [...], PostCompact: [...], SessionStart: [{ matcher: "compact", hooks: [...] }] },
};
```

## Step 4: Manual compaction with `/compact`

`/compact` is a built-in slash command (Concept 21), sent as a normal user message. Anything after it becomes the
**custom instructions** for the summary. Scenario 1 (two reports, then `/compact`):

```
turn 3  /compact Focus on the ops reports.
status  "compacting"
hook    PreCompact   trigger: manual · custom_instructions: "Focus on the ops reports."
hook    SessionStart source: compact
hook    PostCompact  compact_summary: 4,915 characters
status  null · compact_result: "success"
system/compact_boundary  trigger: manual · pre_tokens 33,512 → post_tokens 1,117 · 13,189 ms
result  success · num_turns 0
```

The context went from 33,493 to 1,419 tokens. `num_turns: 0`, but it is **not free**: the summary is a model call
that reads the whole conversation (+$0.025 here).

## Step 5: Auto-compaction

No `/compact` this time: five reports in the 100k window (scenario 2).

| After turn | Context | |
|---|---|---|
| 1 | 17,174 | |
| 2 | 33,491 | |
| 3 | 49,817 | |
| 4 | 66,143 | just under 67,000 |
| 5 | 17,925 | compacted **during** turn 5 |

Turn 5 called `read_report(5)`. Adding its result would push the next request past the threshold, so **before that
model call** Claude Code compacted (`trigger: "auto"`, `custom_instructions: null`), 77,548 → 12,223 tokens in about
10 s, and then finished the turn: *"ORCA-557"*. Auto-compaction can happen **in the middle of a turn**, between two
tool calls, not only between prompts.

`post_tokens` (12,223) is much more than the summary. `preserved_messages` lists 3 message uuids: the **latest
messages are kept word for word** (here the report 5 tool call and its result), and only the older ones are
summarised.

## Step 6: The three hooks

All three are ordinary SDK hook callbacks (Concepts 7 and 20). Their matcher is the `trigger` (`manual` / `auto`) for
`PreCompact` / `PostCompact`, and the `source` for `SessionStart`.

### `PreCompact`: before the summary call

```ts
const preCompact: HookCallback = async (input) => {
  // input.trigger: "manual" | "auto" · input.custom_instructions: the /compact words, or null
  if (block) return { decision: "block", reason: "..." };          // cancel this compaction
  return { systemMessage: "Keep every incident code with its owner, exactly." }; // ADD instructions
};
```

- `systemMessage` is **appended** to the custom instructions, after the user's `/compact` words. This is the only way
  to steer an **auto** compaction, which has no user text.
- `decision: "block"` cancels it (scenario 4). `status` goes `compacting` then straight back to `null`, with no
  boundary. Claude Code **asks again before the next request**: in the test, `PreCompact` fired in turn 5 and again
  in turn 6, and the context stayed at 82,503 tokens, over the threshold. Blocking is only safe while the model's real
  limit (200k for Haiku) is still far away.

### `PostCompact`: the summary

`input.compact_summary` is the text that now stands for everything before the boundary. The tab shows it in full. It
starts with an `<analysis>` block, then a `<summary>` with sections (*Primary request*, *Key technical concepts*, *All
user messages*, *Pending tasks*, *Current work*, *Optional next step*). Log it, check it, or store it somewhere.

### `SessionStart` with `source: "compact"`: put things back

`SessionStart` runs again after each compaction. Whatever it returns as `additionalContext` is added **after** the
summary, whatever the summary kept:

```ts
SessionStart: [{ matcher: "compact", hooks: [async () => ({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "…the on-call engineer this week is Marta Ruiz." },
})] }]
```

Scenario 3: the recall question was answered with *"On-call this week: Marta Ruiz"*, a fact that was never in the
conversation. Without the hook the answer is "unknown". Use it for rules and state that must survive every
compaction. CLAUDE.md files are reloaded the same way (`InstructionsLoaded` with `load_reason: "compact"`,
Concept 22).

## Step 7: What a summary keeps

| Fact | Where | Survived |
|---|---|---|
| Incident codes + owners | first lines of each report | **Always**, in every run |
| Rollback deadline | one line in the middle of report 2 | **Sometimes**: kept in 2 of the 3 runs that compacted, lost in 1 |
| On-call engineer | only in the `SessionStart` hook | Only with the hook |

A summary is written by a model: it is **lossy and not deterministic**. What was asked about survives. A detail
nobody mentioned may or may not. If something must survive, re-inject it (`SessionStart`), ask for it
(`PreCompact` → `systemMessage`, or `/compact <instructions>`), or store it outside the conversation (a file, memory,
Concept 22).

One side effect was seen in the tests: after an auto-compaction, the next answer once copied the summary's format
(*"Analysis Block … Summary Block"*).

## Step 8: Too-large tool results never enter the context

The first version of the lab used 60,000-character reports, and the context barely grew: about 1,000 tokens per
report instead of 19,000. When a tool result is **over about 50,000 characters**, Claude Code saves it to a file and
sends the model a preview instead:

```
<persisted-output>
Output too large (59.4KB). Full output saved to: compact-lab\config\projects\…\tool-results\toolu_….json
Preview (first 2KB):
…
```

The model can read the file only if it has a `Read` tool, and this lab gives it none. So with the **huge reports**
switch (scenario 6) the model still saw the incident codes (they are in the first 2 KB), but never the rollback
deadline. The reports were cut to 45,000 characters so they stay in the context and can fill it.

The file is written under `<CLAUDE_CONFIG_DIR>/projects/<cwd>/<session>/tool-results/` **even with
`persistSession: false`**. In the first test it landed in the real `~/.claude/projects/` and had to be deleted by
hand. The lab now sets `CLAUDE_CONFIG_DIR=compact-lab/config` (like Concept 23), so these files stay in the sample.

Keeping tool results small is the cheapest context management: page or filter in the tool, return only what the
model needs.

## Step 9: Auto-compaction off

`settings: { autoCompactEnabled: false }` (or `DISABLE_AUTO_COMPACT=1`). Scenario 5 read six reports: 98,815 tokens
in the "100,000" window, and nothing stopped them. `autoCompactWindow` is a **compaction policy**, not a hard limit
(`getContextUsage().over_limit.kind` has the same two words: `compaction_window` vs `hard_limit`). The real limit
is the model's (200k for Haiku), and past it the API refuses the request. Without compaction every request resends
everything, so the last turns are the most expensive.

## Step 10: The costs

| Scenario | Cost (measured) |
|---|---|
| 1 · `/compact` by hand (2 reports) | $0.076 |
| 2 / 3 · auto-compaction (5 reports) | $0.13 |
| 4 · `PreCompact` blocks (5 reports) | $0.13 |
| 5 · auto-compaction off (6 reports) | $0.17 |
| 6 · huge tool results (2 reports) | $0.013 |
| Part A | $0 |

The reports are cached (Concept 15), so each turn mostly pays to **write** its new report to the cache. The
compaction itself cost $0.025 to $0.04.

## Step 11: Which knob, when (Part C)

| Knob | Use it to |
|---|---|
| `q.getContextUsage()` | Measure before you decide: show a meter, warn the user, compact yourself |
| `settings.autoCompactWindow` | Compact earlier than the model's window (cost, speed, or a smaller "working set") |
| `settings.autoCompactEnabled: false` | Short sessions, or a host that decides when to compact |
| `"/compact <instructions>"` | Compact at a good moment (a task is done), with a focus |
| `PreCompact` → `systemMessage` | Tell every compaction, auto included, what must be kept |
| `PreCompact` → `decision: "block"` | Postpone compaction at a bad moment (use with care) |
| `PostCompact` | Log or check the summary |
| `SessionStart`, matcher `compact` | Put rules and state back after every compaction |
| Small tool results | Don't fill the window in the first place |

## Things to try

1. **A**: compare the preset with the default: 18,933 tokens before saying anything, and 14,177 more deferred.
2. **B · 1**: open `compact_summary`, find the *All user messages* section, compare `pre_tokens` / `post_tokens`.
3. **B · 2**: watch the chart: four columns climb to the dashed line, the fifth falls. Look at the event times:
   the compaction is inside turn 5.
4. **B · 3**: the recall table goes green for *Marta Ruiz*. Run it again without **SessionStart re-injects**.
5. **B · 4**: count the `PreCompact` rows. The column stays over the line.
6. **B · 5**: the last column is almost at the top, and it cost the most.
7. **B · 6**: read the `<persisted-output>` row, then the red rollback line in the recall table.
8. Use **reports** and the switches to try your own combinations, e.g. `manual` + 5 reports + **PreCompact blocks**
   (a blocked `/compact`).
