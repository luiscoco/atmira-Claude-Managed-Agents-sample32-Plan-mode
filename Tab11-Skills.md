# Concept 11: Skills, step by step

This file explains how Concept 11 (**Skills**) was added to the Claude Agent SDK Lab.
It starts from zero (what a skill *is*) and ends with the options that decide which skills an agent gets.
There are three parts:

- **A. Fundamentals.** A skill is a folder with a `SKILL.md`. It is loaded in three levels, as late as possible.
- **B. Loading skills into the agent.** `settingSources`, `plugins`, `skills` and `disableBundledSkills` decide
  which skills exist and which ones the model is told about.
- **C. Advanced loading.** Preloading a skill into a subagent, and reloading skills in a live session.

| Concept | Topic | Routes |
|---|---|---|
| 11 | Skills: `SKILL.md`, progressive disclosure, `skills`, `plugins`, `AgentDefinition.skills`, `reloadSkills()` | `/api/c11/skills`, `/invoke`, `/load`, `/subagent`, `/reload` |

**Files touched:**

| File | Change |
|---|---|
| `skills-project/.claude/skills/*/SKILL.md` | **New**: three project skills (`task-report`, `release-notes`, `deploy-checklist`) |
| `skills-project/.claude/skills/release-notes/template.md` | **New**: a level-3 file the skill reads on demand |
| `skills-project/data/tasks.json` | **New**: the data `task-report` reads |
| `skills-plugin/.claude-plugin/plugin.json` | **New**: a local plugin called `atmira-tools` |
| `skills-plugin/skills/commit-message/SKILL.md` | **New**: the skill that plugin ships |
| `server/concepts/11-skills.ts` | **New**: the five routes |
| `server/index.ts` | Mounts the router on `/api/c11` |
| `src/concepts/Concept11Skills.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `Tab1-query().md` | Adds Concept 11 to the table of concepts |
| `Tab11-Skills.md` | This explanation |

---

## Step 1: Read the type definitions

As in the other concepts, the code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
// Options
settingSources?: SettingSource[];          // 'user' | 'project' | 'local'. Where skills on disk are found.
plugins?: SdkPluginConfig[];               // { type: 'local'; path: string }. "Plugins provide custom commands, agents, skills, and hooks."
skills?: string[] | 'all';                 // "This is a context filter, not a sandbox."
settings?: string | Settings;              // Settings.disableBundledSkills?: boolean

// Subagents
type AgentDefinition = { ...; skills?: string[] };   // "Array of skill names to preload into the agent context"

// The object returned by query()
supportedCommands(): Promise<SlashCommand[]>;          // { name, description, argumentHint, builtin? }
reloadSkills(): Promise<SDKControlReloadSkillsResponse>; // { skills: SlashCommand[] }

// system/init message
skills: string[];
plugins: { name: string; path: string; source: string; version?: string }[];
```

Three things in these types shape the whole tab:

1. There is **no "add skill" function**. Skills are *files*. The SDK only decides *where to look* (`settingSources`,
   `plugins`) and *what the model may see* (`skills`).
2. The `skills` doc says it is **a context filter, not a sandbox**. It hides skills from the model, but the files
   stay readable. Never put secrets in a skill.
3. A skill is also a **slash command**: `supportedCommands()` lists skills with the same shape as `/help`.

---

# Part A: fundamentals

## Step 2: What a skill is

A skill is **a folder**. The folder name is the skill's name, and the only required file is `SKILL.md`:

```
skills-project/                     <- the agent's cwd
├── data/tasks.json
└── .claude/skills/
    ├── task-report/
    │   └── SKILL.md                <- reads data/tasks.json, prints a fixed report
    ├── release-notes/
    │   ├── SKILL.md                <- "Read template.md in this skill's folder"
    │   └── template.md             <- level 3: only read when the skill runs
    └── deploy-checklist/
        └── SKILL.md                <- disable-model-invocation: true
```

`SKILL.md` has two parts, YAML frontmatter and a markdown body:

```markdown
---
name: task-report
description: Builds a status report of the team's tasks from data/tasks.json. Use when the user asks
  how the tasks are going, what is pending, or for a task or progress report.
---

# Task report

1. Read `data/tasks.json` (relative to the working directory).
2. Answer with this exact layout: ...
```

The frontmatter keys used here:

| Key | What it does |
|---|---|
| `name` | The skill's id. It is also the slash command: `/task-report`. |
| `description` | **The most important line.** The model only sees this until it decides to use the skill, so it must say *what* the skill does and *when* to use it. |
| `argument-hint` | Shown next to the slash command, e.g. `/deploy-checklist <environment>`. |
| `disable-model-invocation` | `true` hides the skill from the model. Only a user typing `/name` can run it. |

Inside the body, `$ARGUMENTS` is replaced with whatever the user typed after `/name`.

Each skill in this tab ends with a **recognisable output** (📋, 📦, 🚀, a `Refs: ATM-` line). That way you can
tell from the answer alone whether the skill was really used.

## Step 3: Progressive disclosure, the idea that makes skills cheap

A skill is loaded in three levels, each one only when needed:

| Level | What | When it enters the context | Cost |
|---|---|---|---|
| 1 | `name` + `description` of every skill | Always, in the skill listing | A few dozen tokens per skill |
| 2 | The `SKILL.md` body | When the model calls the `Skill` tool, or the user types `/name` | The body's size, once |
| 3 | Other files in the folder | When the body tells the model to `Read` them | Only what is read |

So you can install fifty skills and pay only for fifty descriptions until one of them is actually needed.
Compare this with CLAUDE.md (Concept 9), which is loaded in full on every run.

## Step 4: Watching the levels in the message stream

`/invoke` runs a prompt with all four skills loaded. The tab turns the raw stream into a list of "what got loaded".
This is the stream for *"How are the team tasks going?"*:

```text
system/init            skills: [deploy-checklist, release-notes, task-report, atmira-tools:commit-message, ...]
assistant  tool_use    Skill { "skill": "task-report" }                         <- level 2 requested
user       tool_result "Launching skill: task-report"
user       isSynthetic "Base directory for this skill: ...\task-report\n\n# Task report\n1. Read ..."  <- level 2 body
assistant  tool_use    Read { "file_path": "...\skills-project\data\tasks.json" } <- the skill's instructions at work
assistant  text        📋 Task report: 3/5 done (60%) ...
```

Two details are worth knowing:

1. **The `Skill` tool doesn't return the instructions.** Its `tool_result` only says "Launching skill".
   The body arrives in a separate user message marked `isSynthetic: true`, starting with the skill's base directory.
   That base directory is how the model finds the level-3 files: in the release-notes run, the next call is
   `Read ...\.claude\skills\release-notes\template.md`.
2. **Skill arguments.** For the release notes, the model called
   `Skill { "skill": "release-notes", "args": "added dark mode, fixed CSV export encoding, removed the old v1 API" }`.

The server code for this is the shortest route in the file:

```ts
const FULL: Options = {
  ...BASE,                                    // model, cwd: skills-project, tools: ["Skill", "Read"], allowedTools: ["Read"]
  settingSources: ["project"],                // scan <cwd>/.claude/skills/
  settings: { disableBundledSkills: true },   // hide the skills that ship with Claude Code (Part B)
  plugins: [{ type: "local", path: PLUGIN_DIR }],
  skills: "all",
};

concept11.post("/invoke", (req, res) => {
  const { abort, send, pipe } = openSse(req, res);
  send("options", FULL);
  pipe(query({ prompt: req.body.prompt, options: { ...FULL, abortController: abort } }));
});
```

`"Skill"` must be in `tools`. It is the built-in tool that loads a skill. Without it, the model sees no listing and
can't invoke anything.

## Step 5: Test the six scenarios

All runs used Haiku 4.5.

| Scenario | Prompt | What happened | Prompt tokens |
|---|---|---|---|
| Model picks a skill | "How are the team tasks going?" | `Skill(task-report)` → body injected → `Read data/tasks.json` → 📋 report | ≈ 8,700 |
| Level 3: extra file | "Write release notes: ..." | `Skill(release-notes, args)` → body → `Read template.md` → 📦 notes | ≈ 8,800 |
| Plugin skill | "Commit message for: ..." | `Skill(atmira-tools:commit-message)` → `fix(reports): ... Refs: ATM-000` | ≈ 5,600 |
| User types /name | "/deploy-checklist staging" | **No Skill call.** The CLI expanded the command before the model saw it → 🚀 checklist for *staging* | ≈ 2,700 |
| Hidden from the model | "Use the deploy-checklist skill for staging." | "it's not listed in the currently available skills" | ≈ 2,550 |
| No skill matches | "What is the capital of France? One word." | "Paris". Only level 1 was paid for. | ≈ 2,550 |

(The prompt tokens are summed over every turn, so a run that calls the Skill tool and then Read shows up as
three turns' worth of tokens.)

---

# Part B: loading skills into the agent

## Step 6: Where skills come from

| Source | Folder scanned | Turned on by | Skill name |
|---|---|---|---|
| Project | `<cwd>/.claude/skills/<name>/SKILL.md` | `settingSources` includes `"project"` | `name` |
| User | `~/.claude/skills/<name>/SKILL.md` | `settingSources` includes `"user"` | `name` |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | `plugins: [{ type: "local", path }]` | `plugin:name` |
| Bundled | Shipped inside Claude Code | **Always on**, unless `disableBundledSkills` | `name` |

A plugin is just a folder with a manifest:

```
skills-plugin/
├── .claude-plugin/plugin.json      { "name": "atmira-tools", "version": "1.0.0", ... }
└── skills/commit-message/SKILL.md
```

Plugins are how you **share** skills between projects: the same folder can be loaded by any agent,
and its skills are namespaced (`atmira-tools:commit-message`), so they don't clash with a project's own skills.

This tab never uses `"user"`. It would load the personal skills of whoever runs the server, which is the same
reason every other tab uses `settingSources: []` (see [Tab3-Built-in-tools.md](Tab3-Built-in-tools.md)).

## Step 7: The five variants

`/load` runs the same prompt, *"List every skill you can use, one per line, name only"*, with five option sets:

```ts
const variants: Record<Variant, Options> = {
  isolated:  { ...BASE, settingSources: [] },
  project:   { ...BASE, settingSources: ["project"] },
  noBundled: { ...BASE, settingSources: ["project"], settings: { disableBundledSkills: true } },
  filtered:  { ...BASE, settingSources: ["project"], settings: { disableBundledSkills: true }, skills: ["task-report"] },
  plugin:    FULL,   // + plugins + skills: "all"
};
```

Once `system/init` arrives, the route also calls `q.supportedCommands()` and keeps the non-built-in entries, so the
tab can compare **what was discovered** with **what the model says it sees**:

```ts
for await (const msg of q) {
  yield msg;
  if (msg.type === "system" && msg.subtype === "init") {
    const commands = await q.supportedCommands();
    send("commands", commands.filter((c) => !c.builtin));
  }
}
```

## Step 8: Test the variants

| Variant | `init.skills` | Discovered (`supportedCommands`) | Model sees | Prompt tokens |
|---|---|---|---|---|
| isolated | 21 | (none) | 16 bundled skills (dataviz, code-review, simplify, loop...) | 4,160 |
| project | 24 | deploy-checklist, release-notes, task-report | release-notes, task-report **+ the bundled ones** | 4,245 |
| project, no bundled | 5 | deploy-checklist, release-notes, task-report | release-notes, task-report | **2,518** |
| filtered | 5 | deploy-checklist, release-notes, task-report | **task-report** | 2,476 |
| + plugin | 6 | ... + atmira-tools:commit-message | release-notes, task-report, atmira-tools:commit-message | 2,555 |

## What to take away from Part B

1. **`settingSources: []` does not mean "no skills".** Claude Code ships about 20 bundled skills, and they are
   loaded even in isolation mode. They cost about 1,700 prompt tokens on *every* request. Turn them off with
   `settings: { disableBundledSkills: true }` (two small ones, `design` and `doctor`, still stay in `init.skills`).
2. **Omitting `skills` is not "skills off".** As the type doc says, it means "no SDK auto-configuration". The
   discovered skills are still listed to the model, as the *project* row shows.
3. **`skills` filters the model's view, not discovery.** In the *filtered* row, `init.skills` and
   `supportedCommands()` still list all three project skills, but the model only knows about `task-report`.
   Asked to use `release-notes`, it answered "I don't see a release-notes skill". Since the files are still on disk,
   an agent with `Read` could still open them, which is why it is a filter and not a sandbox.
4. **Three lists, three meanings.**
   - `init.skills`: everything discovered, bundled ones included.
   - `supportedCommands()`: what a *user* can type as `/name`. It includes `disable-model-invocation` skills.
   - The model's listing: what the *model* can invoke. It excludes `deploy-checklist` and anything filtered out.
5. **Plugin skills are namespaced.** They appear as `atmira-tools:commit-message`, and the plugin shows up in
   `init.plugins` with `source: "atmira-tools@inline"` and the version from `plugin.json`.

---

# Part C: advanced loading

## Step 9: Preloading a skill into a subagent

`AgentDefinition.skills` (Concept 8's `agents` option) puts a skill's body into a subagent's context **from the start**:

```ts
agents: {
  reporter: {
    description: "Reports on the team's tasks. Use for any question about task status.",
    prompt: "You report on team tasks. Follow your preloaded skill exactly.",
    tools: ["Read"],
    skills: ["task-report"],   // preloaded: no Skill call needed
    model: "haiku",
  },
},
skills: [],                    // the MAIN agent sees no skills, so it has to delegate
tools: ["Agent", "Read"],
```

The result, *"How are the team tasks going? Ask the reporter agent..."*:

```text
main      Agent { subagent_type: "reporter", ... }
subagent  Read  skills-project/data/tasks.json      <- no Skill call: it already had the instructions
main      "Here's the reporter agent's answer verbatim: 📋 Task report: 3/5 done (60%) ..."
```

**When to preload instead of letting the model pick:** when a subagent exists *for* one job. It saves a turn
(no `Skill` round-trip), and the subagent can't forget to load the skill.

This route reuses Concept 8's **foreground hook** (`PreToolUse` → `updatedInput: { run_in_background: false }`).
In this SDK version subagents run in the background by default. Without the hook, the main agent answers
"the reporter is running in the background" and a second `result` follows later. `AgentDefinition.background: false`
was also tried and did **not** change this, because the model's `run_in_background` input decides.

## Step 10: Reloading skills in a live session

Skill folders are scanned when the session starts. A skill written afterwards (by your app, a hook, or the agent
itself) is invisible until you call `q.reloadSkills()`. That is a **control request**, so, as with `interrupt()` in
Concept 10, it needs streaming input mode (a prompt that is an `AsyncIterable`).

`/reload` does this in four steps and sends each one to the tab:

```ts
const q = query({ prompt: input.stream, options: FULL });
send("control", { step: "1. session open, q.supportedCommands()", skills: names(await q.supportedCommands()) });

await writeFile(".claude/skills/atmira-greeting/SKILL.md", LIVE_SKILL_MD);
send("control", { step: "2. wrote ..., q.supportedCommands() again", skills: names(await q.supportedCommands()) });

const reloaded = await q.reloadSkills();
send("control", { step: "3. await q.reloadSkills()", skills: reloaded.skills.map((s) => s.name) });

input.push(prompt);  // 4. now ask
```

Result with the prompt *"Hello!"*:

| Step | Skills |
|---|---|
| 1. session open | deploy-checklist, release-notes, task-report, atmira-tools:commit-message |
| 2. file written | **same list**: the new skill is not seen yet |
| 3. `reloadSkills()` | **atmira-greeting**, release-notes, task-report, atmira-tools:commit-message |
| 4. "Hello!" | `Skill(atmira-greeting)` → "👋 Kaixo! Welcome to Atmira Lab (skill written while the session was running)" |

Note that `reloadSkills()` returns the **model-invocable** list, so `deploy-checklist` (user-only) is missing from
step 3. The route deletes the skill folder when the run ends, so every run starts clean.

---

## What to take away

1. **A skill is a folder, not code.** Adding a capability means writing markdown: a `description` that says *when*,
   and a body that says *how*. The SDK code only chooses where to look.
2. **Progressive disclosure is the point.** Descriptions are always paid for, bodies only when used, extra files only
   when read. Many skills cost little until one is needed.
3. **Loading has two layers.** Discovery (`settingSources`, `plugins`, bundled skills) decides what *exists*.
   `skills` decides what the *model sees*. Always set both explicitly in a production agent.
4. **Watch the bundled skills.** They are on by default and cost about 1,700 tokens per request.
   `disableBundledSkills` is the switch.
5. **Choose the invocation style on purpose.** Let the model pick (a good `description`), make the skill user-only
   (`disable-model-invocation`), or preload it into a subagent (`AgentDefinition.skills`).
6. **Skills are not a security boundary.** `skills` hides, it doesn't protect, so keep secrets out of skill folders.

## Things to try in Concept 11

1. Edit the `description` of `task-report` so it no longer says "Use when...", then ask "What's pending?".
   Does the model still find the skill? No restart is needed.
2. Remove `disable-model-invocation: true` from `deploy-checklist` and re-run the *Hidden from the model* scenario.
3. Run Part B, then change the prompt to "How are the team tasks going?" and run it again. Compare how *isolated*
   answers (no skill) with *filtered* (skill used).
4. Add a second skill to `skills-plugin/skills/` and run the *+ plugin* variant. It appears as `atmira-tools:<name>`.
5. Change `LIVE_SKILL_MD` in the server and run the reload demo with a prompt that matches your new description.

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**11. Skills**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

To call the endpoints without the UI:

```powershell
'{"prompt":"How are the team tasks going?"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c11/invoke -H "Content-Type: application/json" -d "@body.json"

'{"prompt":"List every skill you can use, one per line, name only.","variant":"filtered"}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c11/load -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

`variant` is one of `isolated`, `project`, `noBundled`, `filtered`, `plugin`.
