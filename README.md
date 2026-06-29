<div align="center">

# zstd-stream

**Streaming Zstandard compression for Node.js and browsers — zero external dependencies, bounded memory.**

[![npm version](https://img.shields.io/npm/v/zstd-stream.svg)](https://www.npmjs.com/package/zstd-stream)
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
- 🌍 **Universal** — the same code runs in Node.js 18+ and modern browsers
- 🔧 **ESM + TypeScript** — full type definitions included
- 📊 **Progress callbacks** — observe bytes processed in real time

---

## Installation

```bash
npm install zstd-stream
```

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
  cannot outrun a slow consumer and pile up in memory.
- **Tunable buffering** — `highWaterMark` (bytes) sets how much output may queue
  before reads pause. Larger values trade memory for throughput.

The one-shot `compress` / `decompress` helpers, by contrast, hold the entire
input and output in memory — use them only for small data.

---

## API reference

All functions are async and lazily initialize the WASM module on first use.

### `compressStream(input, options?)`

Compress a stream. The primary API.

- `input: ReadableStream<Uint8Array>`
- `options?: CompressOptions`
  - `level?: number` — compression level 1–19 (default: `3`)
  - `onProgress?: (bytesWritten: number) => void` — cumulative compressed bytes
  - `highWaterMark?: number` — output bytes buffered before backpressure pauses the source (default: 1 MiB)

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
cost more time and memory; "ultra" levels 20–22 are intentionally excluded
because, in streaming mode, they force every decompressor to allocate a 128 MB
window — even for tiny inputs.

Out-of-range values are clamped to the nearest valid level (with a
`console.warn`) rather than throwing — e.g. `level: 22` runs as `19`.

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
| Chrome/Edge | 80      |
| Firefox     | 113     |
| Safari      | 16.4    |

Requires WebAssembly and ES2022 support.

---

## License

MIT

Built with [Zstandard](https://github.com/facebook/zstd) by Meta, compiled with
the [Emscripten SDK](https://emscripten.org/) and embedded for zero-dependency
deployment.
