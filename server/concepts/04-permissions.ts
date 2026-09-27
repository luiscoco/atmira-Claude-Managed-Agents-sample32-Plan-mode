/**
 * CONCEPT 4 — Permissions: canUseTool, approving each tool call from the UI
 *
 * In Concept 3, a call that needed permission was simply denied, because nobody was there to ask.
 * `canUseTool` is that "somebody": an async function the SDK awaits before running such a call.
 *
 *   canUseTool(toolName, input, { signal, suggestions, toolUseID, title, decisionReason, blockedPath, ... })
 *     -> { behavior: "allow", updatedInput?, updatedPermissions? }
 *     -> { behavior: "deny", message, interrupt? }
 *
 * It is only called for calls that would "ask": read-only tools, `allowedTools` entries and the
 * permissionMode can all decide first. Here the callback parks each request in a Map, streams it to the
 * browser as an SSE event, and resolves when the browser POSTs a decision to /api/c4/decide.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import { query, type CanUseTool, type Options, type PermissionMode, type PermissionResult, type PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";
import { SANDBOX } from "./03-tools.js";

export const concept04 = Router();

// Requests waiting for a human. The key is our own id (sent to the browser); `resolve` settles the callback's promise.
// The original input and the SDK's suggestions stay on the server, so the browser only sends its choice.
type Pending = { input: Record<string, unknown>; suggestions?: PermissionUpdate[]; resolve: (d: PermissionResult) => void };
const pending = new Map<string, Pending>();

type Decision = {
  id: string;
  choice: "allow" | "allow_always" | "deny" | "deny_interrupt";
  updatedInput?: Record<string, unknown>;
  message?: string;
};

type Body = {
  prompt: string;
  model?: string;
  tools: string[];
  allowedTools: string[];
  permissionMode?: PermissionMode;
  approver: "ui" | "policy";
  maxTurns?: number;
};

/**
 * The "policy" approver: canUseTool is just a function, so it can decide in code, with no human at all.
 * Allow file tools inside sandbox/, deny them anywhere else, and deny any Bash command that deletes files.
 */
const policy: CanUseTool = async (toolName, input) => {
  const file = typeof input.file_path === "string" ? path.resolve(SANDBOX, input.file_path) : undefined;
  const rel = file && path.relative(SANDBOX, file); // path.relative ignores drive-letter case on Windows
  if (file && (!rel || rel.startsWith("..") || path.isAbsolute(rel))) {
    return { behavior: "deny", message: `Policy: ${toolName} is only allowed inside sandbox/, not ${file}.` };
  }
  if (toolName === "Bash" && /\b(rm|del|rmdir|Remove-Item)\b/.test(String(input.command))) {
    return { behavior: "deny", message: "Policy: commands that delete files are not allowed." };
  }
  return { behavior: "allow", updatedInput: input };
};

concept04.post("/query", (req, res) => {
  const body = req.body as Body;
  const { abort, send, pipe } = openSse(req, res);
  const ids: string[] = [];

  // The "ui" approver: park the request, show it in the browser, and wait for /decide.
  const askTheUser: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const id = randomUUID();
      ids.push(id);
      pending.set(id, {
        input,
        suggestions: opts.suggestions,
        resolve: (decision) => {
          pending.delete(id);
          send("permission_decision", { id, toolName, decision });
          resolve(decision);
        },
      });
      send("permission_request", {
        id,
        toolName,
        input,
        toolUseID: opts.toolUseID,
        title: opts.title,
        displayName: opts.displayName,
        description: opts.description,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        suggestions: opts.suggestions,
      });
      // If the run is cancelled (browser closed, Stop pressed), don't leave the callback hanging.
      opts.signal.addEventListener("abort", () => pending.get(id)?.resolve({ behavior: "deny", message: "Run aborted." }));
    });

  // Wrap either approver so the UI also sees what the policy decided.
  const canUseTool: CanUseTool =
    body.approver === "policy"
      ? async (toolName, input, opts) => {
          const decision = await policy(toolName, input, opts);
          send("permission_decision", { id: opts.toolUseID, toolName, input, decision, auto: true });
          return decision;
        }
      : askTheUser;

  const options: Options = {
    tools: body.tools,
    allowedTools: body.allowedTools,
    cwd: SANDBOX,
    canUseTool,
    settingSources: [], // isolation, as in Concept 3
    strictMcpConfig: true,
  };
  if (body.permissionMode) options.permissionMode = body.permissionMode;
  if (body.model) options.model = body.model;
  if (body.maxTurns) options.maxTurns = body.maxTurns;

  // A function can't be serialized, so show a placeholder in the echoed options.
  send("options", { ...options, canUseTool: `[Function ${body.approver === "policy" ? "policy" : "askTheUser"}]` });

  const run = query({ prompt: body.prompt, options: { ...options, abortController: abort } });
  pipe(run).finally(() => ids.forEach((id) => pending.delete(id)));
});

// The browser answers a permission_request. This turns the UI choice into a PermissionResult.
concept04.post("/decide", (req, res) => {
  const { id, choice, updatedInput, message } = req.body as Decision;
  const request = pending.get(id);
  if (!request) return void res.status(404).json({ error: "No pending request with that id (already answered or run ended)." });

  if (choice === "allow" || choice === "allow_always") {
    // updatedInput lets you change the call before it runs (e.g. another file name). Default: run it as asked.
    const decision: PermissionResult = { behavior: "allow", updatedInput: updatedInput ?? request.input };
    // "Always allow": hand back the SDK's own suggestions so it stops asking for this tool.
    // Force destination "session" so nothing is written to a settings file on disk.
    if (choice === "allow_always") {
      decision.updatedPermissions = (request.suggestions ?? []).map((s) => ({ ...s, destination: "session" }) as PermissionUpdate);
    }
    request.resolve(decision);
  } else {
    request.resolve({ behavior: "deny", message: message || "The user denied this tool call.", interrupt: choice === "deny_interrupt" });
  }
  res.json({ ok: true });
});
