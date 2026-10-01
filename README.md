<div align="center">

# zstd-stream

**Efficient Zstandard compression for Browsers and Node.js**

[![npm version](https://img.shields.io/npm/v/zstd-stream.svg)](https://www.npmjs.com/package/zstd-stream)
[![install size](https://img.shields.io/badge/install%20size-163%20kB-blue.svg)](https://www.npmjs.com/package/zstd-stream)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-brightgreen.svg)](https://www.typescriptlang.org/)
[![Browser Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://crellincreative.github.io/zstd-stream/)

</div>

---

`zstd-stream` compresses and decompresses [Zstandard](https://github.com/facebook/zstd)
data through the Web Streams API. It streams files larger than available RAM in
**constant memory**, propagates **backpressure** end to end, and ships the
WebAssembly build **embedded** — no `.wasm` asset to host or configure.

- 🌊 **Streaming first** — process multi-GB data in fixed ~128 KB buffers
- ⚡ **Backpressure built in** — a slow writer automatically throttles the reader, so memory never runs away
- 📦 **Zero external assets** — WASM is bundled in; `npm install` and import
- 🛡️ **Integrity checked** — every frame carries a checksum; corrupt or truncated input is rejected
- 🌍 **Universal** — the same code runs in Node.js 18+ and every modern browser
- 🔧 **ESM + TypeScript** — full type definitions included
- 📊 **Progress callbacks** — observe bytes processed in real time

---

## Unrivaled performance

Compressing **1 GB** — `zstd-stream` vs. the browser-capable libraries you'd otherwise reach for:

| Library                             | Compression | Speed        | Memory      | 4 GB+ files |
| :---------------------------------- | ----------: | -----------: | ----------: | :---------: |
| **zstd-stream**                     |    **5.5×** | **147 MB/s** |   **35 MB** |    **✓**    |
| browser gzip (`CompressionStream`)  |        3.5× |     51 MB/s  |       37 MB |      ✓      |
| [zstd-codec](https://npmjs.com/zstd-codec) |  5.5× |     78 MB/s  |      1.6 GB |      ✗      |
| [fflate](https://npmjs.com/fflate)  |        3.3× |     36 MB/s  |      1.6 GB |      ✗      |
| [pako](https://npmjs.com/pako)      |        3.5× |     22 MB/s  |      1.6 GB |      ✗      |
| [@bokuweb/zstd-wasm](https://npmjs.com/@bokuweb/zstd-wasm) | — | — | &gt;2 GB → OOM | ✗ |

Top compression, 2–7× the speed, **~45× less memory** than in-memory libraries, and the only zstd
library that keeps going past a browser tab's ~2 GB `ArrayBuffer` limit.

<sub>Median of 3 runs on 1 GB of log-like data via [`benchmarks/compression-bench.js`](benchmarks/compression-bench.js) (Node 22); ratios depend on your data, memory and scaling don't.</sub>

### Proven at scale

- **4 GB streams** verified byte-for-byte in Chrome, Edge, Firefox, Safari (WebKit) and Node.js — the WASM heap never grew past its initial 32 MB
- **Identical output in every engine**, and it decompresses native zstd output from any level — even the ultra levels it doesn't compress with
- **Corruption caught** — every random bit flip and truncation tested was rejected with an error
- **Small footprint** — 163 kB installed

---

## Installation

```bash
npm install zstd-stream
```

There's also a [live browser demo](https://crellincreative.github.io/zstd-stream/) — a small Angular app that compresses files entirely in the browser, no install required.

---

## Quick start

Everything operates on `ReadableStream<Uint8Array>` — the same stream type
returned by `fetch`, `Blob.stream()`, `File.stream()`, and Node's
`Readable.toWeb()`.

```typescript
import { compressStream, decompressStream } from "zstd-stream";

// Compress any byte stream...
const compressed = await compressStream(source, { level: 3 });

// ...and decompress it back.
const restored = await decompressStream(compressed);

// Collect a stream into bytes (or use .text() for strings):
const bytes = new Uint8Array(await new Response(restored).arrayBuffer());
```

Prefer streaming wherever the data is large or arrives incrementally. For small,
fully in-memory buffers there are one-shot [`compress`](#compressinput-options) /
[`decompress`](#decompressinput-options) helpers.

---

## Recipes

### Compress a file and upload it

Pipe the compressed stream straight into a `fetch` request body — nothing is
buffered in full.

```typescript
import { compressStream } from "zstd-stream";

const file = document.querySelector<HTMLInputElement>("input[type=file]")!.files![0];
const compressed = await compressStream(file.stream(), { level: 6 });

await fetch("/upload", {
  method: "POST",
  headers: { "Content-Encoding": "zstd" },
  body: compressed,
  duplex: "half", // required when streaming a request body
});
```

### Download and decompress

```typescript
import { decompressStream } from "zstd-stream";

const res = await fetch("/data.zst");
const decompressed = await decompressStream(res.body!);

const text = await new Response(decompressed).text();
```

### Save a compressed file to disk (browser)

`pipeTo` drives the whole transfer and applies backpressure for you.

```typescript
import { compressStream } from "zstd-stream";
import streamSaver from "streamsaver";

const compressed = await compressStream(file.stream(), {
  level: 9,
  onProgress: (bytes) => console.log(`${(bytes / 1e6).toFixed(1)} MB written`),
});

await compressed.pipeTo(streamSaver.createWriteStream(`${file.name}.zst`));
```

> **Tip:** compression is CPU-intensive. In the browser, run it inside a Web
> Worker to keep the UI responsive.

### Compress a file on disk (Node.js)

```typescript
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import { compressStream } from "zstd-stream";

const source = Readable.toWeb(createReadStream("big.log")) as ReadableStream<Uint8Array>;
const compressed = await compressStream(source, { level: 6 });

await compressed.pipeTo(Writable.toWeb(createWriteStream("big.log.zst")));
```

### Small, in-memory data

When you already hold the whole payload, skip the streams:

```typescript
import { compress, decompress } from "zstd-stream";

const data = new TextEncoder().encode("Hello, world!");
const compressed = await compress(data, { level: 3 });
const restored = await decompress(compressed);

console.log(new TextDecoder().decode(restored)); // "Hello, world!"
```

---

## Memory & backpressure

The streaming API is built to handle data far larger than available RAM:

- **Bounded memory** — data flows through fixed ~128 KB working buffers and is
  emitted one slice at a time. A compressed chunk that expands to gigabytes is
  never decoded into a single allocation.
- **Backpressure** — output is produced lazily, one slice per read, so a slow
  consumer (disk, network) throttles reads from the source. A fast producer
  cannot outrun a slow consumer and pile up in memory — even for input that
  compresses thousands to one.
- **Tunable buffering** — `highWaterMark` (bytes) sets how far a stream may run
  ahead of its consumer. Larger values trade memory for throughput.
- **Cancel what you don't finish** — each open stream holds a zstd context in
  the shared WASM heap (up to ~90 MB at level 19; the heap is capped at 1.5 GB).
  Reading to the end or calling `cancel()` frees it immediately; a dropped
  stream is only freed whenever the garbage collector gets to it.

The one-shot `compress` / `decompress` helpers, by contrast, hold the entire
input and output in memory — use them only for small data.

## Data integrity

Compressed frames include a content checksum, and decompression verifies it.
Corrupted, truncated, or non-zstd input rejects with an error rather than
yielding partial or wrong output. Cancelling the output stream, or an error
while processing, also cancels the source stream.

---

## API reference

All functions are async and lazily initialize the WASM module on first use.

### `compressStream(input, options?)`

Compress a stream. The primary API.

- `input: ReadableStream<Uint8Array>`
- `options?: CompressOptions`
  - `level?: number` — compression level 1–19 (default: `3`)
  - `onProgress?: (bytesWritten: number) => void` — cumulative compressed bytes
  - `highWaterMark?: number` — source bytes compression may read ahead of the consumer (default: 1 MiB)

**Returns:** `Promise<ReadableStream<Uint8Array>>`

### `decompressStream(input, options?)`

Decompress a stream.

- `input: ReadableStream<Uint8Array>`
- `options?: DecompressOptions`
  - `onProgress?: (bytesWritten: number) => void` — cumulative decompressed bytes
  - `highWaterMark?: number` — output bytes buffered before backpressure pauses the source (default: 1 MiB)

**Returns:** `Promise<ReadableStream<Uint8Array>>`

### `compress(input, options?)`

One-shot compression of an in-memory buffer. Holds all data in memory.

- `input: Uint8Array`
- `options?: CompressOptions` — `level`, `onProgress` (as above)

**Returns:** `Promise<Uint8Array>`

### `decompress(input, options?)`

One-shot decompression of an in-memory buffer. Holds all data in memory.

- `input: Uint8Array`
- `options?: DecompressOptions` — `onProgress` (as above)

**Returns:** `Promise<Uint8Array>`

### `initialize()`

Optional. Pre-loads the WASM module so the first compress/decompress call has no
startup cost. Safe to call multiple times.

**Returns:** `Promise<void>`

```typescript
import { initialize } from "zstd-stream";

await initialize(); // e.g. during app startup
```

---

## Compression levels

Levels **1–19** are supported (default: `3`). Higher levels compress more but
cost more time and memory; "ultra" levels 20–22 are intentionally excluded:
in streaming mode they force every decompressor to allocate a 32–128 MB window
(vs 8 MB at level 19), even for tiny inputs, and need 200 MB–1 GB of WASM heap to
compress, for well under 1% smaller output.

Out-of-range values are clamped to the nearest valid level (with a
`console.warn`) rather than throwing — e.g. `level: 22` runs as `19`.
Decompression is unaffected: data compressed at any level, including 20–22 by
other zstd tools, decompresses normally.

| Level | Speed     | Ratio    | Typical use                   |
| ----- | --------- | -------- | ----------------------------- |
| 1–3   | Fast      | Lower    | Real-time, network streaming  |
| 4–7   | Balanced  | Good     | General purpose (recommended) |
| 8–15  | Slow      | Better   | File storage, archival        |
| 16–19 | Very slow | Maximum  | One-time / cold storage       |

---

## TypeScript

```typescript
import type { CompressOptions, DecompressOptions } from "zstd-stream";

const options: CompressOptions = {
  level: 9,
  highWaterMark: 4 * 1024 * 1024,
  onProgress: (bytes) => console.log(`Progress: ${bytes}`),
};
```

---

## Compatibility

| Environment | Minimum |
| ----------- | ------- |
| Node.js     | 18      |
| Chrome/Edge | 85      |
| Firefox     | 113     |
| Safari      | 16.4    |

Requires WebAssembly and ES2022 support. Pages with a Content Security Policy
must allow `script-src blob: 'wasm-unsafe-eval'` (the embedded module is
loaded from a `blob:` URL and compiled at runtime).

---

## License

MIT

Built with [Zstandard](https://github.com/facebook/zstd) by Meta, compiled with
the [Emscripten SDK](https://emscripten.org/) and embedded for zero-dependency
deployment.
