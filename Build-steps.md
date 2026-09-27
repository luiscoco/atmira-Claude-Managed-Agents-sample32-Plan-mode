# Plan mode

This file describes the **steps followed** to add Concept 32 (**Plan mode**) to the Claude Agent SDK Lab: what was
read, what was probed, what was decided, how it was tested, and what the tests changed. To learn the concept itself,
read [Tab32-Plan-mode.md](Tab32-Plan-mode.md) (the same text is in `readme.md`).

| Concept | Topic | Routes | Explanation |
|---|---|---|---|
| 32 | The agent plans read-only and waits for approval: a host dialog in `canUseTool("ExitPlanMode")`, every decision (auto-accept edits, review each edit, an edited plan, keep planning, cancel, timeout), the mode after approval, `EnterPlanMode`, `planModeInstructions`, `plansDirectory`, a policy hook, who keeps plan mode read-only | `/api/c32/who`, `/run`, `/decide`, `/code` | [Tab32-Plan-mode.md](Tab32-Plan-mode.md) |

## How to run it

```powershell
npm run dev        # server on http://localhost:3001, web on the Vite port
```

`node_modules` was copied from sample31, so `npm install` is not needed. Open the **32. Plan mode** tab.
`ANTHROPIC_API_KEY` must be in `.env`. Start it from a normal terminal, not from inside Claude Code (see Tab16). Each
scenario costs about $0.05 or less.

> **Only one sample can run at a time.** Every sample's server uses port **3001**. Stop the other samples'
> `npm run dev` first.

## Step 1: Choose the feature

The request said "implement the following feature sample" with no feature text, as in sample28 to sample31. A grep of
the `Tab*.md` files and of `server/` and `src/` found no `ExitPlanMode`, `onElicitation`, `spawnClaudeCodeProcess` or
`outputStyle`. Plan mode appeared only as one value of `permissionMode` (Tab3 scenario 5, Tab26 `setPermissionMode`).
Four topics were offered, and **Plan mode** was chosen.

## Step 2: Read what the course already said

sample32 held a copy of sample31 without `node_modules`, so `node_modules` was copied from sample31.

| Read | To learn |
|---|---|
| `Build-steps.md`, `31-ask-user-question.ts`, `Concept31AskUserQuestion.tsx` | The latest style: a pending promise per question inside `canUseTool`, a POST route that resolves it, a host timeout, strict zod bodies, `relay()`, `#region` + `/code`, a setups table (button 0), a fake `CLAUDE_CONFIG_DIR`, a folder per run, a host check |
| `server/index.ts`, `server/sse.ts`, `src/lib/sse.ts`, `src/App.tsx`, `src/styles.css` | Mounting, SSE, the tab list, the CSS classes to reuse |
| `Tab3-Built-in-tools.md`, `Tab26-Query-control-methods.md` | What was already shown about plan mode: the plan file in `CLAUDE_CONFIG_DIR/plans/`, `system/status` |

## Step 3: Check the types

In `sdk.d.ts` and `sdk-tools.d.ts` (`0.3.281`):

| Found | Used for |
|---|---|
| `PermissionMode` includes `'plan'`; `Options.planModeInstructions` ("replaces the default code-implementation workflow body… still wraps it with the read-only enforcement preamble and the ExitPlanMode protocol footer") | Scenarios 1 and 2 |
| `ExitPlanModeInput` (only a deprecated `allowedPrompts`), `ExitPlanModeOutput` (`plan`, `isAgent`, `filePath`, `planWasEdited`), `EnterPlanModeInput` = `{}` | The card, the tool_result row |
| `PermissionUpdate` `{ type: 'setMode', mode, destination }`, `PermissionResult` (`updatedPermissions`, `interrupt`) | The two approve buttons, cancel |
| `CanUseTool` options: `suggestions`, `decisionReason`, `title`, `displayName`, `description`, `toolUseID`… and **no** permission mode | `guard()` must track the mode |
| Settings `plansDirectory` ("relative to project root, default ~/.claude/plans/"), `showClearContextOnPlanAccept` | The custom form's checkbox |

## Step 4: Probe before designing

A scratchpad script (in a temporary `.probe/` folder) ran real sessions with Haiku 4.5, each with its own folder and
`CLAUDE_CONFIG_DIR`, and printed every `canUseTool` call, tool call, tool_result and `system/*` message:

| Probe | Result | Decision |
|---|---|---|
| Approve with `setMode: acceptEdits` | `canUseTool("ExitPlanMode", { plan, planFilePath })`, no suggestions; `system/status` → `acceptEdits`; "User has approved your plan… ## Approved Plan:"; edits no longer asked | The core of the lab |
| Approve without `updatedPermissions` | The mode became **`default`**, and every Edit reached `canUseTool` with a `setMode acceptEdits` suggestion | Two approve buttons |
| Approve with `updatedInput.plan` changed | "## Approved Plan (edited by user):", `planWasEdited: true`, the plan file overwritten, the model followed it | The card's Edit button |
| `deny` with feedback | Stayed in `plan`; the model edited its plan file and called `ExitPlanMode` again | Keep planning |
| `deny` + `interrupt: true` | "STOP…", `error_during_execution`, `query()` throws | Cancel; `runOnce()` catches |
| No `canUseTool` | `ExitPlanMode` and `EnterPlanMode` not in `system/init`; the plan written; the run ended in plan mode | Button 0, Step 7 |
| "Do not plan, write hello.txt now" | The model refused on its own ("I'm currently in plan mode") | Button 0 needs a system prompt append that makes it try |
| A forced Write, no `canUseTool` | "Cannot write to … while in plan mode" + `system/permission_denied` (`decision_reason_type: "mode"`) | Button 0 |
| A forced Write, `canUseTool` allows all | `canUseTool` asked with no mode hint, and **the file was written** | `guard()`; Step 4 of the explanation |
| An allow-all `canUseTool` with Bash | The model looked outside its folder; after approval it edited another lab's files and ran `git init` / `git commit` | No Bash in the lab; a path check in every mode (the other lab's files were restored from sample31) |
| `PreToolUse` hook `deny` / `allow` on `ExitPlanMode` | deny → "PreToolUse:ExitPlanMode hook error: <reason>", the model revised; allow → `canUseTool` **still** called | Scenario 4; the hook returns `{}` when the plan passes |
| `EnterPlanMode` from `default` | Not sent to `canUseTool`; `system/status` → `plan` | Scenario 3 |
| `planModeInstructions`, `plansDirectory: "plans"` | A 3-step plan; the plan file in `<cwd>/plans/` | Scenario 2, the custom form |

## Step 5: Design the concept

- **A pending plan per call.** `review()` puts a `{ run, input, done }` entry in a map keyed by `<run id>:<plan id>`,
  emits a `plan` SSE event, and returns a promise. `POST /decide` validates the body, builds the `PermissionResult`
  (`toResult()`) and calls `done`. A 3-minute timer and the abort `signal` send `deny` + `interrupt`.
- **The host tracks the mode.** `run.mode` starts from the option, follows `system/status`, and is set by the host as
  soon as it approves. `guard()` denies any path outside the run folder, and any call that reaches it while the mode
  is `plan`.
- **One router, four routes.** `POST /who` (3 setups in parallel), `POST /run` (5 scenarios: `review`, `instructions`,
  `enter`, `policy`, `custom`), `POST /decide`, `GET /code`.
- **A fresh project per run** (`plan-lab/runs/<id>/` with `cart.js` and `README.md`), and one fake
  `CLAUDE_CONFIG_DIR` (`plan-lab/config`).
- **The card**: the plan, Edit the plan (a textarea), Approve · auto-accept edits, Approve · I review each edit, a
  feedback field + Keep planning, Cancel the job, a countdown.
- **The host check**: the mode timeline, the decisions, the calls denied in plan mode, each changed file and whether
  the approved plan names it.

## Step 6: Implement it

| File | What was done |
|---|---|
| `server/concepts/32-plan-mode.ts` | New: `newRun()`, `baseOptions()`, `guard()`, `review()`, `DecideBody` + `toResult()` + `/decide`, `planPolicy()`, `relay()`, `check()`, the routes |
| `server/index.ts` | Mounted on `/api/c32` |
| `src/concepts/Concept32PlanMode.tsx` | New: `PlanCard`, `Timeline`, `Check`, `WhoTable`, Parts A to D, the custom job form |
| `src/App.tsx`, `src/styles.css` | Tab; `.tag-plan`, `.tool-call.plan`, `.mode-*`, `.plan-*` |
| `.gitignore`, `Tab1-query().md` | `plan-lab/`, table row |

`npx tsc --noEmit -p .` passed.

## Step 7: Test the routes

Port 3001 was left free for the other samples. A scratchpad script (`serve.ts`) mounted **only** the Concept 32 router
on port **3132**, with `.env` loaded and the `CLAUDE*` variables removed. A second script (`drive.ts`) posted each body
the way the tab does, printed each SSE event on one line, and answered each `plan` event with `POST /decide`.

| Test | Result |
|---|---|
| `/run`: `{ scenario: "rm" }`, `prompt` on `review`, `custom` with no prompt, `plansInProject` on `review`, an unknown key | Refused with a clear message, nothing started |
| `/decide`: `{}`, approve with no mode, revise with no feedback, cancel with a mode, `action: "rm"`, an unknown plan | 400, 400, 400, 400, 400, 404 |
| `review` + approve `acceptEdits` | `plan → acceptEdits`; both files changed, both named in the plan |
| `review` + approve `default` | `plan → default`; 2 `canUseTool Edit` rows |
| `review` + revise, then approve | Plan #2, then approved; `permission_denials: ExitPlanMode` |
| `review` + an edited plan | `planWasEdited`; only `cart.js` changed, as the edited plan said |
| `review` + cancel | `error_during_execution`, the thrown error caught; nothing changed |
| `instructions`, `enter`, `policy`, `custom` + `plansInProject` | Goal/steps/Risk plan; `default → plan → acceptEdits`; policy fail then pass, `cart.test.js` created; the plan in `plans/` |
| `/who` | allow-all: WRITTEN; no `canUseTool`: denied by the CLI (`mode`); the lab's guard: denied by the host |

## Step 8: What the tests changed

- **"Ask me to approve it" made the model ask in text.** In the first route test, 2 of 4 `review` runs wrote the plan
  and ended the turn without calling `ExitPlanMode`. The prompts now say "submit it for my approval with the
  ExitPlanMode tool", and every later run called it. The host check still flags a run that never asked.
- **The host check listed every run's plans.** All runs share `plan-lab/config/plans/`. The check now reports this
  run's plan file only (from `planFilePath`, or the Write into a `plans/` folder).
- **Button 0 waited 3 minutes.** In the guard setup the model called `ExitPlanMode` after its write was denied, and
  `review()` waited for a decision that button 0 never sends. `/who` now refuses plans at once (`deny` + `interrupt`),
  and a denied model that retries until `maxTurns` is shown as a note, not as an error.

## Step 9: Run it in the real app

Vite ran on port **5199** with a scratchpad config whose proxy pointed to the 3132 server, and headless Edge was driven
through the DevTools protocol (`shot.mjs`, its profile in the scratchpad), with a real run:

| Check | Page |
|---|---|
| Open tab 32 | The 7 code buttons are there |
| Click scenario 1 | The plan card appears with the plan and its file path; Keep planning is disabled while the feedback is empty |
| Edit the plan (add a step) | "edited: approving sends your version in updatedInput.plan" |
| Approve · auto-accept edits | The card closes; the badge shows `mode: acceptEdits`; the tool_result says "Approved Plan (edited by user)"; host check `plan → acceptEdits · approve (acceptEdits) edited`, both files named in the plan |
| Console | No error |

All test processes were stopped, and `plan-lab/` and `.probe/` were deleted.

Costs: about $1.40 for all the probes, route tests and the browser test.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/32-plan-mode.ts` | New: the Concept 32 routes, the pending plans, the guard, the policy hook |
| `server/index.ts` | Mounts `/api/c32` |
| `src/concepts/Concept32PlanMode.tsx` | New: the Plan mode tab |
| `src/App.tsx` | Tab |
| `src/styles.css` | Plan card, mode badge and row styles |
| `.gitignore` | `plan-lab/` |
| `Tab1-query().md` | Adds Concept 32 to the table |
| `Tab32-Plan-mode.md` | Explanation of the concept |
| `readme.md` | Same content as `Tab32-Plan-mode.md` |
| `Build-steps.md` | This file |
