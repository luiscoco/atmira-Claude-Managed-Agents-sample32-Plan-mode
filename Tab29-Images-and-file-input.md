# Images & file input

This file explains Concept 29 (**Images & file input**) of the Claude Agent SDK Lab. The model can read **images**,
**PDFs** and **text documents**. They reach it in three ways: as **content blocks** your code writes, as **files on
disk** the agent opens itself, and as the **result of a tool**. Claude Code sits between your blocks and the API, and
it changes some of them. This concept shows each way in, what really reaches the API, and what it costs.

**Goal:** know how to send a file to `query()`, which way is cheapest for each case, and which surprises to expect:
resized images, silently replaced bytes, lost citations, and an `@file.pdf` that attaches nothing.

Concept 12 already sent **one** image block through streaming input. This concept covers the rest: PDFs, text
documents, URLs, citations, `Read`, `@file`, images from tools, and what Claude Code does to all of them.

| Concept | Topic | Routes |
|---|---|---|
| 29 | Images & file input: `image` / `document` blocks (base64, `text`, `url`), `title`, `context`, `citations`, Claude Code's rewrites, `Read` on images and PDFs (`tool_use_result`, `isSynthetic`, `pages`), `@file`, an MCP tool that returns an image, token costs, a wire tap | `/api/c29/files`, `/file/:name`, `/inline` (SSE), `/upload` (SSE), `/disk` (SSE), `/code` |

**Files touched:**

| File | Change |
|---|---|
| `server/concepts/29-make-files.ts` | **New**: a tiny PNG encoder with a 5×7 bitmap font, a tiny PDF writer, and the lab's files |
| `server/concepts/29-images-files.ts` | **New**: the block builders, the wire tap, the image tool, the message relay, the routes |
| `server/index.ts` | Mounts the router on `/api/c29` |
| `src/concepts/Concept29ImagesFiles.tsx` | **New**: the tab (Parts A to D) and the upload form |
| `src/App.tsx` | Adds the tab |
| `src/styles.css` | Block rows, wire rows, file chips |
| `.gitignore` | Ignores `files-lab/` |
| `Tab1-query().md` | Adds Concept 29 to the table |

---

## Step 1: Three ways in

| Way | Who puts the file in the conversation | You write |
|---|---|---|
| **Content blocks** | Your code | An `SDKUserMessage` whose `message.content` is an array of blocks |
| **Files on disk** | The model (with `Read`) or Claude Code (for `@file`) | A plain string prompt |
| **Tool results** | Your custom tool | `{ type: "image", data, mimeType }` in the tool's `content` |

A **string prompt holds text only**. To send blocks, use streaming input (Concept 12), even for a single message:

```ts
async function* oneMessage(content: Block[]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}
for await (const msg of query({ prompt: oneMessage(blocks), options })) { ... }
```

## Step 2: The lab's files, made by the server

The lab downloads nothing. `29-make-files.ts` draws its own PNGs (with a 5×7 bitmap font) and writes its own PDF.
**Each file holds a fact that is only inside it**, so a right answer proves the model read the file:

| File | What is inside |
|---|---|
| `card.png` (400×240) | “ORDER #4721”, “CODE: KESTREL”, a red circle, a green square, a blue triangle |
| `big.png` (2400×1440) | The same card, 6× larger |
| `chart-2026.png`, `chart-2027.png` | Bar charts with no numbers: the model must compare the bars |
| `invoice.pdf` (3 pages) | Invoice INV-2026-0917, total 1,284.50 EUR; page 3: “The delivery password is HERON” |
| `invoice.txt` | The same invoice as plain text |
| `policy.txt` | A 4-rule returns policy (for citations) |
| `noisy.png` (~11 MB) | Random pixels with the order number on a white band. Made on first use |

## Step 3: The content blocks

These are Messages API blocks. The SDK passes them on as they are:

```ts
// Image, base64
{ type: "image", source: { type: "base64", media_type: "image/png", data } }
// Image, URL: the API downloads it
{ type: "image", source: { type: "url", url } }
// PDF, base64 (or source: { type: "url", url })
{ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: "invoice.pdf" }
// Plain text as a document: title and context help the model; citations let it cite
{ type: "document", source: { type: "text", media_type: "text/plain", data }, title, context, citations: { enabled: true } }
```

Put the file **before** the question. To refer to several images, put a label before each one (“Image 1:”,
“Image 2:”).

## Step 4: A wire tap, to see what reaches the API

What you send is not always what the API receives. To see the difference, the lab sets
`ANTHROPIC_BASE_URL = http://127.0.0.1:<port>/w/<run id>`. That points at a small proxy, similar to Concept 28's
fault proxy but without faults. It forwards every request and reports the **new user messages** of each main-loop
request. It also reads the API's raw answer for citations. The tab shows its rows in green:
`wire → API` and `wire ← API`.

Each block row shows its kind and size. For images it also shows the pixels and **≈ tokens**:
`width × height / 750`, computed after the API's own downscale (long edge ≤ 1568 px, about 1.15 megapixels).

The wire also shows what Claude Code adds to **every** first message: three `<system-reminder>` text blocks
(environment, model, date), shown faded. They explain why even “Reply with OK” costs about 240 input tokens.

## Step 5: Part A, content blocks (scenarios 0 to 11)

All numbers were measured with Haiku 4.5:

| # | Scenario | What happened | Input tokens |
|---|---|---|---|
| 0 | Text only | The baseline | 240 |
| 1 | One image, 400×240 | Unchanged on the wire; the model read the order number, the code word and the shapes | 393 |
| 2 | Two labelled images | Each image costs its own ~128 tokens; Q3 and Q4 | 533 |
| 3 | PDF, base64 | The API reads each page as text **and** as an image; cached by Claude Code | 5,106 (cache write) |
| 4 | The same invoice as text | Same answer | 489 |
| 5 | Citations | See Step 6 | 1,026 |
| 6 | URL image + URL PDF | Only the URLs go on the wire; the API downloads them | 1,975 |
| 7 | URL on upload.wikimedia.org | `API Error: 400 Unable to download the file`, an error result, a throw (like Concept 28) | 0 |
| 8 | PNG sent as `image/jpeg` | Claude Code reads the real type from the bytes: the wire shows `image/png` | 381 |
| 9 | Bytes that are not an image | Replaced by a text block: “[Image could not be processed …]”. **No error** | 287 |
| 10 | 2400×1440 image | Resized to 2000×1200, plus a text block with a coordinate note | 1,786 |
| 11 | 11 MB image | Re-encoded as a 487 KB JPEG, 2000×1385 (the API limit is 5 MB) | 1,833 |

Lessons:

- **A PDF costs about 10× the same text** (scenarios 3 and 4). When you already have the text, send the text. Send a
  PDF when its layout, tables or images matter.
- **Claude Code fixes some mistakes and hides others.** A wrong `media_type` just works. Bytes that are not an image
  become a note, and the result says `is_error: false`. If the file matters, check it yourself before you send it.
- **Big images are downsized twice**: first by Claude Code (to 2000 px), then by the API (to about 1.15 MP). The note
  “Multiply coordinates by 1.20” is for tasks that need pixel positions (clicks, boxes).
- **More pixels were not better.** Scenario 10 cost 12× the small card, and in every test run the model misread the
  order number (1721, 3721, 13721…). The 400×240 card was read right every time. Send the smallest image that still
  shows what matters.

## Step 6: Citations, and what the SDK drops

With `citations: { enabled: true }`, the API splits the answer into text blocks and attaches citations to the ones
that quote the document. The wire tap sees them in the raw answer:

```
wire ← API   2 citations in the raw answer
  char_location: “Customers may return unused items within 45 days of delivery.”
  char_location: “Items on clearance sale can only be exchanged, never refunded.”
```

But the SDK's assistant messages arrive like this:

```
assistant  citations: []   You have 45 days from delivery to return unused items.
assistant                  However,
assistant  citations: []   items on clearance sale can only be exchanged, never refunded.
```

The text is split in the right places, but the `citations` arrays are **empty**. With SDK 0.3.281, you cannot get
citations through `query()`. If you need them, call the Messages API directly (Concept 24).

## Step 7: Part B, files the agent opens itself

No blocks in your code: a string prompt, and the file comes through a tool.

| Scenario | What happened | Input tokens |
|---|---|---|
| `Read card.png` | `tool_result` holds an **image** block. The SDK also gives `tool_use_result: { type: "image", file: { originalSize, dimensions } }` | 3,141 |
| `Read big.png` | `dimensions`: original 2400×1440 → display 2000×1200, and a user message with `isSynthetic: true` holding the coordinate note | 4,546 |
| `Read invoice.pdf` | `tool_result` = a text line “PDF file read: invoice.pdf (1.9KB)” + a **document** block; `tool_use_result.type: "pdf"` | 7,884 |
| `Read pages: "3"` | `is_error`: “pdftoppm is not installed”. The model then read the whole PDF instead, so it paid for both calls | 9,743 |
| `@card.png` (no tools) | Before the turn, Claude Code runs `Read` itself and attaches the image. The wire shows “Called the Read tool …” and then the image | 459 |
| `@invoice.pdf` (no tools) | Only the text “PDF file read: invoice.pdf (1.9KB)” is attached, **not** the document. The model says it cannot see it | 391 |
| A tool returns an image | The MCP content `{ type: "image", data, mimeType }` becomes an Anthropic image block in the `tool_result` | 1,960 |

Lessons:

- **`Read` costs more than a block.** It takes two turns, and `Read`'s tool definition is in every request. Use it
  when the **model** should decide which file to open. When your code already knows the file, send a block.
- **`@image.png` is the cheapest way to send a local image**: no streaming input and no base64 in your code. It does
  not work for PDFs.
- **`pages` needs poppler** (`pdftoppm`) on the machine where Claude Code runs. Without it, the page range fails and
  the model falls back to the whole file.
- **`tool_use_result`** is the tool's full output object, on the user message that carries the `tool_result`. For `Read`, it tells
  you the file type, its size, and whether the image was resized, with no need to parse the `tool_result`.

## Step 8: An image returned by a tool

```ts
tool("render_chart", "Renders the sales chart of a year as a PNG image.", { year: z.enum(["2026", "2027"]) }, async ({ year }) => ({
  content: [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },   // MCP's shape, not Anthropic's
    { type: "text", text: `Sales chart ${year} rendered (400×240).` },
  ],
}));
```

This is how a tool can show the model a screenshot, a chart or a scanned page. Mind the shape: MCP's `{ data, mimeType }`,
not Anthropic's `{ source: { … } }`. Claude Code converts it.

## Step 9: Your own file

The form under Part A reads a file with `FileReader.readAsDataURL()` and posts `{ name, media_type, data, question }`.
The server turns it into one block (`image`, a PDF `document`, or a `text` document) plus your question. The body is
checked with a strict zod schema, which accepts six media types. The JSON limit is 10 MB (`server/index.ts`), so the
tab refuses files over 7 MB (base64 adds a third).

## Step 10: Part D, which way to choose

| You have | Send it as | Why |
|---|---|---|
| An image your code already has | An `image` block (or `@file.png` for a local file) | Cheapest: one turn |
| Text (from a PDF, a web page, a database) | A `text` document with `title` | About 10× cheaper than the PDF |
| A PDF whose layout matters | A PDF `document` block | The model sees each page as an image too |
| A public URL | A `url` source | No bytes in your code (some hosts refuse the API) |
| Files the model should choose | `tools: ["Read"]` | The model decides; it costs more turns |
| An image your tool makes | An MCP `image` in the tool's content | The model sees it in the `tool_result` |

## How to try it

1. `npm run dev`, then open the **29. Images & file input** tab. `ANTHROPIC_API_KEY` must be in `.env`.
2. Press **0 · Text only**, then **1 · One image**, and compare the input tokens (240 and 393).
3. Press **3 · PDF** and then **4 · The same invoice as text**: the same answer, for 10× fewer tokens.
4. Press **5 · Citations**: compare the green `wire ← API` row with the `citations: []` of the assistant rows.
5. Press **9 · Bytes that are not an image**: see the text block that replaced it, and the result with no error.
6. In Part B, press **@card.png** and then **@invoice.pdf**, and compare what the wire attached.
7. Send a photo of your own with the form, and watch whether Claude Code resizes it.

Each run costs $0.015 or less. The PDF runs are the most expensive.
