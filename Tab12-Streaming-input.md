# Concept 12: Streaming input mode, step by step

This file explains how Concept 12 (**Streaming input mode**) was added to the Claude Agent SDK Lab.
Concept 10 used an input queue only to make `interrupt()` work. Here the queue is the main topic: when the prompt
is an async iterable, one `query()` call is a **live session** you can talk to, and change, while it runs.
There are three parts:

- **A. One `query()`, many turns.** A chat on top of a single process: messages sent while the agent is busy,
  `priority`, and messages with images.
- **B. Changing the session while it is alive.** `setModel()`, `setPermissionMode()`, `supportedModels()` and
  `getContextUsage()`.
- **C. Two ways to write the prompt.** An `async function*` generator compared with a plain string.

| Concept | Topic | Routes |
|---|---|---|
| 12 | Streaming input: `AsyncIterable<SDKUserMessage>`, queue, `priority`, image blocks, control requests | `/api/c12/session`, `/send`, `/model`, `/permission-mode`, `/context`, `/end`, `/script` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/12-streaming-input.ts` | **New**: the live-session routes and the `/script` route |
| `server/index.ts` | Mounts the router on `/api/c12`, and raises the JSON body limit to 10 MB (images) |
| `src/concepts/Concept12StreamingInput.tsx` | **New**: the tab (Parts A, B and C) |
| `src/App.tsx` | Adds the tab to the navigation |
| `src/styles.css` | Adds `.thumb` (image preview) and `.meter` (context bar) |
| `Tab1-query().md` | Adds Concept 12 to the table of concepts |
| `Tab12-Streaming-input.md` | This explanation |

---

## Step 1: Read the type definitions

As in the other concepts, the code was written against the installed SDK (`0.3.281`), in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;

type SDKUserMessage = {
  type: 'user';
  message: MessageParam;             // content: a string OR an array of blocks (text, image, document, ...)
  parent_tool_use_id: string | null;
  priority?: 'now' | 'next' | 'later';
  // ...
};

interface Query extends AsyncGenerator<SDKMessage, void> {
  // "Control Requests ... only supported when streaming input/output is used."
  interrupt(): Promise<...>;                              // Concept 10
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;   // "Used internally for multi-turn conversations."
  close(): void;
  // ... and many more (applyFlagSettings, setMcpServers, reloadSkills, ...)
}
```

Two things in these types shape the tab:

1. `prompt` has **two modes**. A string is *single message mode*: one message, then the input is closed.
   An async iterable is *streaming input mode*: the SDK keeps reading from it, so the session lives as long as
   the iterable is open.
2. The `Query` object is not only the output stream. It is also a **remote control** for the running
   Claude Code process. Those control requests need the process to still be alive, which is what streaming input
   gives you.

---

# Part A: One query(), many turns

## Step 2: The input queue (again)

The server reuses the push queue from Concept 10. It is an async generator that yields whatever was pushed, and
waits while the queue is empty:

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
    push(message: SDKUserMessage) { queue.push(message); wake?.(); },
    close() { closed = true; wake?.(); },
  };
}
```

The only change: `push()` now takes a whole `SDKUserMessage`, so the caller can set `priority` and use content
blocks. A small helper builds it:

```ts
function userMessage(text: string, image?: Image, priority?: Priority): SDKUserMessage {
  const content = image
    ? [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
      ]
    : text;
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content }, ...(priority && { priority }) };
}
```

## Step 3: The session route

`POST /session` starts one `query()` with the queue as prompt, stores it in a `Map` by id (like Concept 10), and
streams everything as SSE:

```ts
const options: Options = {
  model: MODEL,                        // Haiku, so the demo is cheap
  tools: ["Read", "Write", "Glob"],
  allowedTools: ["Read", "Glob"],      // Write is NOT pre-approved: the permission mode decides (Part B)
  permissionMode,                      // chosen in the UI before starting
  cwd: SANDBOX,
  settingSources: [],
  strictMcpConfig: true,
  includePartialMessages: true,        // the answer grows as it streams, so you can send while it is busy
};

const q = query({ prompt: input.stream, options: { ...options, abortController: abort } });
sessions.set(id, { q, input, send, startedAt: Date.now() });
pipe(q).finally(() => sessions.delete(id));

// A control request works as soon as the process is up, even before the first message.
q.supportedModels().then((models) => send("models", models));
```

`POST /send` pushes a message (it also sends a `control` SSE event so the timeline shows when):

```ts
concept12.post("/send", control(({ input, send, ms }, { text, image, imageName, priority, clientId }) => {
  send("control", { method: "push user message", text, image: imageName, priority, clientId, ms });
  input.push(userMessage(text, image, priority));
}));
```

`control()` is a small wrapper used by every route in Parts A and B: it finds the open session, runs the action,
and answers `409` with the error if the session is gone.

## Step 4: What one live session looks like in the stream

Tested with three messages in a row. The same `session_id` for all of them, and **one `system/init` per turn**, not
one per session:

```
push "Create hello.txt ..."        system/init  model haiku  mode default      session d824e1b8
                                   ... result/success  total $0.0090
push "Try again ..."               system/init  model haiku  mode acceptEdits  session d824e1b8
                                   ... result/success  total $0.0166
push "Write 30 octopus facts..."   system/init  ...                            session d824e1b8
```

Two things to notice:

- **No `resume` is needed.** Concept 6 started a new process per message and passed `resume: sessionId`.
  Here the process never stops, so the context is simply still there. Part C proves it with a memory question.
- **`result.total_cost_usd` is a running total for the session**, not the cost of that turn. The timeline shows
  both: the total, and the difference with the previous result ("this turn").

## Step 5: Sending while the agent is busy, and `priority`

The input is a queue, so nothing stops you from pushing while a turn is running. Tested with a long answer, and a
second message 1.5 s later:

| Second message sent with | What happened |
|---|---|
| no `priority` | It waited. The first turn finished (`result/success`), then the second one ran as its own turn. |
| `priority: "later"` | Same as no priority, for a single queued message. |
| `priority: "now"` | The running turn stopped within ~10 ms with `result/error_during_execution` ($0 for that turn), and a new turn started straight away. |

With `"now"`, the new turn still sees the whole conversation, including the unfinished request. In the first test
the message was just "Now just say: BANANA" and the model went back to counting. When the message clearly redirects
("**Stop. Instead,** just say BANANA."), the answer is `BANANA`. So `"now"` behaves like *interrupt + send*, in one
message.

`"next"` vs `"later"` only matters when several messages are waiting: they decide the order inside the queue.

## Step 6: Messages with images

`message.content` is an Anthropic Messages API `MessageParam`, so it can be an array of blocks. The browser reads
the file with `FileReader.readAsDataURL()`, keeps the base64 part, and sends it in the JSON body:

```ts
reader.onload = () => {
  const url = String(reader.result);                  // data:image/png;base64,....
  setImage({ media_type: file.type, data: url.split(",")[1], name: file.name, url });
};
```

Tested with the architecture diagram from sample 1: *"This infographic illustrates the architecture of the
'Claude Agent SDK Lab', showing how a React browser UI sends queries ..."*.

### The JSON body limit

`express.json()` accepts 100 KB by default, and a screenshot in base64 is usually bigger (Express would answer
`413 Payload Too Large`). `server/index.ts` now uses `express.json({ limit: "10mb" })`, and the browser refuses files
over 5 MB. The server echoes only the file *name* in the `control` event; the browser keeps its own preview
(by `clientId`), so the image is not sent back through SSE.

---

# Part B: Changing the session while it is alive

## Step 7: The control routes

| Route | Calls | What you see in the stream |
|---|---|---|
| `POST /model` | `await q.setModel(model)` | A `user` message `<local-command-stdout>Set model to ...</local-command-stdout>`, then the next `system/init` shows the new model |
| `POST /permission-mode` | `await q.setPermissionMode(mode)` | A `system/status` message with `permissionMode`, then the next `system/init` shows it too |
| `POST /context` | `await q.getContextUsage({ detail: "summary" })` | Nothing in the stream: the answer is the return value |
| `POST /end` | `input.close()` | The loop ends normally |
| (on start) | `await q.supportedModels()` | Nothing in the stream: fills the model `<select>` |

```ts
concept12.post("/model", control(async ({ q, send, ms }, { model }) => {
  await q.setModel(model);
  send("control", { method: `q.setModel("${model}")`, ms });
}));
```

`getContextUsage()` returns a lot (a grid for the terminal UI, memory files, MCP tools, ...). The route keeps only
the numbers the tab draws:

```ts
const { categories, totalTokens, maxTokens, percentage } = await q.getContextUsage({ detail: "summary" });
```

`"summary"` answers from the last response's usage, without extra calls to the token-count API. After six turns it
said: *System tools 2,840 · Messages 3,917 · 6,757 tokens (1%)*. The window was 1,000,000 because the session was on
Sonnet by then; on Haiku it is 200,000.

## Step 8: What each control does, tested

**`setPermissionMode()`**: the same request, before and after:

1. Start in `default` and send *Create hello.txt*. `Write` is not in `allowedTools` and there is no `canUseTool`
   (Concept 4), so nobody can approve it: `system/permission_denied`, an error `tool_result`, and
   `result.permission_denials` has one entry. The model says it needs permission.
2. `setPermissionMode("acceptEdits")`, then *Try again*: `Write` succeeds and `sandbox/hello.txt` contains `hi`.
   Same session, same process, no restart.
3. `plan` mode: the model does **not** touch `hello.txt`. It writes a plan instead. Note that Claude Code saves
   that plan in `~/.claude/plans/` (your user folder, outside the sandbox).

**`setModel()`**: after `setModel("claude-sonnet-5")`, *Which model are you?* answers *"I'm Claude Sonnet 5."* and
`system/init.model` changes. One detail found while testing: a message that was **already queued** when
`setModel()` was called still ran on the old model. The change applies from the next turn the CLI starts.

## What to take away from Parts A and B

1. **An async iterable prompt turns `query()` into a session.** It lives until you close the iterable (or abort).
2. **Each message is a turn.** One `system/init` and one `result` per turn, the same `session_id`, no `resume`.
3. **Pushing while busy is normal.** Messages wait in order; `priority: "now"` cuts the running turn.
4. **Content can be blocks.** Text + image (or documents) in one user message.
5. **The `Query` object is a remote control.** Model, permission mode, context usage, and more, all without
   restarting. Each change shows up in the stream (`local-command-stdout`, `system/status`, the next `system/init`).
6. **`total_cost_usd` is cumulative** in a live session. Subtract to get the cost of a turn.

---

# Part C: Two ways to write the prompt

## Step 9: A generator instead of a queue

A queue is handy when messages come from outside (a browser, a chat app). When the conversation is known in
advance, an `async function*` is simpler. The generator yields a message, then waits until that turn's result
arrives before it yields the next one:

```ts
let turnDone = () => {};
async function* conversation(): AsyncGenerator<SDKUserMessage> {
  for (const text of SCRIPT) {
    const done = new Promise<void>((resolve) => (turnDone = resolve));   // created BEFORE the yield
    yield userMessage(text);
    await done;
  }
}

// Pass every message through, and tell the generator when a turn ends.
async function* signalTurns(stream: AsyncIterable<SDKMessage>) {
  for await (const msg of stream) {
    yield msg;
    if (msg.type === "result") turnDone();
  }
}

pipe(signalTurns(query({ prompt: conversation(), options })));
```

When the generator returns, the input is closed and the session ends by itself.

Without the `await done`, the generator would yield all three messages at once: they would simply queue up
(Step 5) and run one after the other. Waiting makes each message depend on the previous answer, which is what a
real script usually needs.

## Step 10: The same first message, as a string

```ts
const q = query({ prompt: SCRIPT[0], options });

async function* thenTryControl() {
  yield* q;                                   // stream every message
  try {
    await q.setModel("claude-sonnet-5");      // the loop has ended: is the process still there?
  } catch (err) {
    send("control", { method: 'q.setModel("claude-sonnet-5") after the loop', error: String(err) });
  }
}
```

## Step 11: Generator vs. string, tested

| | `async function*` | `"a string"` |
|---|---|---|
| Turns | 3 (`system/init` ×3, one `session_id`) | 1 |
| Third answer | *"You're Ana, and you teach TypeScript."* (context kept, no `resume`) | – |
| After the loop | The generator returned, so the input closed | `setModel()` throws `Error: Query closed before response received` |
| Session total | $0.0050 for 3 turns (Haiku) | $0.0020 |

One more detail found while testing: calling `setModel()` on a string query **before** the loop does not throw. It
resolves, but the single turn still ran on the original model (`result.modelUsage` only listed Haiku). The
message was already sent, so there was no *next* turn to apply it to. The `sdk.d.ts` comment "only available in
streaming input mode" is not enforced with an error. In practice, it just has no useful effect.

## What to take away

1. **String = one message, one turn.** Simple, and the right choice for one-shot tasks.
2. **Async iterable = a live session.** Use a push queue when the messages come from outside, and a generator when
   the script is known.
3. **Control requests need a live process.** They work from the moment `query()` starts until the input closes.
   After that they throw `Query closed before response received`.
4. **Close the input to end cleanly.** `input.close()` (or the generator returning) ends the loop without an error.
   `abortController.abort()` (Concept 10) kills the process instead.
5. **`streamInput()`** exists on `Query`, but the SDK describes it as "used internally for multi-turn
   conversations". Passing the iterable as `prompt` is the public way to do the same.

## Things to try in Concept 12

1. Start in `dontAsk` mode and ask for *Create a file*. Compare the denial with the one in `default` mode.
2. Send *Long answer*, then quickly send three short messages with different `priority` values. In what order do
   they run?
3. Switch the model to one from `supportedModels()` (e.g. `haiku` or `sonnet`) and watch the "this turn" cost
   change.
4. Press **`await q.getContextUsage()`** after each turn and watch *Messages* grow. Then send an image and press it
   again.
5. In the server, remove `await done` from `conversation()` and run the generator again. Are the answers
   different?

## Running the app

Same as the other tabs: `npm install` (first time), `npm run dev`, then open http://localhost:5173 and select
**12. Streaming input**. See [Tab2-Options.md](Tab2-Options.md#running-the-app) for the full PowerShell steps.

The live session needs several requests (start, then send / control), so it is easiest from the UI. Part C can be
called without the UI:

```powershell
curl.exe -N -X POST http://localhost:3001/api/c12/script -H "Content-Type: application/json" -d '{\"variant\":\"generator\"}'
curl.exe -N -X POST http://localhost:3001/api/c12/script -H "Content-Type: application/json" -d '{\"variant\":\"string\"}'
```
