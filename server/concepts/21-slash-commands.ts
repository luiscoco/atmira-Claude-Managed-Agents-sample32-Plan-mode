/**
 * CONCEPT 21 — Slash commands: what happens when a prompt starts with "/"
 *
 * A prompt like "/greet Ana" is not sent to the model as written. The CLI looks up "greet" and runs it BEFORE any
 * model call. There are three kinds of command:
 *
 *   custom     .claude/commands/<name>.md (settingSources: ["project"])   -> expanded into the prompt, then the model runs
 *   built-in   /context, /cost, /usage, /model, /compact, /clear ...     -> run locally, 0 turns, result.local_command
 *   unknown    /nope                                                     -> sent to the model as plain text
 *
 * A command file is markdown with frontmatter:
 *   description, argument-hint     -> the command list (supportedCommands(), what a user sees)
 *   arguments: [id, priority]      -> named placeholders $id, $priority
 *   $ARGUMENTS, $0 $1 ($ARGUMENTS[0])  -> everything typed after the name / one argument, 0-BASED, "quoted words" = 1
 *   @path                          -> the file's content is put in the prompt (no Read call)
 *   !`cmd`                         -> a shell command run during expansion; needs "Bash" in `tools`. A read-only
 *                                     command (ls) runs as is; any other needs `allowed-tools: Bash(cmd:*)`.
 *                                     settings.disableSkillShellExecution turns it off.
 *   model                          -> this command runs on another model
 *   disable-model-invocation: true -> only a user can run it; the model does not see it
 *   subfolder frontend/component.md -> "/frontend:component"
 *
 * Also shown: the UserPromptExpansion hook (fires with command_name / command_args, can block), the Skill tool (how
 * the MODEL runs a command; the user's "/name" doesn't need it), and verbatimPrompts: true, which sends text the user
 * did not type as written, with no slash-command dispatch.
 *
 * Routes: GET /commands, POST /run (SSE), POST /session (SSE).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { query, type HookCallback, type HookEvent, type HookCallbackMatcher, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept21 = Router();

const PROJECT = path.resolve("commands-project");
const COMMANDS = path.join(PROJECT, ".claude", "commands");
const MAX_RUN_MS = 120_000;
const MAX_PROMPT = 2000;

// The same base for every run. No "Skill" tool: a user's /name works without it (see the "switches" below).
const BASE: Options = {
  model: "claude-haiku-4-5-20251001",
  thinking: { type: "disabled" },
  cwd: PROJECT,
  settingSources: ["project"], // discovers <cwd>/.claude/commands/
  settings: { disableBundledSkills: true }, // keeps the command list short (Concept 11)
  tools: ["Read"],
  allowedTools: ["Read"],
  strictMcpConfig: true,
  persistSession: false,
  maxTurns: 6,
};

// ---------------------------------------------------------------------------------------------
// GET /commands: the command files on disk
// ---------------------------------------------------------------------------------------------

/** A tiny frontmatter reader: `key: value` lines between the two `---`. Enough for these files. */
function parse(text: string) {
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text.trim() };
  const frontmatter = Object.fromEntries(
    match[1].split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
  );
  return { frontmatter, body: match[2].trim() };
}

/** Every .md under .claude/commands/. A file in a subfolder is named "<folder>:<file>". */
function readCommands(dir = COMMANDS, prefix = ""): { name: string; file: string; frontmatter: Record<string, string>; body: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.isDirectory()) return readCommands(path.join(dir, d.name), `${prefix}${d.name}:`);
    if (!d.name.endsWith(".md")) return [];
    const file = path.join(dir, d.name);
    return [{ name: prefix + d.name.slice(0, -3), file: path.relative(PROJECT, file).replaceAll("\\", "/"), ...parse(readFileSync(file, "utf8")) }];
  });
}

concept21.get("/commands", (_req, res) => {
  res.json(readCommands());
});

// ---------------------------------------------------------------------------------------------
// Switches and hooks the browser can turn on (names only, checked against these lists)
// ---------------------------------------------------------------------------------------------

const SWITCHES: Record<string, (o: Options) => Options> = {
  // The Skill tool is how the MODEL runs a command. The user's "/name" does not need it.
  skillTool: (o) => ({ ...o, tools: [...(o.tools as string[]), "Skill"] }),
  // !`cmd` lines run through Bash. It is in `tools` but NOT in allowedTools: the command's allowed-tools grants it.
  bash: (o) => ({ ...o, tools: [...(o.tools as string[]), "Bash"] }),
  // !`cmd` lines are replaced with a placeholder instead of being run.
  noShell: (o) => ({ ...o, settings: { ...(o.settings as object), disableSkillShellExecution: true } }),
  // The prompt is delivered as written: no slash-command dispatch, no @path expansion.
  verbatim: (o) => ({ ...o, verbatimPrompts: true }),
  // No filesystem settings: .claude/commands/ is not scanned.
  noProject: (o) => ({ ...o, settingSources: [] }),
};

const HOOKS: Record<string, { event: HookEvent; fn: HookCallback }> = {
  // UserPromptExpansion fires only for a slash command, before UserPromptSubmit. Blocking it: 0 turns, $0.
  "freeze-release": {
    event: "UserPromptExpansion",
    fn: async (input) => {
      if (input.hook_event_name !== "UserPromptExpansion" || input.command_name !== "release") return {};
      return { decision: "block", reason: "Freeze-release hook: no releases this week." };
    },
  },
};

/** Parses the browser's lists: only known names, never code or paths. */
const pick = (list: unknown, known: Record<string, unknown>) =>
  (Array.isArray(list) ? list : []).filter((x): x is string => typeof x === "string" && Object.hasOwn(known, x));

/**
 * Hooks for a run: an observer on the two prompt events (so every run shows whether a command was expanded), plus
 * the picked hooks. Each call is streamed as a `hook` SSE event.
 */
function buildHooks(picked: string[], send: (event: string, data: unknown) => void, startedAt: number) {
  const traced =
    (name: string, fn: HookCallback): HookCallback =>
    async (input, id, opts) => {
      const output = await fn(input, id, opts);
      const { session_id, transcript_path, cwd, ...rest } = input as unknown as Record<string, unknown>;
      send("hook", { name, event: input.hook_event_name, input: rest, output, at: Date.now() - startedAt });
      return output;
    };
  const observer: HookCallback = async () => ({});
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const event of ["UserPromptExpansion", "UserPromptSubmit"] as const) hooks[event] = [{ hooks: [traced("observer", observer)] }];
  for (const name of picked) (hooks[HOOKS[name].event] ??= []).push({ hooks: [traced(name, HOOKS[name].fn)] });
  return hooks;
}

/** What to show of the options (the hooks are functions, JSON would drop them). */
const describe = (options: Options, picked: string[]) => ({
  ...options,
  hooks: {
    UserPromptExpansion: ["[Function observer]", ...picked.filter((h) => HOOKS[h].event === "UserPromptExpansion").map((h) => `[Function ${h}]`)],
    UserPromptSubmit: ["[Function observer]"],
  },
});

/** Aborts a run that takes too long, so a tab never hangs. */
function guard(res: import("express").Response, abort: AbortController, send: (e: string, d: unknown) => void) {
  const timer = setTimeout(() => {
    send("error", { message: `Stopped by the server after ${MAX_RUN_MS / 1000} s.` });
    abort.abort();
  }, MAX_RUN_MS);
  res.on("close", () => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------
// POST /run: one prompt
// ---------------------------------------------------------------------------------------------

concept21.post("/run", (req, res) => {
  const body = req.body as { prompt?: unknown; switches?: unknown; hooks?: unknown };
  const { abort, send, pipe } = openSse(req, res);
  const startedAt = Date.now();
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > MAX_PROMPT) {
    send("error", { message: `The prompt must be 1 to ${MAX_PROMPT} characters.` });
    send("done", {});
    return res.end();
  }
  const prompt = body.prompt.trim();
  const switches = pick(body.switches, SWITCHES);
  const picked = pick(body.hooks, HOOKS);

  let options = BASE;
  for (const s of switches) options = SWITCHES[s](options);
  options = { ...options, hooks: buildHooks(picked, send, startedAt) };
  send("options", describe(options, picked));

  const label = `[c21] ${JSON.stringify(prompt.slice(0, 40))} switches=${switches.join(",") || "-"} hooks=${picked.join(",") || "-"}`;
  console.log(`${label} started`);
  guard(res, abort, send);

  const q = query({ prompt, options: { ...options, abortController: abort } });
  async function* run() {
    let listed = false;
    for await (const msg of q) {
      yield msg;
      // Once the session is up: the full command list, split into the ones defined on disk and Claude Code's own.
      if (msg.type === "system" && msg.subtype === "init" && !listed) {
        listed = true;
        const all = await q.supportedCommands();
        send("commands", { custom: all.filter((c) => !c.builtin), builtin: all.filter((c) => c.builtin).map((c) => c.name) });
      }
      // local_command is only on result/success: the built-in that ran, or "custom" when a command failed to expand.
      if (msg.type === "result") console.log(`${label} result/${msg.subtype} turns=${msg.num_turns} local_command=${(msg.subtype === "success" && msg.local_command) || "-"}`);
    }
  }
  pipe(run());
});

// ---------------------------------------------------------------------------------------------
// POST /session: several prompts, one after the other, in ONE session (streaming input, Concept 12)
// ---------------------------------------------------------------------------------------------

const MAX_PROMPTS = 8;

concept21.post("/session", (req, res) => {
  const body = req.body as { prompts?: unknown };
  const { abort, send, pipe } = openSse(req, res);
  const prompts = (Array.isArray(body.prompts) ? body.prompts : [])
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0 && p.length <= MAX_PROMPT)
    .map((p) => p.trim())
    .slice(0, MAX_PROMPTS);
  if (!prompts.length) {
    send("error", { message: `Send 1 to ${MAX_PROMPTS} prompts, one per line.` });
    send("done", {});
    return res.end();
  }

  // The next prompt is pushed only after the previous one's result, like a user typing turn after turn.
  let next: (() => void) | undefined;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (const [index, text] of prompts.entries()) {
      send("turn", { index, prompt: text });
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
      await new Promise<void>((resolve) => (next = resolve));
    }
  }

  const options: Options = { ...BASE, maxTurns: 4 };
  send("options", { ...options, prompt: "[AsyncIterable<SDKUserMessage>]" });
  console.log(`[c21] session of ${prompts.length} prompt(s) started`);
  guard(res, abort, send);

  const q = query({ prompt: input(), options: { ...options, abortController: abort } });
  async function* untilLast() {
    let results = 0;
    for await (const msg of q) {
      yield msg;
      if (msg.type !== "result") continue;
      if (++results === prompts.length) return; // ends the query: the input generator is left waiting
      next?.();
    }
  }
  pipe(untilLast()).finally(() => console.log(`[c21] session closed`));
});
