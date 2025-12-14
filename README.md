<div align="center">

# zstd-stream

**High-performance Zstandard compression for Node.js and browsers with zero external dependencies**

[![npm version](https://img.shields.io/npm/v/zstd-stream.svg)](https://www.npmjs.com/package/zstd-stream)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-brightgreen.svg)](https://www.typescriptlang.org/)

</div>

---

## Features

- 🚀 **Universal compatibility** - Works seamlessly in Node.js 18+ and modern browsers
- 📦 **Zero external assets** - All WebAssembly code bundled internally, works out of the box
- 🌊 **True streaming support** - Handle multi-GB files with minimal memory footprint
- ⚡ **Backpressure handling** - Efficient memory management prevents overflow
- 🎯 **Client-side optimization** - Reduce server load by compressing/decompressing in the browser
- 🔧 **ESM-first** - Modern ECMAScript modules with full TypeScript support
- 📊 **Progress tracking** - Monitor compression/decompression in real-time

Built on the latest Zstandard v2 compression algorithm, `zstd-stream` is one of the only packages that embeds all WASM code internally, eliminating asset management headaches and enabling true plug-and-play compression.

---

## Demo (Angular)

[![Browser Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://crellincreative.github.io/zstd-stream/)

---

## Installation

```bash
npm install zstd-stream
```

---

## Usage Examples

### Basic Text Compression

**⚠️ Note:** This method loads all data into memory. For large files (>100MB), use streaming instead.

```typescript
import { compress, decompress } from "zstd-stream";

// Compress text
const text = "Hello, world!";
const input = new TextEncoder().encode(text);
const compressed = await compress(input, { level: 3 });

// Decompress
const decompressed = await decompress(compressed);
const output = new TextDecoder().decode(decompressed);

console.log(output); // "Hello, world!"
```

### Streaming Large Files (Recommended)

**✅ Use this for large files** - Processes data in chunks with constant memory usage.

```typescript
import { compressStream, decompressStream } from "zstd-stream";

// Compress a stream
const textStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("Large text data..."));
    controller.close();
  },
});

const compressedStream = await compressStream(textStream, { level: 5 });

// Decompress a stream
const decompressedStream = await decompressStream(compressedStream);

// Read the result
const reader = decompressedStream.getReader();
let result = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  result += new TextDecoder().decode(value);
}

console.log(result);
```

### Browser: Download Compressed File with StreamSaver.js

**⚠️ Performance Note:** Handle compression via Web Workers for browser deployment to avoid degrading the application's performance!

```typescript
import { compressStream } from "zstd-stream";
import streamSaver from "streamsaver";

// User selects a file
const file = document.querySelector('input[type="file"]').files[0];
const fileStream = file.stream();

// Compress the file
const compressed = await compressStream(fileStream, {
  level: 9,
  onProgress: (bytes) => {
    console.log(`Compressed: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  },
});

// Save to disk as .zst
const fileWriteStream = streamSaver.createWriteStream(`${file.name}.zst`);
const writer = fileWriteStream.getWriter();

const reader = compressed.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  await writer.write(value);
}

await writer.close();
```

### Stream File to Server via HTTP

```typescript
import { compressStream } from "zstd-stream";

// Get file from user input
const file = document.querySelector('input[type="file"]').files[0];
const fileStream = file.stream();

// Compress and upload
const compressed = await compressStream(fileStream, { level: 6 });

const response = await fetch("https://api.example.com/upload", {
  method: "POST",
  headers: {
    "Content-Type": "application/zstd",
    "Content-Encoding": "zstd",
  },
  body: compressed,
  duplex: "half", // Required for streaming request bodies
});

if (response.ok) {
  console.log("Upload complete!");
}
```

---

## API Reference

### `compress(input, options?)`

Compress data in one operation. Best for small files.

**Parameters:**

- `input: Uint8Array` - Data to compress
- `options?: CompressOptions`
  - `level?: number` - Compression level (1-19, default: 3)
  - `onProgress?: (bytesWritten: number) => void` - Progress callback

**Returns:** `Promise<Uint8Array>`

```typescript
const compressed = await compress(data, { level: 9 });
```

### `compressStream(input, options?)`

Compress a readable stream. Best for large files.

**Parameters:**

- `input: ReadableStream<Uint8Array>` - Stream to compress
- `options?: CompressOptions`
  - `level?: number` - Compression level (1-19, default: 3)
  - `onProgress?: (bytesWritten: number) => void` - Progress callback

**Returns:** `Promise<ReadableStream<Uint8Array>>`

```typescript
const compressed = await compressStream(fileStream, { level: 5 });
```

### `decompress(input, options?)`

Decompress data in one operation.

**Parameters:**

- `input: Uint8Array` - Compressed data
- `options?: DecompressOptions`
  - `onProgress?: (bytesWritten: number) => void` - Progress callback

**Returns:** `Promise<Uint8Array>`

```typescript
const decompressed = await decompress(compressed);
```

### `decompressStream(input, options?)`

Decompress a readable stream with backpressure support.

**Parameters:**

- `input: ReadableStream<Uint8Array>` - Compressed stream
- `options?: DecompressOptions`
  - `onProgress?: (bytesWritten: number) => void` - Progress callback

**Returns:** `Promise<ReadableStream<Uint8Array>>`

```typescript
const decompressed = await decompressStream(compressedStream);
```

### `initialize()`

Pre-initialize the WASM module (optional). Call during app startup to avoid initialization delay on first use.

**Returns:** `Promise<void>`

```typescript
await initialize();
```

---

## Compression Levels

Levels 1-19 are supported. Higher levels provide diminishing returns.

| Level | Speed     | Ratio    | Use Case                           |
| ----- | --------- | -------- | ---------------------------------- |
| 1-3   | Fast      | Lower    | Real-time, network streaming       |
| 3-7   | Medium    | Balanced | General purpose (recommended)      |
| 8-15  | Slow      | Better   | File storage, archival             |
| 16-19 | Very slow | Maximum  | One-time compression, cold storage |

**Default level:** 3 (optimal balance of speed and compression)

---

## Browser Compatibility

- Chrome/Edge 80+
- Firefox 113+
- Safari 16.4+
- Node.js 18+

Requires WebAssembly and ES2022 support.

---

## TypeScript

Full type definitions included:

```typescript
import type { CompressOptions, DecompressOptions } from "zstd-stream";

const options: CompressOptions = {
  level: 9,
  onProgress: (bytes) => console.log(`Progress: ${bytes}`),
};
```

---

## License

MIT

---

## Credits

Built with [Zstandard](https://github.com/facebook/zstd) by Meta, compiled using [Emscripten SDK](https://emscripten.org/).

WebAssembly module embedded internally for zero-dependency deployment.
