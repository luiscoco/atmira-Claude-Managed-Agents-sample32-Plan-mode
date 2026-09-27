# Concept 10: Structured output and interrupting a run, step by step

This file explains how Concept 10 (**Structured output & interrupt**) was added to the Claude Agent SDK Lab.
It has two parts that answer two practical questions:

- **A. "How do I get data, not prose?"** `outputFormat` makes the agent return JSON that matches a schema.
- **B. "How do I stop it?"** `q.interrupt()` stops the current turn and keeps the session alive.
  `abortController.abort()` kills the whole run.

| Concept | Topic | Routes |
|---|---|---|
| 10 | Structured output (`outputFormat`) and interrupting a run | `/api/c10/structured`, `/api/c10/schemas`, `/api/c10/run` + `/interrupt`, `/abort`, `/send`, `/end` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/10-structured-interrupt.ts` | **New**: zod schemas + `outputFormat` route; streaming-input run + control routes |
| `server/index.ts` | Mounts the router on `/api/c10` |
| `src/concepts/Concept10StructuredInterrupt.tsx` | **New**: the tab (Part A and Part B) |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | `hr` divider between the two parts |
| `Tab10-Structured-output-and-interrupt.md` | This explanation |

---

## Step 1: Read the type definitions

As before, the code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
// Options
outputFormat?: OutputFormat;                    // OutputFormat = JsonSchemaOutputFormat
type JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> };

// The result message
type SDKResultSuccess = { subtype: 'success'; result: string; structured_output?: unknown; terminal_reason?: ...; ... };
type SDKResultError   = { subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
                                 | 'error_max_structured_output_retries'; ... };

// The object returned by query()
interface Query extends AsyncGenerator<SDKMessage, void> {
  /** Control Requests ... only supported when streaming input/output is used. */
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;   // { still_queued: string[] }
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  ...
}

// Options, since Concept 1
abortController?: AbortController;
```

Two details matter here:

1. `structured_output` is `unknown`. The SDK doesn't give you a typed value, so you have to validate it yourself.
2. `interrupt()` is a **control request**, and control requests only work in **streaming input mode**, where the
   `prompt` is an `AsyncIterable<SDKUserMessage>` instead of a string.

---

# Part A: structured output

## Step 2: Write each schema once, in zod

`zod` has been installed since Concept 5 (`tool()` uses it). The server writes each schema in zod and uses it twice:

```ts
const schemas = {
  profile: z.object({
    name: z.string(),
    yearsOfExperience: z.number().int().min(0),
    languages: z.array(z.string()).max(5),
    seniority: z.enum(["junior", "mid", "senior"]),
  }),
  ...
};

// 1. JSON Schema for the SDK
outputFormat: { type: "json_schema", schema: z.toJSONSchema(schemas[id], { target: "draft-07" }) }

// 2. Runtime check (and TypeScript type) for the result
schemas[id].safeParse(result.structured_output)
```

### Problem found while testing: the `$schema` draft

The first attempt used `z.toJSONSchema(schema)` without the second argument. The Claude Code process refused to start:

```
Error: Claude Code process exited with code 1. stderr: Error: --json-schema is not a valid JSON Schema:
no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

zod 4 stamps `"$schema": "https://json-schema.org/draft/2020-12/schema"` by default, and the CLI's validator
doesn't know that draft. `{ target: "draft-07" }` fixes it. Removing the `$schema` key would also work.

## Step 3: What actually happens in the stream

There is no special "JSON mode". The SDK adds a tool called **`StructuredOutput`** whose input schema is your
schema, and tells the model it must call it. You can see this in `system/init`: even with `tools: []`, the list is
`["StructuredOutput"]`.

```
assistant  tool_use StructuredOutput {"name":"Ana García","yearsOfExperience":7,"languages":[...],"seniority":"senior"}
user       tool_result "Structured output provided successfully"
result     success · structured_output = { ...the same object... }
```

Because it is a tool call, the CLI **validates** the input against the schema. If the input doesn't match, the
tool returns an error and the model tries again. Too many failures end with
`result/error_max_structured_output_retries`.

## Step 4: Server route

**File:** [server/concepts/10-structured-interrupt.ts](server/concepts/10-structured-interrupt.ts)

```ts
const options: Options = {
  model: MODEL,
  tools: schemaId === "tasks" ? ["Read"] : [],
  allowedTools: schemaId === "tasks" ? ["Read"] : [],
  cwd: SANDBOX,
  maxTurns: 6,
  settingSources: [],
  strictMcpConfig: true,
  outputFormat: { type: "json_schema", schema: toJsonSchema(schemaId) },
};
```

The stream goes through a small async generator before it reaches `pipe()`. It passes every message on, and when
the `result` arrives it runs `safeParse` and sends a `validation` event:

```ts
async function* withValidation(stream: AsyncIterable<SDKMessage>) {
  for await (const msg of stream) {
    yield msg;
    if (msg.type === "result") {
      const value = msg.subtype === "success" ? msg.structured_output : undefined;
      const parsed = schemas[schemaId].safeParse(value);
      send("validation", parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error.issues });
    }
  }
}
```

`GET /schemas` returns the JSON Schemas, so the tab can show exactly what is sent.

## Step 5: The four scenarios, tested

| Scenario | Schema | What happened | Cost |
|---|---|---|---|
| Extract a profile | `profile` | One `StructuredOutput` call, valid first time. `seniority: "senior"` was *inferred* ("leads the platform team") | $0.0040 |
| Classify a review | `review` | Mixed review → `positive`, `score: 0.68`, 3 highlights (the `max(3)` held) | $0.0049 |
| After a tool call | `tasks` + `Read` | `Read data/tasks.json` → prose summary → `StructuredOutput {"total":3,"done":2,"pending":[{"id":3,...}]}` | $0.0083 |
| Schema vs. facts | `sum: z.literal(1)` | See below | $0.0176 |

The last one is the interesting one. The schema demands `sum: 1`, but 2 + 3 + 5 = 10:

```
assistant  text "…the first three prime numbers are 2, 3 and 5, sum 10"             (no tool call)
user       text "[structured-output-enforce] You MUST call the StructuredOutput tool…" (injected by the SDK)
assistant  tool_use StructuredOutput {"primes":[2,3,5],"sum":10}
user       tool_result "Output does not match required schema: /sum: must be equal to constant: 1"  (is_error)
assistant  text "…I'm faced with an impossible situation…"                          (refuses to lie)
result     subtype: "success", terminal_reason: "completed", structured_output: undefined
```

**`subtype: "success"` does not mean you got structured output.** The model gave up and ended the turn with text,
so `structured_output` is missing. The server's `safeParse` catches it:
`expected object, received undefined`. With another prompt, the same conflict can instead end in
`error_max_structured_output_retries`. Handle both.

## Step 6: Browser flow (Part A)

**File:** [src/concepts/Concept10StructuredInterrupt.tsx](src/concepts/Concept10StructuredInterrupt.tsx), `StructuredOutput()`

1. Pick a scenario; the prompt is filled in and the JSON Schema is shown in a collapsible card.
2. **Run query() with outputFormat** streams from `/api/c10/structured`.
3. The **Tool calls** card pairs every `tool_use` with its `tool_result` (by `tool_use_id`), so failed
   `StructuredOutput` attempts appear in amber.
4. The result card shows `result.structured_output` and `result.result` (the text answer) side by side,
   followed by the server's `safeParse` verdict.

---

# Part B: interrupt() vs abort()

## Step 7: Streaming input mode

`interrupt()` needs the prompt to be an async iterable. The server builds a small **push queue**: an async
generator that yields queued messages and waits while the queue is empty. The session stays open until the queue is
closed:

```ts
function inputQueue() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  async function* stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    stream: stream(),
    push(text: string) { queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } }); wake?.(); },
    close() { closed = true; wake?.(); },
  };
}

const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
```

This also means one `query()` call can serve **many turns** without `resume` (Concept 6): each `push()` is a new
user message in the same live session.

## Step 8: Control routes

`POST /run` stores the open run in a `Map` (like the pending permissions in Concept 4), sends its `id` to the
browser, and streams as usual. The browser then drives the run through four small routes:

| Route | Calls | Effect |
|---|---|---|
| `POST /interrupt` | `await q.interrupt()` | Stops the current turn; resolves with the receipt `{ still_queued: [] }` |
| `POST /abort` | `abort.abort()` | Kills the Claude Code process |
| `POST /send` | `input.push(text)` | Sends another user message to the same session |
| `POST /end` | `input.close()` | Ends the input iterable, which is the normal way to end the session |

Each route also sends a `control` SSE event with the elapsed milliseconds, so the timeline shows when each call
was made.

One detail: `openSse()` hides errors that happen *after the browser disconnects* (its own AbortController). This
route uses a **second** AbortController for the SDK, so a user-pressed abort still shows the error it causes. A
browser disconnect aborts both.

## Step 9: What each method does, tested

The prompt was *"Write a numbered list of 40 fun facts about octopuses"*, stopped a few seconds into the answer.

**`q.interrupt()` followed by a follow-up message:**

```
control  q.interrupt()  at 8001 ms  receipt {"still_queued":[]}
user     "[Request interrupted by user]"                         (injected by the SDK)
result   error_during_execution · terminal_reason: aborted_streaming · $0.0010
control  push user message: "What was the last fact you wrote before I stopped you? Quote it."
assistant "The last complete fact I wrote was: 7. They can change color and texture…
           I had just begun fact #8 ("They're considered") when you interrupted me."
result   success · completed
control  close input  ->  the loop ends normally
```

The partial answer **stays in the conversation**. The model knew exactly where it had been cut off.

**`q.interrupt()` followed by closing the input:**

```
result   error_during_execution · aborted_streaming
control  close input
error    Claude Code returned an error result: [ede_diagnostic] result_type=user …
```

When the session ends and its **last** result was an error, the iterator throws after yielding it. This is the
same "error result **and** a throw" pattern as `maxTurns` / `maxBudgetUsd` in Concept 2. If you close after an
interrupt, catch that error.

**`abortController.abort()`:**

```
control  abortController.abort()  at 4977 ms
error    Operation aborted
```

No result message and no `[Request interrupted by user]`: the process is killed and `for await` throws at once.
The session can't take more messages. Any later call to `/interrupt` answers `409 No open run with that id`.

## Step 10: Browser flow (Part B)

`Interrupt()` and `Timeline()` in the same file:

1. **Start run** opens the session. While a turn is running, **⏸ await q.interrupt()** and
   **⏹ abortController.abort()** are enabled.
2. The timeline is rebuilt from the event log on every render: your messages, the assistant text growing from
   `text_delta` stream events, each control call with its timestamp and receipt, the SDK's injected
   `[Request interrupted by user]`, and one result chip per turn.
3. When a turn ends (a `result` arrives) and the session is still open, a card offers **Send follow-up** or
   **Close input (end session)**.
4. The error card explains the two throws above.

---

## What to take away

1. **`outputFormat` is a tool call in disguise.** The SDK adds `StructuredOutput`, the CLI validates it and the
   model retries on errors. That is why it also works after other tool calls (the `tasks` scenario).
2. **Always validate `structured_output`.** It is `unknown`, and it can be missing even when
   `subtype === "success"`. One zod schema gives you the JSON Schema, the runtime check and the TypeScript type.
3. **Ask zod for `draft-07`.** The CLI rejects zod 4's default draft 2020-12 `$schema`.
4. **A schema can't make the model lie.** A schema that contradicts the facts leads to retries, and then either a
   refusal or `error_max_structured_output_retries`, not bad data.
5. **`interrupt()` stops a turn; `abort()` stops the run.**

   | | `await q.interrupt()` | `abortController.abort()` |
   |---|---|---|
   | Needs streaming input (`prompt` = AsyncIterable) | yes | no |
   | Result message | `error_during_execution` / `aborted_streaming` | none |
   | Partial answer kept in the session | yes | the session is gone |
   | Can continue with another message | yes (`push`) | no |
   | `for await` | continues; throws only if the input closes right after the error result | throws `Operation aborted` |
   | Use it for | a "Stop generating" button | cancel everything, timeouts, the user left |

6. **Streaming input is also multi-turn without `resume`.** Concept 6 started a new `query()` per message and
   passed `resume`. Here one live `query()` takes every message through the iterable.

## Things to try in Concept 10

1. In *Extract a profile*, remove the seniority hint from the prompt ("leads the platform team"). What does the
   model pick when the enum forces a choice?
2. In *Schema vs. facts*, change the prompt to "Give me the first three primes; the sum field is just a label."
   Does it now write `sum: 1`? Are you happy with that?
3. In *Classify a review*, paste a review with five issues and check that `highlights` never goes over three.
4. Interrupt the octopus list, then ask *"continue from where you stopped"*. The same session picks up the list.
5. Interrupt, then press **Close input** at once, and read the error card. Then try it again after a successful
   follow-up: the loop now ends normally.
6. Press **abort()** during the first second (while the model is still thinking) and compare the timeline with an
   abort mid-text.

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**10. Structured output & interrupt**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full
PowerShell steps.

To call the structured-output endpoint without the UI:

```powershell
'{"schemaId":"profile","prompt":"Ana has 7 years of experience and codes in TypeScript and Go."}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c10/structured -H "Content-Type: application/json" -d "@body.json"
Remove-Item body.json
```

`schemaId` is one of `profile`, `review`, `tasks`, `conflict`.

To drive an interruptible run by hand, use two terminal tabs:

```powershell
# Tab 1: start the run and keep the stream open. Copy the "id" from the first "run" event.
'{"prompt":"Write a numbered list of 40 fun facts about octopuses."}' | Set-Content body.json
curl.exe -N -X POST http://localhost:3001/api/c10/run -H "Content-Type: application/json" -d "@body.json"

# Tab 2: stop the turn, send a follow-up, then end the session
curl.exe -X POST http://localhost:3001/api/c10/interrupt -H "Content-Type: application/json" -d '{\"id\":\"<id>\"}'
curl.exe -X POST http://localhost:3001/api/c10/send      -H "Content-Type: application/json" -d '{\"id\":\"<id>\",\"text\":\"Where did you stop?\"}'
curl.exe -X POST http://localhost:3001/api/c10/end       -H "Content-Type: application/json" -d '{\"id\":\"<id>\"}'
```
