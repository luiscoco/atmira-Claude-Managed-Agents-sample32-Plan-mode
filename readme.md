# Plan mode

This file explains Concept 32 (**Plan mode**) of the Claude Agent SDK Lab. With `permissionMode: 'plan'` the agent first
**looks** at the project (Read, Glob, Grep), writes a **plan**, and asks to leave plan mode with the built-in
`ExitPlanMode` tool. In the terminal, Claude Code shows the plan with "Would you like to proceed?". With the SDK,
**nothing is shown**: the plan reaches **your** `canUseTool`, and your code must show it, wait for the person, and send
back the decision.

**Goal:** build that approval dialog in your own UI. Know each decision you can send and what the model does with it,
how the mode changes afterwards, and who really keeps plan mode read-only (hint: not Claude Code alone).

| Concept | Topic | Routes |
|---|---|---|
| 32 | Plan mode: `permissionMode: 'plan'`, the plan file (`CLAUDE_CONFIG_DIR/plans/`, `plansDirectory`), `ExitPlanMode` in `canUseTool` (`plan`, `planFilePath`), approve with `updatedPermissions` `setMode` (`acceptEdits`) or without (the mode becomes `default`), an edited plan (`updatedInput.plan`, `planWasEdited`), keep planning (`deny` + feedback), cancel (`interrupt: true`), a host-side timeout, `system/status`, `EnterPlanMode`, `planModeInstructions`, a `PreToolUse` policy hook, who blocks writes in plan mode (the CLI without `canUseTool`, your `canUseTool` with it) | `/api/c32/who` (SSE), `/run` (SSE), `/decide`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/32-plan-mode.ts` | **New**: the options, `guard()` (the mode-aware `canUseTool`), `review()` (the pending plan), `/decide` and its checks, the policy hook, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c32` |
| `src/concepts/Concept32PlanMode.tsx` | **New**: the tab (Parts A to D), the plan card, the custom job form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The plan card, the mode badges, plan rows |
| `.gitignore` | Ignores `plan-lab/` |
| `Tab1-query().md` | Adds Concept 32 to the table |

---

## Step 1: What happens in plan mode

Every run of the lab starts from a fresh copy of a tiny project (`cart.js` and `README.md`) in
`plan-lab/runs/<run id>/`. With `permissionMode: "plan"`, Claude Code adds a plan-mode reminder to the system prompt:
you may only read, and you may write one file, the plan. In the probes, Haiku 4.5 always did the same four things:

1. `Glob` and `Read` the project. The CLI approves these by itself: `canUseTool` is not asked.
2. `Write` the plan, as Markdown, to `CLAUDE_CONFIG_DIR/plans/<slug>.md` (for example
   `plans/add-a-discount-feature-sunny-falcon.md`). This write is also approved by the CLI.
3. Call `ExitPlanMode` with the plan.
4. Wait. Nothing in the project has changed yet.

`ExitPlanMode` takes no input of its own in the types (`ExitPlanModeInput` only has a deprecated `allowedPrompts`).
Claude Code fills it in, so `canUseTool` receives:

```ts
canUseTool("ExitPlanMode", {
  plan: "# Plan: Add Discount Feature to cart.js\n\n## Context\n…",   // the plan file's text
  planFilePath: "…/plan-lab/config/plans/add-a-discount-feature-sunny-falcon.md",
}, { signal, toolUseID, … })   // no suggestions
```

**Name the tool in the prompt.** With "When the plan is ready, ask me to approve it", 2 of 4 runs wrote the plan and
then ended the turn by asking **in plain text**, without calling `ExitPlanMode`. With "…submit it for my approval with
the ExitPlanMode tool", every run called it. The host check flags a run that never asked for approval.

## Step 2: The host decides in `canUseTool`

The lab keeps the call waiting inside `canUseTool` (`review()` in the `review` region), sends the plan to the browser
as an SSE event, and resolves the promise when the browser POSTs `/api/c32/decide`. This is the same pattern as the
question card of Concept 31. The four decisions:

```ts
// Approve, and let the edits run without asking:
{ behavior: "allow", updatedInput: input,
  updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }

// Approve, but I will review each edit:
{ behavior: "allow", updatedInput: input }

// Keep planning:
{ behavior: "deny", message: "The user wants changes to the plan before approving it: <feedback>" }

// Cancel:
{ behavior: "deny", message: "The user rejected the plan and cancelled the job.", interrupt: true }
```

After an approval the model starts coding **in the same run**. Its tool_result:

```
User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: …/plans/add-a-discount-feature-sunny-falcon.md
You can refer back to it if needed during implementation.

## Approved Plan:
# Plan: Add Discount Feature to cart.js
…
```

and your code gets `tool_use_result: { plan, isAgent: false, filePath }` on the `user` message.

Claude Code sets **no time limit** on `canUseTool`. So the lab adds its own 3-minute limit, and it answers with
`deny` + `interrupt: true`: a plan that nobody reviewed must never be implemented. It does the same when the run's
`signal` is aborted.

## Step 3: The mode after approval

The approval changes the permission mode, and every change arrives as a `system/status` message:

| You return | `system/status` | Then |
|---|---|---|
| `allow` + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }]` | `permissionMode: "acceptEdits"` | Edits inside `cwd` no longer reach `canUseTool` |
| `allow`, no `updatedPermissions` | `permissionMode: "default"` | **Every** Edit and Write reaches `canUseTool`, with the suggestion `[{ type: "setMode", mode: "acceptEdits", destination: "session" }]` |
| `deny` (keep planning) | none | The mode stays `plan` |

So "approve" alone does **not** mean "approve and go": it means "leave plan mode, and ask me about each change". That
is the terminal's "Yes, and manually approve edits". To get "Yes, and auto-accept edits", send the `setMode` update.
The lab's two green buttons are exactly these two choices. With **Approve · I review each edit**, watch the orange
`canUseTool Edit` rows: the lab allows them, because they are inside the run folder.

## Step 4: Plan mode is NOT a sandbox

This is the most important result of the probes. What stops a Write to `cart.js` while the mode is `plan`?

The model does, most of the time. Asked "Do not plan. Use the Write tool right now to create hello.txt", Haiku replied
"I'm currently in plan mode, which means I can only take read-only actions". But that only comes from the prompt. Button
**0** makes the model try anyway (a system prompt append says "ALWAYS call the Write tool, even in plan mode") in three
setups:

| Setup | `ExitPlanMode` in the tool list | `canUseTool` asked | `hello.txt` |
|---|---|---|---|
| no `canUseTool` | **no** | — | denied by the **CLI**: "Cannot write to hello.txt while in plan mode.", plus a `system/permission_denied` message with `decision_reason_type: "mode"` |
| a `canUseTool` that allows everything | yes | yes | **WRITTEN**, in plan mode |
| the lab's `guard()` | yes | yes | denied by the **host** |

With a `canUseTool`, the CLI does not deny the write. It **asks your function**, and your `allow` wins. Your function is
not even told the mode: the call carries `displayName: "Write"`, `description: "hello.txt"`, `toolUseID`, `requestId`,
no suggestions, and no `permissionMode`. And without a `canUseTool`, the agent can never leave plan mode, because
`ExitPlanMode` is not offered (see Step 7).

So the host must track the mode itself (the `guard` region):

```ts
async (tool, input, { signal }) => {
  if (tool === "ExitPlanMode") return review(run, emit, input, signal);
  if (!insideRunFolder(input)) return { behavior: "deny", message: "…only files inside the project folder." };
  if (run.mode === "plan") return { behavior: "deny", message: "Plan mode is read-only: … Put this change in the plan instead." };
  return { behavior: "allow", updatedInput: input };
}
```

`run.mode` comes from `system/init` (`permissionMode`), from every `system/status`, and from the host's own approval.
The lab sets the mode **as soon as** it approves, because the model's first Edit can reach `canUseTool` before the
`system/status` message has been read. The rule is simple: in plan mode, the CLI has already approved every read-only
call, so **anything that still reaches you would change something**. Deny it.

Two more reasons to keep a path check after the approval. In an early probe with an allow-everything `canUseTool` and
Bash, the model looked **outside** its folder, then (in `acceptEdits`) edited files of another lab and ran `git init`
and `git commit`. `acceptEdits` only auto-approves edits inside `cwd`. Everything else still goes to your function. The
lab gives the agent no Bash, and `guard()` denies any path outside the run folder, in every mode.

## Step 5: Edit the plan, or send it back

**An edited plan.** When the person changes the plan in the card, the lab approves with
`updatedInput: { ...input, plan: "<the edited text>" }`. The probes and the route test showed:

- The tool_result says `## Approved Plan (edited by user):` followed by **your** text.
- `tool_use_result.planWasEdited` is `true`.
- Claude Code **overwrites the plan file** with your text.
- The model follows your version. With a plan edited to "add a SECOND function `totalWithCoupon`, do NOT change
  `total()`, do NOT touch README.md", Haiku said "I see the user has modified the plan", added only `totalWithCoupon`,
  and left `README.md` alone.

**Keep planning.** A `deny` with feedback keeps the mode at `plan`. The model gets `is_error: true` with your message,
**edits its own plan file** (an Edit of `plans/…md`, approved by the CLI), and calls `ExitPlanMode` again. The card
shows plan #2. `result.permission_denials` lists the first call. In the probe, the feedback "also add input validation (discount must be
0-100) and a test file cart.test.js" gave a revised plan, then code with the range check and a new `cart.test.js`.

**Cancel.** `deny` + `interrupt: true` gives the model "The user doesn't want to proceed… STOP what you are doing…". The
result is `error_during_execution` and `query()` throws afterwards, as in Concept 31. `runOnce()` catches it.

## Step 6: Your own planning workflow, and where the plan goes

**`planModeInstructions`** (scenario 2) replaces the **workflow part** of the plan-mode reminder. The CLI keeps the
read-only preamble and the `ExitPlanMode` footer around it. With:

```ts
planModeInstructions: "Write the plan in this exact shape and nothing else: a line 'Goal: …', then at most 4 numbered steps (one file each, under 20 words), then a line 'Risk: …'."
```

the plan was a Goal line, numbered steps and a Risk line, instead of the default "Context / Implementation / Verification"
sections. Use it for your team's plan template.

**`plansDirectory`** (a settings key) moves the plan file. It is relative to the project root:

```ts
settings: { plansDirectory: "plans" }   // → <cwd>/plans/<slug>.md, instead of CLAUDE_CONFIG_DIR/plans/
```

Tick the box in the custom job form to try it. Without it, the plan files of every session share one folder: the lab's
host check therefore reports **this run's** plan file (from `planFilePath`), not the folder's contents.

## Step 7: Entering plan mode, and when the tools are missing

**`EnterPlanMode`** (scenario 3): start in `default` with `EnterPlanMode` in `tools`, and ask the model to plan first.
It calls `EnterPlanMode` with `{}`. `canUseTool` is **not** asked, `system/status` says `permissionMode: "plan"`, and
from there it is the same loop. Your host can also switch modes itself with `query.setPermissionMode("plan")` in a
streaming-input session (Concept 26).

**No `canUseTool`**: `ExitPlanMode` and `EnterPlanMode` are removed from the tool list, as `AskUserQuestion` was in
Concept 31. The model writes the plan, replies "## Plan Complete ✓ … ready for your review", and the run ends in plan mode.
Nothing changed, and nothing can: there is no way out of plan mode in that session.

## Step 8: A policy hook reviews first

A `PreToolUse` hook with `matcher: "ExitPlanMode"` sees the plan **before** `canUseTool` (scenario 4). The lab's hook
requires a test step:

```ts
async (input) => /cart\.test\.js/.test(input.tool_input.plan)
  ? {}                                                    // pass it on: the person decides
  : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "Policy: every plan must include a test step that adds cart.test.js." } }
```

The task does not mention tests, so the first plan fails. The model gets
`PreToolUse:ExitPlanMode hook error: Policy: every plan must include a test step…`, `canUseTool` is not asked, the model
adds `cart.test.js` to its plan, and the second plan reaches your card. After approval, `cart.test.js` was created.

A hook **cannot approve a plan for the user**. With `permissionDecision: "allow"`, `canUseTool` was **still** called for
`ExitPlanMode`. That is unlike `AskUserQuestion`, where a hook's `allow` answered the question (Concept 31). So return
`{}` when the plan passes, and let the person decide.

## Step 9: The host check

After each run, the lab compares the project with its starting copy, and the changed files with the plan it approved:

- the mode timeline, for example `plan → acceptEdits`, or `default → plan → acceptEdits` for scenario 3
- every decision: `revise`, `approve (acceptEdits) edited`, …
- every call the host denied because the mode was still `plan`
- each changed file, and whether the **approved** plan names it. A file changed without an approved plan, or not named
  in it, is shown in red.
- "The model never called ExitPlanMode" when the run ended without asking, with this run's plan file

As in Concepts 30 and 31: trust what your code saw, not what the model says it did.

## Step 10: Part D, the summary

| You want | Do |
|---|---|
| Plan first, then code | `permissionMode: "plan"`, `ExitPlanMode` in `tools`, a `canUseTool`, and name `ExitPlanMode` in the prompt |
| Show the plan | Read `input.plan` (and `input.planFilePath`) in `canUseTool("ExitPlanMode")` |
| "Yes, auto-accept edits" | `allow` + `updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]` |
| "Yes, but ask me about each edit" | `allow` alone: the mode becomes `default` |
| Change the plan before approving | `allow` with `updatedInput: { ...input, plan: yourText }` |
| More planning | `deny` with the feedback as the message |
| Stop everything | `deny` + `interrupt: true`, and catch the error `query()` throws |
| A time limit | Your own timer, and `deny` + `interrupt` when it fires |
| Really read-only | Track the mode (`system/init`, `system/status`, your approvals) and deny in `canUseTool` while it is `plan` |
| Your own plan template | `planModeInstructions` |
| The plan file in the project | `settings: { plansDirectory: "plans" }` |
| Rules every plan must pass | A `PreToolUse` hook on `ExitPlanMode` that denies with a reason |

## How to try it

1. `npm run dev`, then open the **32. Plan mode** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Who keeps plan mode read-only?** and find the red "WRITTEN in plan mode" row.
3. Press **1 · Plan, then you decide**. When the card appears, read the plan and press **Approve · auto-accept edits**.
   Watch the `system/status` row and the host check. Run it again and try **Approve · I review each edit** (count the
   `canUseTool Edit` rows), **Edit the plan** then approve, **Keep planning** with feedback, and **Cancel the job**.
4. Press **2 · Your own plan format** and compare the plan's shape with scenario 1.
5. Press **3 · The model enters plan mode**: the mode badge goes `default → plan → acceptEdits`.
6. Press **4 · A policy hook reviews first**: the first plan is refused before you see it.
7. Write your own job in the form, with your own `planModeInstructions` and the `plansDirectory` box.

Each scenario costs about $0.05 or less (Haiku 4.5), and button 0 about $0.04. A plan waits for your decision for up to
3 minutes.
