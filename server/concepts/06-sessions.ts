import { Router } from "express";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { openSse } from "../sse.js";

export const concept06 = Router();

type Body = { prompt: string; resume?: string };

concept06.post("/query", (req, res) => {
  const body = req.body as Body;
  const { abort, send, pipe } = openSse(req, res);
  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 3,
    settingSources: [],
    ...(body.resume ? { resume: body.resume } : {}),
  };

  send("options", options);
  pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
});
