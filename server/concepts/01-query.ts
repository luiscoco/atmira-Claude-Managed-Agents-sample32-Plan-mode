/**
 * CONCEPT 1 — query(): the heart of the SDK
 *
 * `query({ prompt, options })` starts an agent run and returns an async
 * iterable of SDKMessage objects. You consume it with `for await`.
 *
 * A typical run emits, in order:
 *   1. { type: "system", subtype: "init" }  -> session id, model, tools, cwd...
 *   2. { type: "assistant" }                -> Claude's reply (content blocks)
 *   3. { type: "result" }                   -> final text, cost, tokens, duration
 */
import { Router } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept01 = Router();

concept01.post("/query", (req, res) => {
  const { prompt } = req.body as { prompt: string };
  const { abort, pipe } = openSse(req, res);

  const run = query({
    prompt,
    options: {
      abortController: abort, // stop the agent if the browser disconnects
      tools: [], // no built-in tools yet: pure Q&A (tools come in a later concept)
      maxTurns: 1,
    },
  });

  pipe(run);
});
