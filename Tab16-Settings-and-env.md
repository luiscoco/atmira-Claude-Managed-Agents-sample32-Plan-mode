# Settings & env, step by step

This file explains how Concept 16 (**Settings & env**) was added to the Claude Agent SDK Lab.
`query()` does not call the API itself: it starts a **Claude Code process** and talks to it. Up to now every option
was a direct instruction to that process (`model`, `tools`, `maxTurns`…). This concept looks at the two things that
configure the process **around** those options: its environment variables and its settings.

There are three parts:

- **A. `env`.** What the process inherits, and what happens when you set `env` yourself.
- **B. The settings layers.** `settingSources`, `settings`, `managedSettings`, and `resolveSettings()` to see the
  merged result without starting Claude.
- **C. Which files the agent can reach.** `additionalDirectories`, and a `permissions.deny` rule loaded from a
  settings file.

| Concept | Topic | Routes |
|---|---|---|
| 16 | `env`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `settingSources`, `settings` (object or path), `managedSettings`, `resolveSettings()`, `additionalDirectories`, `permissions.deny` | `/api/c16/files`, `/env-run`, `/resolve`, `/layers-run`, `/access-run` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/16-settings-env.ts` | **New**: the five routes |
| `server/index.ts` | Mounts the router on `/api/c16` |
| `src/concepts/Concept16SettingsEnv.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `settings-lab/project/.claude/settings.json` | **New**: project settings (`env`, a `deny` rule) |
| `settings-lab/project/.claude/settings.local.json` | **New**: local settings (`env`) |
| `settings-lab/project/readme.txt`, `secret.txt` | **New**: two files inside the `cwd` |
| `settings-lab/shared/glossary.txt` | **New**: a file outside the `cwd` |
| `settings-lab/flag-settings.json` | **New**: a settings file passed by path |
| `Tab1-query().md` | Adds Concept 16 to the table of concepts |
| `Tab16-Settings-and-env.md` | This explanation |

No CSS was added.

---

## Step 1: Read the type definitions

The code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
type Options = {
  env?: { [envVar: string]: string | undefined };
  // "When set, this value REPLACES the subprocess environment entirely — it is not merged with process.env."
  settingSources?: SettingSource[];     // 'user' | 'project' | 'local'. "When omitted, all sources are loaded"
                                        // "Pass [] to disable filesystem settings (SDK isolation mode)."
  settings?: string | Settings;         // "loaded into the 'flag settings' layer, which has the highest priority
                                        //  among user-controlled settings". Equivalent to --settings.
  managedSettings?: Settings;           // policy tier, "filtered restrictive-only"
  additionalDirectories?: string[];     // "Additional directories Claude can access beyond the current working directory"
};

/** @alpha: "Resolve the effective Claude Code settings ... without spawning the Claude CLI." */
function resolveSettings(opts?: { cwd?; settingSources?; managedSettings?; serverManagedSettings? }): Promise<{
  effective: Settings;                                        // merged result
  provenance: Partial<Record<keyof Settings, ProvenanceEntry>>; // who set each TOP-LEVEL key
  sources: Array<{ source; settings; path?; policyOrigin? }>;   // per source, low → high precedence
}>;
```

Note what `resolveSettings()` does **not** take: `settings`. The flag layer only exists when `query()` runs.

## Step 2: Try it before writing the lab

Scratch scripts called `query()` and `resolveSettings()` directly, with a folder `settings-lab/project` that has
both a `.claude/settings.json` and a `.claude/settings.local.json`. Bash could only run `printenv` and `echo`, so the
model printed the real environment of the Claude Code process.

| Test | Result |
|---|---|
| `env: { LAB_TEAM }` only, server has `ANTHROPIC_API_KEY` | Works, but `apiKeySource` becomes `"none"`: the key is gone and the run **falls back to the login** |
| `env: { ...process.env, LAB_TEAM }` | `LAB_TEAM` is set and the key is kept |
| `env: { ...process.env, ANTHROPIC_API_KEY: undefined }` | Removes just that variable |
| Project `env.LAB_LAYER=project` + `Options.env.LAB_LAYER=options.env` | Bash sees **`project`**: `settings.env` wins over `Options.env` |
| project + local + `settings` (flag) | Bash sees the flag value. The `env` objects are **merged key by key** |
| `deny` rules in two layers | The arrays are **concatenated**, not replaced |
| `managedSettings: { model, permissions.deny }` | `model` is **dropped silently**; the `deny` rule is added |
| `settingSources: ["user"]` with no `model` option | The run used the model from `~/.claude/settings.json` (Opus). With `model` set, `Options.model` wins |
| `settingSources` omitted | All three files, **plus the plugins** enabled in your user settings |
| Read a file outside `cwd` in `dontAsk` mode | Denied. With `additionalDirectories: [thatFolder]` it is read |
| `deny: ["Read(./secret.txt)"]` in project settings | Read is denied; the model then tries `cat` through Bash, and that is denied too |

> **Running inside Claude Code.** The first runs showed `apiKeySource: "none"` everywhere, because the scripts were
> started from a Claude Code terminal, and its `CLAUDECODE` / `CLAUDE_CODE_*` variables were inherited (see
> Tab1). That is itself a Part A lesson: **the process inherits everything in your environment**. The tests were
> repeated with those variables removed.

---

# Part A: `env`

## Step 3: Four ways to pass the environment

`/env-run` runs the same prompt four times, in parallel. Only `env` changes:

```ts
if (variant === "spread")    options.env = { ...process.env, LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
if (variant === "only")      options.env = { LAB_TEAM: team, CLAUDE_AGENT_SDK_CLIENT_APP: app };
if (variant === "removeKey") options.env = { ...process.env, ANTHROPIC_API_KEY: undefined, LAB_TEAM: team };
```

The model runs `printenv` for `LAB_TEAM` and `CLAUDE_AGENT_SDK_CLIENT_APP`, and says whether `ANTHROPIC_API_KEY` is
`set` or `unset` (the key itself is never printed). The card shows `apiKeySource` from the `system/init` message.

| Variant | `LAB_TEAM` | key | `apiKeySource` |
|---|---|---|---|
| omitted | empty | set | `ANTHROPIC_API_KEY` |
| spread + yours | `sdd-team` | set | `ANTHROPIC_API_KEY` |
| yours only | `sdd-team` | **unset** | **`none`** (login) |
| remove one | `sdd-team` | unset | `none` |

*Yours only* is the trap: it looks like it works, but the bill moved from the API key to your subscription (or the
run fails on a machine with no login). Always spread `process.env` unless you want a clean environment on purpose.

`CLAUDE_AGENT_SDK_CLIENT_APP` is the variable the SDK documents for naming your app in the `User-Agent` header.

The options echo does not print the whole environment: the server shows `"...process.env": "73 inherited variables"`
and only the variables that differ. Values of keys that look secret are masked.

---

# Part B: The settings layers

## Step 4: The files

```text
settings-lab/
  project/                      <- cwd of every run
    .claude/settings.json        { env: { LAB_LAYER: "project", LAB_PROJECT_NOTE }, permissions: { deny: ["Read(./secret.txt)"] } }
    .claude/settings.local.json  { env: { LAB_LAYER: "local", LAB_LOCAL_NOTE } }
    readme.txt, secret.txt
  shared/glossary.txt            <- outside cwd (Part C)
  flag-settings.json             { env: { LAB_LAYER: "flag (from settings-lab/flag-settings.json)" } }
```

The precedence, low → high: **user** → **project** → **local** → **flag** (`settings`) → **managed** (policy).

## Step 5: `resolveSettings()` and a real run

The form builds one body. **Resolve** sends it to `/resolve`, which calls:

```ts
const resolved = await resolveSettings({ cwd: options.cwd, settingSources: options.settingSources, managedSettings: options.managedSettings });
```

It takes about 10 ms and makes no API call. The tab shows `sources` (which file each layer came from, and its keys),
`provenance` and `effective`. **Run** sends the same body to `/layers-run`, which builds the same options for
`query()`, and the model prints `LAB_LAYER`, `LAB_PROJECT_NOTE` and `LAB_LOCAL_NOTE`:

| Preset | `LAB_LAYER` | Why |
|---|---|---|
| No files (`[]`) | empty | SDK isolation mode: no settings at all |
| project | `project` | |
| project + local | `local` | local is above project; `LAB_PROJECT_NOTE` survives (key-by-key merge) |
| + settings (inline) | `flag (inline object)` | the flag layer is above the files |
| settings: path | `flag (from …flag-settings.json)` | `settings` also takes a path to a JSON file |
| Options.env vs project | **`project`** | `settings.env` is applied over the process environment |
| managedSettings | `project` | managed `model` is dropped; `deny` gains `Bash(rm:*)` |

Two things `resolveSettings()` shows that a run cannot:

1. **Provenance is per top-level key.** With project + local, `env` is credited to `local`, although
   `LAB_PROJECT_NOTE` came from project. `sources` has the per-layer detail.
2. **`managedSettings` keeps only restrictive keys.** Your `model` is not in `effective`, and nothing warns you.

If you tick **user** (or omit `settingSources`), the tab shows your real `~/.claude/settings.json`, with secret-looking
values masked. The run stays on Haiku, because `Options.model` wins over `model` in any settings file, but the
`system/init` message now lists your **plugins**. `settingSources: []` is what keeps a server's runs independent of
whoever's machine it is on.

---

# Part C: Which files the agent can reach

## Step 6: `additionalDirectories` and a `deny` rule

`/access-run` asks the model to read one of three files (chosen by key, never a path from the browser), with two
switches: `settingSources: ["project"]` and `additionalDirectories: [settings-lab/shared]`. The permission mode is
`dontAsk`, so anything not allowed is refused instead of asked.

| Column | File | Result |
|---|---|---|
| 1 | `shared/glossary.txt`, neither switch | Read denied (outside `cwd`), then Bash `cat` denied: 2 permission denials |
| 2 | `shared/glossary.txt`, `additionalDirectories` | Read works |
| 3 | `project/secret.txt`, neither switch | Read works: inside `cwd` and no rule loaded |
| 4 | `project/secret.txt`, `settingSources: ["project"]` | *"File is in a directory that is denied by your permission settings."* |

Column 3 against column 4 is the point: a `deny` rule in a settings file only protects anything when
`settingSources` loads that file. If your server depends on a rule, pass it in code (`settings` or
`disallowedTools`), not only in a file.

---

## What to take away

1. **`env` replaces, it does not merge.** Write `{ ...process.env, ... }`. Set a variable to `undefined` to remove it.
2. **Check `apiKeySource` in `system/init`.** It tells you which credential really paid for the run.
3. **`settingSources` omitted means *all* files**, including the user's plugins and model. Use `[]` on a server and
   add only what you need.
4. **Order: user → project → local → flag (`settings`) → managed.** Objects merge key by key, arrays concatenate.
5. **`settings.env` beats `Options.env`; `Options.model` beats `settings.model`.** Test the ones you rely on.
6. **`resolveSettings()` is free and fast** (`@alpha`). Use it to explain a configuration before paying for a run.
   It does not include `settings`, and its provenance is per top-level key.
7. **`managedSettings` is for restrictions only.** Other keys are dropped without a warning.
8. **`additionalDirectories` opens folders outside `cwd`; a `deny` rule only works if its file is loaded.**

## Things to try in Concept 16

1. In Part A, comment out the key in `.env`, restart, and run again. What does the warning card say?
2. In Part B, pick *project + local*, then edit `settings.local.json` to remove `LAB_LAYER`. Resolve again: who wins now?
3. Add `"model": "claude-sonnet-5"` to the inline `settings`. Does the run change model? Why not?
4. Put `{ "permissions": { "allow": ["Bash(ls:*)"] } }` in `managedSettings`. Is it in `effective`?
5. In Part C, set all four columns to `readme.txt` and try every switch. Is anything denied?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**16. Settings & env**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.
Start the server from a normal terminal, not from inside Claude Code, or Part A shows `apiKeySource: "none"` in every
column. Costs on Haiku: $0.003 to $0.014 per column in Part A, about $0.004 per Part B run, $0.004 to $0.012 per
Part C column. **Resolve** is free.

The routes can also be called without the UI:

```powershell
'{"omit":false,"sources":["project","local"],"flag":"file","flagJson":"","managedJson":"","optionsEnvLayer":""}' | Set-Content body.json
curl.exe -X POST http://localhost:3001/api/c16/resolve -H "Content-Type: application/json" -d "@body.json"
curl.exe -N -X POST http://localhost:3001/api/c16/layers-run -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```
