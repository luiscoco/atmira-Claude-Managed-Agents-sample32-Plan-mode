# Errors, retries & recovery

This file explains how Concept 28 (**Errors, retries & recovery**) was added to the Claude Agent SDK Lab. A run can
fail in three places: the **API**, the **run** and the **process**. Each failure reaches your code in a different
shape. Claude Code retries some of them before you see anything. Some are only information for the model. Others end
the run and make `for await` throw. This concept makes each failure happen on purpose, shows exactly what arrives, and
runs a `classify()` function that decides what the host should do.

**Goal:** know which failures Claude Code retries by itself (and how to tune that), what a failed run looks like
(the synthetic message, the `StopFailure` hook, the `is_error` result, the throw), and how to recover: wait and
**resume the same session**, raise a limit, or stop and fix the configuration.

Concepts 2 and 15 already showed `maxTurns` and `maxBudgetUsd` as **limits**. Concept 10 showed `interrupt()` and
`abort()`. This concept is about the **failures**, and about what your code does next.

| Concept | Topic | Routes |
|---|---|---|
| 28 | Errors, retries & recovery: a fault proxy at `ANTHROPIC_BASE_URL`, `system/api_retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`), `CLAUDE_CODE_MAX_RETRIES`, `retry-after`, `API_TIMEOUT_MS`, `fallbackModel` + `system/model_fallback`, the synthetic assistant message (`model: "<synthetic>"`, `error: SDKAssistantMessageError`), the `StopFailure` and `PostToolUseFailure` hooks, `result.is_error` vs `subtype`, `terminal_reason`, the iterator's throw, `error_max_turns` + `resume`, `AbortError` vs `interrupt()`, startup failures, a host-side `classify()` and retry-by-resume | `/api/c28/api` (SSE), `/run` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/28-errors-retries.ts` | **New**: the fault proxy, the options, `classify()`, the message relay, the host's retry-by-resume, the `/api` and `/run` routes |
| `server/index.ts` | Mounts the router on `/api/c28` |
| `src/concepts/Concept28ErrorsRetries.tsx` | **New**: the tab (Parts A to D) and the fault-plan editor |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Proxy, retry and verdict rows |
| `.gitignore` | Ignores `errors-lab/` |
| `Tab1-query().md` | Adds Concept 28 to the table |
| `Tab28-Errors-retries-and-recovery.md` | This explanation |

---

## Step 1: Three places a run can fail

| Where | Examples | Who sees it first |
|---|---|---|
| **API** | 529 overloaded, 429 rate limit, 500, 401, 400, 404 model, a dropped connection, a request that never answers | Claude Code, which may retry it |
| **Run** | A tool fails or is denied, `maxTurns`, `maxBudgetUsd`, `interrupt()`, `abort()` | The model (tool errors) or your code (limits, stops) |
| **Process** | Claude Code cannot start: a wrong executable, a missing `cwd` | Your code: `for await` throws before any message |

## Step 2: The lab: a fault proxy

Real API errors are rare and hard to cause on demand. So the lab points Claude Code at a small proxy:

```ts
env.ANTHROPIC_BASE_URL = "http://127.0.0.1:<port>/f/<run id>";   // one prefix per run: its own fault plan and log
```

The proxy listens on `127.0.0.1` only. It forwards every request to the real API (or to your own
`ANTHROPIC_BASE_URL`, if the server has one), except the ones its **fault plan** says to fail:

| Fault | What the proxy does |
|---|---|
| `529`, `429`, `500`, `401`, `400` | Answers with that status and an Anthropic error body (`overloaded_error`, `rate_limit_error`…). A 429 can carry `retry-after` |
| `drop` | Closes the socket without an answer |
| `hang` | Accepts the request and never answers |

The plan is a list, used one fault per request, in order. After the list, the proxy forwards, or (`repeatLast`)
keeps failing with the last fault. `onlyPrimary` fails only the requests for the primary model, so a fallback model can
get through.

**A side call.** Each run makes **two** `/v1/messages` requests: the main loop, and a small side call whose user
text starts with `<session>`. The first probe put its fault on the side call by mistake, and the run just worked.
The proxy now skips the side call. The tab shows it faded. It is still paid for: that is the ~$0.001 in the
`total_cost_usd` of runs whose main request never succeeded.

The route body is checked with a strict zod schema: `{ "faults": ["418"] }` and `{ "model": "opus" }` are refused
before anything runs.

## Step 3: Claude Code retries by itself (scenarios 1 to 3)

Scenario 1 fails the first two main-loop requests with 529:

```
proxy        request 1   injected 529
system/api_retry  attempt 1/10 · error_status 529 · error: overloaded · retry_delay_ms 551
proxy        request 2   injected 529
system/api_retry  attempt 2/10 · error_status 529 · error: overloaded · retry_delay_ms 1171
proxy        request 3   forwarded → 200
result       success · is_error: false
```

Your code did nothing. Each retry is announced by a `system/api_retry` message:

```ts
type SDKAPIRetryMessage = {
  type: "system"; subtype: "api_retry";
  attempt: number; max_retries: number; retry_delay_ms: number;
  error_status: number | null;          // null when there was no HTTP answer
  error: SDKAssistantMessageError;      // "overloaded" | "rate_limit" | "server_error" | "authentication_failed" | "unknown" | …
};
```

| Scenario | Result |
|---|---|
| 1 · 529 twice | 2 × `api_retry`, delays ~0.5 s and ~1 s (exponential, with jitter), then success |
| 2 · 429 with `retry-after: 3` | 1 × `api_retry` with `retry_delay_ms: 3000` exactly: the header wins over the backoff |
| 3 · Dropped connection | 1 × `api_retry` with `error_status: null`, `error: "unknown"`, then success |

Use `api_retry` to show "retrying…" in your UI. You do not need to retry these yourself.

## Step 4: When the retries run out (scenario 4)

`CLAUDE_CODE_MAX_RETRIES` sets how many retries Claude Code makes (the default is **10**). With 500 on every request
and `CLAUDE_CODE_MAX_RETRIES=2`:

```
api_retry     attempt 1/2 · 500 · server_error
api_retry     attempt 2/2 · 500 · server_error
assistant     error: server_error · model: <synthetic> · "API Error: 500 … usually temporary — try again in a moment…"
StopFailure hook   error: server_error
result        subtype: "success" · is_error: true · terminal_reason: "api_error" · stop_reason: "stop_sequence"
for await threw    Error: Claude Code returned an error result: API Error: 500 …
```

Four things to learn from this:

1. **The failure is an assistant message.** Claude Code writes a **synthetic** assistant message (`message.model` is
   `"<synthetic>"`) with the error text and a machine-readable `error` field. That field is the error code to act on.
2. **`subtype: "success"` does not mean success.** The result's subtype is `success`, but `is_error` is `true` and
   `terminal_reason` is `api_error`. Always check `is_error`.
3. **Then the iterator throws.** After a failed last result, `for await` throws
   `Claude Code returned an error result: …` (the same pattern as `maxTurns` in Concept 2). The thrown `Error` carries
   only the text. So **read the result and the synthetic message before the throw**, and classify from them.
4. **The `StopFailure` hook** runs when a turn ends because of an API error. Its input has `error` (the same code),
   `error_details` and `last_assistant_message`. It is a good place for logging and alerts.

With `CLAUDE_CODE_MAX_RETRIES=0` there is no retry at all: the first 529 fails the run at once. The 529 case also
shows that the retry messages say `overloaded`, but the final synthetic message says **`server_error`**.

## Step 5: Errors that are not retried (scenarios 5, 8, 9)

| Scenario | Retried? | Synthetic `error` |
|---|---|---|
| 5 · 400 `invalid_request_error` | **no**, no `api_retry` at all | `unknown` (the text starts `API Error: 400`) |
| 8 · 401 on every request | **yes**, up to the limit (a token may refresh) | `authentication_failed` |
| 9 · model `claude-no-such-model` (a real 404, no fault) | no | `model_not_found` ("There's an issue with the selected model…") |

The 401 is a surprise: Claude Code retries it, because an OAuth token can be refreshed between tries. With a wrong
API key those retries only add delay.

The 400 is tagged `unknown`, the same code as a dropped connection. So `classify()` also reads the HTTP status from
the synthetic text (`API Error: 400`). The first version of `classify()` did not, and it told the host to retry a 400.

## Step 6: A request that never answers (scenario 6)

In the probe, a request that never got an answer made the run wait about **6 minutes** (360 s) before its first
retry. Setting `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS=3000` did **not** shorten that wait. `API_TIMEOUT_MS` did:

```
env: { API_TIMEOUT_MS: "4000", CLAUDE_CODE_MAX_RETRIES: "1" }

 0.8 s  proxy      request 1   never answers
 4.8 s  api_retry  attempt 1/1 · error_status: null · error: unknown
 5.4 s  proxy      request 2   never answers
 9.4 s  assistant  error: server_error · "Request timed out"
```

**Rule:** a host that must answer a user in bounded time sets `API_TIMEOUT_MS`. The total wait is about
`API_TIMEOUT_MS × (retries + 1)` plus the backoff. The lab sets 5000 by itself when the plan contains `hang`.

## Step 7: `fallbackModel` (scenario 7)

```ts
{ model: "claude-haiku-4-5-20251001", fallbackModel: "claude-sonnet-4-5" }
```

With 529 on every **Haiku** request (`onlyPrimary`):

```
api_retry  attempt 1 · overloaded
api_retry  attempt 2 · overloaded
proxy      request 3   injected 529
system/model_fallback  trigger: overloaded · claude-haiku-4-5-20251001 → claude-sonnet-4-5
                       "Switched to Sonnet 4.5 due to high demand for Haiku 4.5"
proxy      request 4   claude-sonnet-4-5 → 200
result     success · modelUsage: claude-haiku-4-5-20251001, claude-sonnet-4-5
```

After **three** overloaded answers in a row, Claude Code switches model and sends `system/model_fallback`. That
message is **not** in `sdk.d.ts` (0.3.281). The lab reads its fields as sent: `trigger`, `original_model`,
`fallback_model`, `content`. The fallback model gets its own fresh retry budget. According to the option's comment,
the primary model is tried again at the start of each user turn. The fallback costs more here (Sonnet), which is the
price of staying up.

## Step 8: Tool errors do not end the run (Part B · Tool errors)

```
tool_use Read missing.txt
PostToolUseFailure hook   Read: File does not exist. … is_interrupt: false
tool_result  is_error     File does not exist.
tool_use Bash dir
tool_result  is_error     Denied by the lab: only Read inside errors-lab/work.
tool_use Read a.txt   →   alpha
result       success · is_error: false · num_turns 4 · permission_denials 1
```

A failed or denied tool call becomes a `tool_result` with `is_error: true`, and the **model** decides what to do
next. `PostToolUseFailure` runs for tools that fail. It did **not** run for the call that `canUseTool` denied: that one
is counted in `result.permission_denials` instead. **A tool error is information for the model, not an exception for
you.**

## Step 9: Recovery by resume (scenario 10 and Part B · maxTurns)

A failed `query()` has still saved its session (`persistSession: true`, the transcript goes to the lab's
`CLAUDE_CONFIG_DIR`). **Resuming** it is the safe retry: the model keeps everything done so far, and nothing is done
twice.

**`maxTurns` → resume with a larger limit.** `maxTurns: 1` stops the run after the first tool round:
`error_max_turns`, `errors: ["Reached maximum number of turns (1)"]`, then the throw. The host resumes the same session
with `maxTurns: 6` and "Continue where you stopped". The model gives `alpha-bravo` without reading the files again.

**A long outage → wait, then resume.** Scenario 10 fails three requests with 529 and allows only one Claude Code
retry. So the first `query()` fails after two requests. The host's own retry takes over:

```ts
// #region recovery (simplified)
let out = await runOnce(prompt, make({}), emit);
for (let attempt = 1; attempt <= hostRetries && out.verdict.retry === "resume" && out.sessionId; attempt++) {
  await sleep(2000 * attempt);
  out = await runOnce("Continue.", make({ resume: out.sessionId }), emit);
}
```

```
query 1:  request 1 529 → api_retry → request 2 529 → synthetic server_error → throw → classify: resume
host retry 1/2: wait 2000 ms, query({ resume })
query 2:  request 3 529 → api_retry → request 4 → 200 → "Noted, code word PELICAN."
```

The failed turn's prompt (**"My code word is PELICAN…"**) was already in the transcript, so the resumed prompt only
says `Continue.`, and the model still knows the code word. The first version said "Continue: answer my previous
message", and the model added a strange second paragraph about "your previous message". A plain `Continue.` fixed it.

Two layers of retry, then: Claude Code retries **one request** within seconds. The host retries **the turn**, later,
and only when `classify()` says the error can heal.

## Step 10: `abort()` vs `interrupt()` (Part B)

| Case | What happened (SDK 0.3.281) |
|---|---|
| `abortController.abort()` at 1.5 s | The poem was **still written and paid for**. The `result` arrived at 4.9 s, and **then** `for await` threw `AbortError: Operation aborted` |
| `q.interrupt()` at 1.5 s (streaming input) | The turn stopped **at once**: `error_during_execution`, `terminal_reason: aborted_streaming`, `$0`. Then the input stream was closed |

The probe tried both a string prompt and streaming input: `abort()` let the running turn finish in both cases.
**Concept 10 saw `abort()` kill the process at once** with an older SDK version. So do not count on `abort()` to stop
spending. To stop **now**: `await q.interrupt()`, then close the input (or `q.close()`), then abort if you must.

`abort()` throws an `AbortError`, which the SDK exports. `classify()` checks `err instanceof AbortError`: an abort is
never retried. The interrupted result's `errors` holds a diagnostic string (`[ede_diagnostic] result_type=user …`),
not a real error.

## Step 11: The process does not start (Part B)

| Case | What happens |
|---|---|
| `pathToClaudeCodeExecutable` points to a missing file | `for await` throws a `ReferenceError` at once: "Claude Code native binary not found at …" |
| `cwd` points to a missing folder | The same kind of throw, but the message is **misleading**: "native binary … exists but failed to launch. This usually means the binary does not match this system's libc" |

There is no message and no result: only the throw. Check that `cwd` exists yourself before calling `query()`.
`CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` (which, per the types, turns known startup failures into a result with
`startup_failure_reason`) did not help here: the process never got as far as writing anything.

## Step 12: `classify()`: what the host should do

The server runs one function on everything a `query()` call left behind (the last result, the synthetic message's
`error`, the thrown value, the retry count):

| Seen | Verdict | Why |
|---|---|---|
| `AbortError` | `you` · retry: **no** | Your code stopped it |
| A throw and no result | `process` · **fix first** | Claude Code did not start |
| `is_error: false` | `ok` | Noting any retries or fallback that happened |
| `error_max_turns` | `run` · **resume** | Resume with a larger `maxTurns` |
| `error_max_budget_usd` | `run` · **fix first** | Ask the user before spending more |
| `error_during_execution` | `you` · no | An interrupt, not a failure |
| `api_error` + a 4xx status (not 408/429) | `api` · **fix first** | The same request gets the same answer |
| `api_error` + `overloaded` / `rate_limit` / `server_error` / `unknown` | `api` · **resume** | Transient: wait, then resume |
| `api_error` + `authentication_failed` / `billing_error` / `model_not_found` / `invalid_request` | `api` · **fix first** | Fix the key, the account or the model |

The UI shows the verdict as a blue row after each `query()` call.

## Step 13: What the tests changed

- **The proxy's first fault hit the wrong request.** It failed the side call, and the run just worked. The proxy now
  recognises the side call (`<session>`) and skips it.
- **`classify()` told the host to retry a 400**, because a 400 is tagged `unknown`. It now reads the status from the
  synthetic text.
- **`CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` did not shorten a hang** (360 s in the probe). The hang scenario uses
  `API_TIMEOUT_MS`, and the lab sets it by itself when a plan contains `hang`.
- **`abort()` did not stop the turn**, unlike Concept 10. Kept as a lesson, with `q.interrupt()` next to it.
- **The resume prompt** was changed to a plain `Continue.` (Step 9).

## Step 14: The costs

Haiku, one-line prompts. A request that failed at the proxy costs nothing. The side call costs ~$0.001 per run.

| Run | Cost |
|---|---|
| Scenarios 1 to 3, 10 | ~$0.001 each |
| Scenarios 4, 6, 8 (failed runs) | ~$0.001 (only the side call) |
| Scenarios 5, 9 | $0 |
| Scenario 7 (answered by Sonnet) | ~$0.002 |
| Part B · Tool errors, maxTurns | ~$0.01 each |
| Part B · abort (the poem is paid for) | ~$0.003 |
| Part B · interrupt, bad executable, bad cwd | $0 |

## Step 15: Every failure, and what to do (Part D)

| Failure | What your code sees | Claude Code retries? | The host should |
|---|---|---|---|
| 529, 500, dropped connection | `system/api_retry` (`error_status: null` if no answer) | yes, up to `CLAUDE_CODE_MAX_RETRIES` (10) | Nothing. If it still fails: wait, resume |
| 429 | `api_retry`, `retry_delay_ms` = `retry-after` | yes | The same |
| 401 | `api_retry` with `authentication_failed` | yes | Fix the key. Do not retry |
| 400, 404 model | No retry. Synthetic `unknown` / `model_not_found` | no | Fix the request or the model |
| A request that hangs | Nothing, for minutes | only after `API_TIMEOUT_MS` | Set `API_TIMEOUT_MS` |
| Primary model overloaded | `system/model_fallback` after 3 × 529 | yes, on `fallbackModel` | Set `fallbackModel` |
| Retries exhausted | Synthetic assistant → `StopFailure` → result `success` + `is_error`, `api_error` → throw | — | Read the result before the throw; classify |
| Tool fails or is denied | `tool_result` `is_error`, `PostToolUseFailure`, `permission_denials` | the model decides | Nothing |
| `maxTurns` / `maxBudgetUsd` | `error_max_turns` / `error_max_budget_usd` → throw | no | Resume with a larger limit, or ask the user |
| `interrupt()` | `error_during_execution`, `aborted_streaming`, in ms | no | Not a failure |
| `abort()` | `AbortError`, after the running turn ends | no | Interrupt first to stop now |
| Claude Code cannot start | A throw before any message | no | Check `pathToClaudeCodeExecutable` and `cwd` |

## Things to try

1. Build your own plan: `+529 +529 +529 +529`, `CLAUDE_CODE_MAX_RETRIES` 2, host retries 2. Count the requests and
   the `api_retry` rows before the answer arrives.
2. Run scenario 7 without **fail only Haiku requests**: the fallback model fails too, and gets its own retries.
3. Set `CLAUDE_CODE_MAX_RETRIES` to 0 and run scenario 1: one 529 is now fatal.
4. Run `+429` with `retry-after` 10: the retry waits exactly 10 s.
5. Open **code: classify** and add a rule, for example: "`server_error` after the host has already resumed twice →
   fix first".
