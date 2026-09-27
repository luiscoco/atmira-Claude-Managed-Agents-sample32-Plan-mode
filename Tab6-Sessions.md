# Concept 6: Sessions with `resume`, step by step

This file explains how Concept 6 (**Sessions**) was added to the Claude Agent SDK Lab.
It builds on Concept 1 ([Tab1-query().md](<Tab1-query().md>)), especially the `system/init` message.

**Goal:** make two separate `query()` calls behave like one conversation. The first call creates a session and emits a
`session_id`. The browser sends that ID back as `options.resume` on the next call, allowing Claude to remember the
previous turn.

| Concept | Topic | Route |
|---|---|---|
| 6 | Sessions: multi-turn chat with `resume` | `/api/c6/query` |

## Step 1: Find the session ID

Every run emits a `system/init` message. Among other fields, it contains the ID of the conversation:

```ts
{
  type: "system",
  subtype: "init",
  session_id: "...",
  model: "..."
}
```

The ID is not invented by the UI. It comes from the SDK, so the client must wait for `system/init` before it can
continue the session.

## Step 2: Resume the session

The SDK accepts the previous session ID in `Options.resume`:

```ts
const firstRun = query({
  prompt: "Remember that my favorite color is green.",
  options: { settingSources: [] },
});

const secondRun = query({
  prompt: "What is my favorite color?",
  options: { resume: sessionId, settingSources: [] },
});
```

`resume` is different from putting the earlier answer into the new prompt. The SDK loads the existing conversation
session and adds the new prompt to it.

## Step 3: Server route

**File:** [server/concepts/06-sessions.ts](server/concepts/06-sessions.ts)

The route accepts an optional `resume` value. When it is present, it is forwarded to `query()`:

```ts
const options: Options = {
  model: "claude-haiku-4-5-20251001",
  maxTurns: 3,
  settingSources: [],
  ...(body.resume ? { resume: body.resume } : {}),
};

pipe(query({ prompt: body.prompt, options: { ...options, abortController: abort } }));
```

The server does not store conversation state in an application `Map`. The SDK owns the session; the browser only keeps
and returns its identifier.

## Step 4: Browser flow

**File:** [src/concepts/Concept06Sessions.tsx](src/concepts/Concept06Sessions.tsx)

The tab follows this sequence:

1. **Start session** sends a prompt without `resume`.
2. The `system/init` event is received and its `session_id` is saved in React state.
3. **Continue session** sends the next prompt together with that ID.
4. **New session** clears the ID and message log, so the next run starts from scratch.

The tab also keeps all raw SDK messages visible through `MessageLog`, making the two `system/init` events and their
results easy to compare.

## Things to try in Concept 6

1. Run the default prompt, then replace it with `What is my favorite color?` and click **Continue session**.
2. Click **New session**, then ask the color question immediately. Compare the answer with the resumed session.
3. Open the `options sent to query()` card. The first run has no `resume`; the second run contains the session ID.
4. Continue the session several times and compare the run count with the number of `result` messages.
5. Inspect the raw stream and find the `system/init.session_id` that the UI uses for the next request.

## Files added or changed

| File | Change |
|---|---|
| `server/concepts/06-sessions.ts` | New route that forwards `resume` to `query()` |
| `server/index.ts` | Mounts the route on `/api/c6` |
| `src/concepts/Concept06Sessions.tsx` | Multi-turn session UI |
| `src/App.tsx` | Adds the Sessions tab |
| `Tab6-Sessions.md` | This explanation |
