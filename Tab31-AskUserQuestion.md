# AskUserQuestion

This file explains Concept 31 (**AskUserQuestion**) of the Claude Agent SDK Lab. When a job leaves a choice open, the
agent can stop in the middle of a run and **ask you** 1 to 4 multiple-choice questions with the built-in
`AskUserQuestion` tool. In the terminal, Claude Code shows them as a dialog. With the SDK, **nothing is shown**: the
questions reach **your** `canUseTool`, and your code must render them, wait for the person, and send the answers back.

**Goal:** build that dialog in your own UI. Know which answers you can send, what the model gets for each one, when the
tool is not there at all, and how the host (a hook, your code) can answer without a person.

| Concept | Topic | Routes |
|---|---|---|
| 31 | AskUserQuestion: the questions (`header`, `options`, `multiSelect`, `preview`), answering from `canUseTool` (`updatedInput.answers`, `annotations`), skip (`deny`) and cancel (`interrupt: true`), a host-side timeout, `toolConfig.askUserQuestion.previewFormat`, answering from a `PreToolUse` hook, a partial answer, when the tool is removed (no `canUseTool`, `permissionPrompts: 'none'`), `bypassPermissions` | `/api/c31/tools` (SSE), `/run` (SSE), `/answer`, `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/31-ask-user-question.ts` | **New**: the options, `ask()` (the pending question), `/answer` and its checks, the hook, the host check, the routes |
| `server/index.ts` | Mounts the router on `/api/c31` |
| `src/concepts/Concept31AskUserQuestion.tsx` | **New**: the tab (Parts A to D), the question card, the custom job form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | The question card, option previews, AskUserQuestion rows |
| `.gitignore` | Ignores `ask-lab/` |
| `Tab1-query().md` | Adds Concept 31 to the table |

---

## Step 1: What the model sends

`AskUserQuestion` is a normal built-in tool. Its input (`AskUserQuestionInput` in `sdk-tools.d.ts`):

```ts
{
  questions: [                          // 1 to 4
    {
      question: "Which poetic form would you prefer?",
      header: "Form",                   // a short chip, max 12 characters
      multiSelect: false,
      options: [                        // 2 to 4
        { label: "Haiku", description: "A three-line poem, 5-7-5" },
        { label: "Limerick", description: "Five humorous lines, AABBA", preview: "…" }, // preview is optional
      ],
    },
  ],
}
```

The tool description tells the model **not** to add an "Other" option: the UI adds one. So the lab's card adds
**Other** (a free text field) to every question.

## Step 2: The host answers from `canUseTool`

Claude Code sends the call to the host as a **permission request**. Your `canUseTool` is the dialog:

```ts
canUseTool: async (tool, input, { signal }) => {
  if (tool === "AskUserQuestion") {
    const answers = await showQuestionsAndWait(input.questions, signal);   // your UI
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  // … other tools
}
```

`answers` maps the **question text** to the answer: `{ "Which poetic form would you prefer?": "Limerick" }`. The
model gets this tool_result:

```
Your questions have been answered: "Which topic…?"="Love", "Which poetic form…?"="Limerick".
You can now continue with these answers in mind.
```

and your code gets `tool_use_result: { questions, answers }` on the `user` message, which is handy to store.

**The run simply waits.** `canUseTool` is an `async` function, so the lab keeps a pending promise per question
(`ask()` in the `ask` region), sends the questions to the browser as an SSE event, and resolves the promise when the
browser POSTs `/api/c31/answer`. Claude Code sets **no time limit**: in a probe, `canUseTool` waited 150 s and the run
went on normally. So the lab adds its **own** limit of 2 minutes (a `deny`, see Step 3). It also answers `deny` when the
run's `signal` is aborted, for example when the browser closes the stream.

## Step 3: Every kind of answer, and what the model gets

| You | `canUseTool` returns | The model's tool_result |
|---|---|---|
| Pick an option | `allow`, `answers: { q: "Limerick" }` | "Your questions have been answered: …" |
| Several options (`multiSelect`) | `allow`, `answers: { q: "Pepperoni, Mushrooms" }` | The same: several labels are **one string**, joined with `", "` |
| Your own text (Other) | `allow`, `answers: { q: "about my cat Miso" }` | "The user answered: … **Read the answers carefully — they may request clarification, changes, or that you not proceed** — and follow what they actually say." |
| A note | `allow`, `annotations: { q: { notes: "make it funny" } }` | The "The user answered" text, with `notes: make it funny` after the answer |
| Skip | `deny`, `message` | `is_error: true` with your message. The model goes on, and `result.permission_denials` lists the call |
| Cancel | `deny`, `message`, `interrupt: true` | "The user doesn't want to proceed… STOP what you are doing…". The result is `error_during_execution`, and **`query()` throws** afterwards, so catch it |
| Nobody answers | (Claude Code waits forever) | The lab's timeout sends `deny` "Choose sensible defaults yourself and say which ones you chose" |

Two details from the probes:

- **The wording changes** as soon as an answer is not exactly an option label (even `"green"` for the label
  `"Green"`) or has a note. Then the model is told to read the answers carefully, and it often asks back in plain text
  instead of doing the work. With "about my cat Miso" as the answer to both questions, Haiku replied that it needed a
  form before it could go on.
- **Write the `deny` message as an instruction.** "Choose sensible defaults yourself and say which ones you chose"
  made the model write "Since you skipped the questions, I'll choose… Topic: Nature, Form: Haiku".

## Step 4: When the model does NOT get the tool

The tool is only offered when there is a host that can answer. Button **0** runs 6 setups ("Reply ok"), with
`tools: ["Read", "AskUserQuestion"]`, and reads `system/init`:

| Setup | `AskUserQuestion` in `system/init` |
|---|---|
| `canUseTool` set | yes |
| no `canUseTool` | **no** |
| `canUseTool` + `permissionPrompts: 'none'` | **no** |
| a `PreToolUse` hook, no `canUseTool` | **no** (a hook alone does not bring it back) |
| `canUseTool` + `bypassPermissions` | yes, but the SDK warns: *canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call* |
| `canUseTool`, default tool set (no `tools` option) | yes (34 tools) |

Without the tool, the model asks **in plain text** ("I don't have access to an AskUserQuestion tool. However, I can
ask you directly here: 1. Nature 2. Technology…") and the run ends. With `bypassPermissions`, your dialog never sees
the question. Don't use that mode if you want the agent to ask.

In the default tool set, `AskUserQuestion` is **not deferred** (unlike the todo tools of Concept 30): the model called
it directly, with no `ToolSearch` first.

## Step 5: The model rarely asks on its own

Button **4** sends "Write a poem to poem.txt." The topic and the form are open, but the model just picks one. In the
probes, neither Haiku 4.5 nor Sonnet 5 asked, even with a system prompt append that said "When a request leaves a real
choice open, ask the user with AskUserQuestion". Sonnet 5 even wrote "The topic is open, so let me pick something".
**If you want questions, ask for them in the prompt**, as the other scenarios do ("Before you write anything, use the
AskUserQuestion tool ONCE with two questions…").

## Step 6: Previews, and `toolConfig`

An option can carry a `preview`: a mockup, a code snippet, a layout. What the model puts there is set by an option:

```ts
toolConfig: { askUserQuestion: { previewFormat: "html" } }   // default: "markdown"
```

- `"markdown"` (the CLI's default): Markdown or ASCII. In the probe, a README layout question had previews like
  `# Project Title\n\n## Features\n- …`. The card shows them in a `<pre>`.
- `"html"`: self-contained HTML fragments, meant for web hosts. Scenario 3 got
  `<h1 style="font-family: … font-weight: 300; …">Welcome</h1>` for each style. **This HTML is written by the model**,
  so the card renders it in `<iframe sandbox="" srcdoc=…>`: `sandbox=""` blocks scripts and gives the fragment its own origin, so
  it cannot reach the page. In the browser test, the page could not read into the preview's iframe either.

The card shows the preview of the option you hover or pick, next to the options.

## Step 7: The host can answer too

An answer does not have to come from a person.

**A `PreToolUse` hook** (scenario 5) can answer before `canUseTool` is asked. Then `canUseTool` is **not called** for
that call:

```ts
hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [async (input) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...input.tool_input, answers: pickFromSavedPreferences(input.tool_input.questions) },
  },
})] }] }
```

That fits tests, bots, or a "remember my choice" feature. The model gets the same "Your questions have been answered"
text. But a hook is not a replacement for `canUseTool`: without `canUseTool` the tool is not offered at all (Step 4).

**A partial answer is dangerous** (scenario 6). The host answers only the first of two questions. That is **not** an
error: the tool_result lists one answer and says "You can now continue". In the probe and in the route test, Haiku
**made up** the second answer ("Favorite Fruit: Pear"), wrote it to `favorites.txt`, and said "I've asked you two
questions and got your answers". So the lab's `/answer` route refuses any answer that misses a question, or names a
question that was not asked (HTTP 400), and the card's **Submit** stays disabled until every question has an answer.

## Step 8: The host check

After each run, the lab lists every question and the answer the host sent: `2/2 questions answered`, or, in red,
"no answer (host): anything the model says about it is made up". This is the same idea as Concept 30's check: trust
what your code saw, not what the model says.

## Step 9: Part D, the summary

| You want | Do |
|---|---|
| The agent to ask the user | Put `AskUserQuestion` in `tools`, set `canUseTool`, and **ask for questions in the prompt** |
| A UI for the questions | Render `questions` in `canUseTool`, wait, return `updatedInput.answers` (question text → label) |
| Several picks | Join the labels with `", "` |
| Free text or a note | Put the text in `answers`, or use `annotations[q].notes`, and expect the model to read it carefully (and maybe ask back) |
| Let the user decline | `deny` with an instruction ("choose defaults and say which") |
| Let the user stop everything | `deny` + `interrupt: true`, and catch the error `query()` throws |
| A time limit | Your own timer in `canUseTool`: Claude Code has none |
| Automatic answers | A `PreToolUse` hook with `updatedInput.answers` (and still a `canUseTool`) |
| Web previews | `toolConfig.askUserQuestion.previewFormat: "html"`, shown in a sandboxed iframe |

## How to try it

1. `npm run dev`, then open the **31. AskUserQuestion** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Which setups get AskUserQuestion?** and look at the red "no" rows.
3. Press **1 · Ask me, then write**. When the card appears, answer it and watch the `PermissionResult` row and the
   tool_result. Run it again and try **Skip**, **Cancel the job**, **Other** with your own text, and a note.
4. Press **2 · Multi-select**: pick two toppings and find `"A, B"` in `answers`.
5. Press **3 · Options with HTML previews** and hover over the options.
6. Press **4 · Not asked to ask**: no card, the model just writes.
7. Press **5 · A hook answers** (no card, `canUseTool` is not called) and **6 · A partial answer** (find the red row in
   the host check, and the made-up answer in the file).
8. Write your own job in the form, with either preview format.

Each scenario costs about $0.03 or less (Haiku 4.5). A run with a question waits for you for up to 2 minutes.
