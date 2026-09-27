# Todo tracking

This file explains Concept 30 (**Todo tracking**) of the Claude Agent SDK Lab. On a job with several steps, the agent
can keep a **todo list**: it writes a plan, marks one task `in_progress`, and then marks it `completed`. Claude Code has
**two** todo tools, and which one the model gets depends on the model and on two env variables. This concept shows
both tools, what your code sees of them, and how the **host** can write the plan, watch it, check it, and refuse
changes to it.

**Goal:** know which todo tool your agent has, how to show its plan live in your UI, and how to make the plan
something your code controls, not only something the model says.

| Concept | Topic | Routes |
|---|---|---|
| 30 | Todo tracking: the Task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`) vs `TodoWrite`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, the `tools` option, deferred tools and `ToolSearch`, `tool_use_result` (`oldTodos` / `newTodos`, `statusChange`), the task files in `CLAUDE_CONFIG_DIR/tasks/`, `CLAUDE_CODE_TASK_LIST_ID`, `blockedBy`, the `TaskCreated` / `TaskCompleted` hooks, resume, a live todo board | `/api/c30/tools` (SSE), `/run` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/30-todo-tracking.ts` | **New**: the options, the board (disk poller + `TodoWrite` reader), the hooks, the seeded plan, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c30` |
| `src/concepts/Concept30TodoTracking.tsx` | **New**: the tab (Parts A to D), the todo board, the custom job form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Todo board, todo rows, board-change rows |
| `.gitignore` | Ignores `todo-lab/` |
| `Tab1-query().md` | Adds Concept 30 to the table |

---

## Step 1: Two todo tools

| | **Task tools** | **TodoWrite** |
|---|---|---|
| Tools | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | `TodoWrite` |
| One change is | One call: `TaskUpdate { taskId: "2", status: "completed" }` | The **whole list again**: `TodoWrite { todos: [ … ] }` |
| Stored in | `CLAUDE_CONFIG_DIR/tasks/<list>/<id>.json` | Only the transcript |
| Dependencies | `blockedBy` / `blocks` | No |
| Hooks | `TaskCreated`, `TaskCompleted` | None |

Both use the same three statuses: `pending`, `in_progress`, `completed`. A task also has an `activeForm` ("Writing
total.txt"), the text a UI shows while the task runs. `TaskUpdate` also accepts `status: "deleted"`.

The types are in `sdk-tools.d.ts`: `TaskCreateInput`, `TaskUpdateInput`, `TodoWriteInput`, and their outputs.

## Step 2: Which one the model gets

Measured with the **0 · Which todo tools** button, which sends "Reply ok" once for each setup and reads `system/init`:

| Setup | Todo tools in `system/init` |
|---|---|
| Haiku 4.5, default tool set | `TaskCreate, TaskGet, TaskList, TaskUpdate` |
| Haiku 4.5, `CLAUDE_CODE_ENABLE_TASKS=false` | `TodoWrite` |
| Sonnet 5, default tool set | **none** |
| Sonnet 5, `tools` lists them | `TaskCreate, TaskGet, TaskList, TaskUpdate` |
| Sonnet 5, default tool set, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | `TaskCreate, TaskGet, TaskList, TaskUpdate` (probe) |
| Haiku 4.5, `tools: ["Read", "Write"]` | none |

Rules:

- **`CLAUDE_CODE_ENABLE_TASKS=false`** swaps the Task tools for `TodoWrite`.
- In the **default tool set**, the todo tools are on for a list of known models (Haiku 4.5, Sonnet 4.5, …). A newer
  model such as `claude-sonnet-5` gets none, unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set.
- With an explicit **`tools`** list, the todo tools are there only if you list them, and then every model gets them.
  The lab always lists them. A short list is also cheaper: "Reply ok" cost $0.004 instead of $0.02.

`Task` in the default list is the **subagent** tool (Concept 8), and `TaskStop` stops a **background** task
(Concept 27). Neither is a todo tool.

## Step 3: Deferred tools, and when the model plans

In the default tool set, the todo tools are **deferred** (Concept 25): their schemas are not in the request. The model
must load them first with `ToolSearch`:

```
tool_use ToolSearch   {"query":"select:TaskCreate","max_results":1}
tool_use TaskCreate   {"subject":"Read prices.csv", …}
```

Two things follow from this:

1. **The model rarely plans unless the prompt asks it to.** Asked to "plan with your task list", Haiku wrote the list
   in plain text and never called `TaskCreate`. Only a prompt that named the tool made it load and use it. A prompt
   with no word about planning (**4 · Not asked to plan**) got no list at all, even with `ENABLE_TOOL_SEARCH=false`
   (every tool loaded) and even with the `claude_code` system prompt. **If you want a todo list, ask for one.**
2. **A deferred tool called before its schema is loaded can fail.** `TaskGet {"id":"1"}` returned an
   `InputValidationError`, and the model then loaded the schema and tried again.

With an explicit `tools` list, the lab's tools are few, so nothing is deferred and there is no `ToolSearch` call.
Scenario **3 · Default tool set** shows the deferred path.

## Step 4: What your code sees

Every todo call arrives as a normal `tool_use` and `tool_result`. The user message that carries the result also has
**`tool_use_result`**, the tool's full output object:

```ts
// TaskCreate
{ task: { id: "1", subject: "Read prices.csv" } }
// TaskUpdate
{ success: true, taskId: "1", updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } }
// TaskList
{ tasks: [{ id: "1", subject: "…", status: "pending", blockedBy: [] }, …] }
// TodoWrite: the list before and after
{ oldTodos: [ … ], newTodos: [ … ] }
```

Measured on the same 4-step job (scenarios 1 and 2):

| | Task tools | TodoWrite |
|---|---|---|
| Todo calls | 12 (4 × `TaskCreate`, 8 × `TaskUpdate`) | 5 |
| Turns | 17 | 10 |
| Output tokens | 1,699 | 1,826 |
| Cost | $0.025 | $0.025 |

`TodoWrite` needs fewer calls, because one call can complete a task and start the next. Each call writes more tokens,
though, because it repeats the whole list. After a `TodoWrite` call in which **every** item is `completed`, Claude
Code empties its stored list: the next call's `oldTodos` is `[]`.

## Step 5: A live todo board

The tab shows a **todo board** above the events. It is built in two ways:

```ts
// Task tools: read the files, the same source TaskList reads. Polled every 250 ms.
const dir = path.join(CONFIG_DIR, "tasks", listId ?? sessionId);
for (const f of readdirSync(dir)) if (/^\d+\.json$/.test(f)) items.push(JSON.parse(readFileSync(path.join(dir, f), "utf8")));

// TodoWrite: nothing is on disk, so read tool_use_result
if (toolName === "TodoWrite" && msg.tool_use_result?.newTodos) board = msg.tool_use_result.newTodos;
```

A task file looks like this:

```json
{ "id": "2", "subject": "Write total.txt", "description": "Sum the prices …", "activeForm": "Writing total.txt",
  "status": "completed", "blocks": ["3"], "blockedBy": [] }
```

The folder also holds a `.lock` file and a high-water-mark file for the next ID, so the lab reads only `<number>.json`.
Each status change becomes a green **board** row in the event list: `#2 Write total.txt: in_progress → completed`.

Reading the files has one advantage over reading the tool results: it also shows changes the **host** makes (Step 7).

## Step 6: The list's name, and resume

By default, the list is named after the **session ID**: `tasks/<session id>/`. A resumed session keeps its ID, so it
keeps its list. In **7 · Resume keeps the list**, run 1 plans 4 tasks and does one. Run 2 is a new `query()` with
`resume`. The model goes on from task 2, without calling `TaskList` or planning again.

With `TodoWrite`, resume works too: the old `TodoWrite` calls are in the transcript.

## Step 7: The host writes the plan

`CLAUDE_CODE_TASK_LIST_ID` names the list instead of the session ID. The host can then **write the plan before the
run**:

```ts
env.CLAUDE_CODE_TASK_LIST_ID = "plan-1234";
writeTask("1", "Write total.txt", "…", [], ["3"]);
writeTask("2", "Write cheapest.txt", "…", [], ["3"]);
writeTask("3", "Write report.txt", "…", ["1", "2"]);   // blockedBy 1 and 2
```

The prompt only says "Your task list already holds the plan. Use TaskList…". The model sees:

```
#1 [pending] Write total.txt
#2 [pending] Write cheapest.txt
#3 [pending] Write report.txt [blocked by #1, #2]
```

It followed the order and the dependencies in every run. The same variable also lets several sessions (or a
session and your UI) share one list.

## Step 8: Hooks that gate the plan

`TaskCreated` and `TaskCompleted` run **before** the change is saved. Their input has `task_id`, `task_subject` and
`task_description`. Returning `{ decision: "block", reason }` refuses the change:

| Hook | When it blocks |
|---|---|
| `TaskCreated` | The task is deleted and its ID is skipped. The model gets an `is_error` tool_result: "TaskCreated hook feedback: …" |
| `TaskCompleted` | The status stays as it was. The tool_result is **not** `is_error`, but `tool_use_result` is `{ success: false, error: "TaskCompleted hook feedback: …" }` |

Scenario **6 · Hooks gate the plan** uses three rules:

```ts
if (name === "TaskCreated" && /delete|remove/i.test(subject)) return block("Policy: tasks that delete files are not allowed in this lab.");
if (name === "TaskCompleted" && !existsSync(file)) return block(`${file} does not exist yet. Write it, then mark task ${id} completed again.`);
if (name === "TaskCompleted" && file === "report.txt" && !/^END$/m.test(text)) return block("report.txt must end with a line that says END. …");
```

After task 2, the host also writes `4.json` ("Write dearest.txt") itself.

What happened: the model marked task 3 completed, was refused, read `report.txt`, added `END`, and marked it again.
The delete task was refused. At the end, `TaskList` showed the host's task #4, and the model did it too.

Lessons:

- **The `reason` goes to the model.** Write it as an instruction the model can act on. In a probe, a vague reason
  ("Before completing, check the file…") was **ignored**: the model moved on and task 1 stayed `in_progress` forever.
- **Neither todo tool asks for permission.** `canUseTool` is never called for them. The hooks are how you control
  them. For `TodoWrite`, which has no hooks, use `PreToolUse` with matcher `TodoWrite`.

## Step 9: The host checks the plan

A final "DONE" from the model proves nothing. After each run, the lab reads the board and writes a **host check**
row: `4/4 completed`, or the tasks left and their status, plus the files the agent wrote. This check caught the ignored
refusal in Step 8. It cannot catch **wrong** work: in one resume run, the model wrote a total of 9.75 instead of 8.75
and marked the task completed. Checks that matter belong in `TaskCompleted` (Step 8).

## Step 10: Part D, which one to use

| You want | Use |
|---|---|
| A plan the host can write, share and check | Task tools + `CLAUDE_CODE_TASK_LIST_ID` + the hooks |
| To show the model's progress in a UI | Either: the task files, or `tool_use_result.newTodos` |
| A list that dies with the transcript | `TodoWrite` (`CLAUDE_CODE_ENABLE_TASKS=false`) |
| A model outside the default list (for example Sonnet 5) | List the todo tools in `tools` (or set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) |
| The model to plan at all | Ask it to, in the prompt |

## How to try it

1. `npm run dev`, then open the **30. Todo tracking** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Which todo tools does each setup get?** and look at the Sonnet 5 rows.
3. Press **1 · Task tools** and watch the board fill in from the task files. Then press **2 · TodoWrite**, and compare
   the `tool_use_result` rows (`statusChange` vs `oldTodos` / `newTodos`).
4. Press **3 · Default tool set** and find the `ToolSearch` call. Press **4 · Not asked to plan**: the board stays empty.
5. Press **5 · The host writes the plan**: the board is full before the model starts.
6. Press **6 · Hooks gate the plan**: find the red `block` rows, the `success: false` result, and task #4 added by
   the host.
7. Write your own job in the form, and switch between Task tools and TodoWrite.

Each scenario costs $0.05 or less.
