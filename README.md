# zstd-stream

Simple and efficient Zstandard compression/decompression library for Node.js and browsers using WebAssembly.

## Features

- 🚀 **Simple API** - Just two functions: `compress()` and `decompress()`
- 🌐 **Universal** - Works in Node.js 18+ and modern browsers
- 📦 **ESM Only** - Modern ECMAScript modules
- 🎯 **TypeScript** - Full type definitions included
- 📊 **Progress Tracking** - Optional callbacks for compression/decompression progress
- ⚡ **Streaming** - Efficiently handles large data with automatic chunking
- 🔧 **Zero Config** - Automatic initialization and environment detection

## Installation

```bash
npm install zstd-stream
```

## Quick Start

```typescript
import { compress, decompress } from "zstd-stream";

// Compress data
const data = new TextEncoder().encode("Hello, world!");
const compressed = await compress(data, { level: 3 });

// Decompress data
const decompressed = await decompress(compressed);
const text = new TextDecoder().decode(decompressed);

console.log(text); // "Hello, world!"
```

## API Reference

### `compress(input, options?)`

Compresses data using the Zstandard algorithm.

**Parameters:**

- `input`: `Uint8Array | ReadableStream<Uint8Array>` - Data to compress
- `options`: `CompressOptions` (optional)
  - `level`: `number` (1-22) - Compression level (default: 3)
  - `onProgress`: `(bytesWritten: number) => void` - Progress callback

**Returns:** `Promise<Uint8Array>` - Compressed data

**Example:**

```typescript
// Basic compression
const compressed = await compress(data);

// With options
const compressed = await compress(data, {
  level: 9,
  onProgress: (bytes) => console.log(`Compressed: ${bytes} bytes`),
});

// Compress a stream
const stream = new ReadableStream({
  start(controller) {
    controller.enqueue(chunk1);
    controller.enqueue(chunk2);
    controller.close();
  },
});
const compressed = await compress(stream);
```

### `decompress(input, options?)`

Decompresses Zstandard-compressed data.

**Parameters:**

- `input`: `Uint8Array | ReadableStream<Uint8Array>` - Compressed data
- `options`: `DecompressOptions` (optional)
  - `onProgress`: `(bytesWritten: number) => void` - Progress callback

**Returns:** `Promise<Uint8Array>` - Decompressed data

**Example:**

```typescript
// Basic decompression
const decompressed = await decompress(compressed);

// With progress tracking
const decompressed = await decompress(compressed, {
  onProgress: (bytes) => console.log(`Decompressed: ${bytes} bytes`),
});

// Decompress a stream
const decompressed = await decompress(stream);
```

### `initialize()`

Pre-initializes the WASM module (optional). Use this during app startup to avoid initialization delay on first compress/decompress call.

**Returns:** `Promise<void>`

**Example:**

```typescript
// Initialize during app startup
await initialize();

// Now compress/decompress calls will be instant
const compressed = await compress(data);
```

## Usage Examples

### Node.js - File Compression

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { compress, decompress } from "zstd-stream";

// Compress a file
const data = await readFile("data.json");
const compressed = await compress(data, { level: 9 });
await writeFile("data.json.zst", compressed);

// Decompress a file
const compressedData = await readFile("data.json.zst");
const decompressed = await decompress(compressedData);
await writeFile("data.json", decompressed);
```

### Browser - Fetch and Decompress

```typescript
import { decompress } from "zstd-stream";

const response = await fetch("data.json.zst");
const compressed = new Uint8Array(await response.arrayBuffer());

const decompressed = await decompress(compressed, {
  onProgress: (bytes) => {
    console.log(`Decompressed: ${(bytes / 1024).toFixed(2)} KB`);
  },
});

const json = JSON.parse(new TextDecoder().decode(decompressed));
```

### Streaming Large Files (Node.js)

```typescript
import { createReadStream } from "node:fs";
import { compress } from "zstd-stream";

// Convert Node.js stream to Web stream
const nodeStream = createReadStream("huge-file.json");
const webStream = ReadableStream.from(nodeStream);

const compressed = await compress(webStream, {
  level: 6,
  onProgress: (bytes) => console.log(`Progress: ${bytes} bytes`),
});
```

### Real-time Compression with Progress Bar

```typescript
import { compress } from "zstd-stream";

async function compressWithProgress(data: Uint8Array) {
  let lastUpdate = Date.now();

  const compressed = await compress(data, {
    level: 5,
    onProgress: (bytes) => {
      const now = Date.now();
      if (now - lastUpdate > 100) {
        // Update every 100ms
        const ratio = ((bytes / data.length) * 100).toFixed(1);
        console.log(`Compressed: ${bytes} bytes (${ratio}% ratio)`);
        lastUpdate = now;
      }
    },
  });

  return compressed;
}
```

## Compression Levels

| Level | Speed     | Compression | Use Case                       |
| ----- | --------- | ----------- | ------------------------------ |
| 1-3   | Fast      | Lower       | Real-time, network transfer    |
| 3-7   | Medium    | Balanced    | General purpose (default: 3)   |
| 8-15  | Slow      | Better      | File storage                   |
| 16-22 | Very slow | Maximum     | Archival, one-time compression |

## Browser Compatibility

**Minimum Requirements:**

- Chrome/Edge 80+
- Firefox 113+
- Safari 16.4+
- Node.js 18+

**Required APIs:**

- WebAssembly
- `DecompressionStream` (for gzip)
- ES2022 features

## Performance Tips

1. **Pre-initialize**: Call `initialize()` during app startup
2. **Choose appropriate level**: Level 3 is optimal for most use cases
3. **Use streams**: For files >10MB, use ReadableStream to reduce memory
4. **Avoid small chunks**: When streaming, use chunks of at least 64KB for efficiency

## Error Handling

```typescript
try {
  const compressed = await compress(data);
} catch (error) {
  if (error.message.includes("Compression level")) {
    // Invalid compression level
  } else if (error.message.includes("not initialized")) {
    // Initialization failed
  } else if (error.message.includes("Compression failed")) {
    // Compression error
  }
}
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import type { CompressOptions, DecompressOptions } from "zstd-stream";

const options: CompressOptions = {
  level: 9,
  onProgress: (bytes) => console.log(bytes),
};
```

## ESM Only

This package is ESM-only and requires:

- Node.js 18+ (with `"type": "module"` in package.json)
- Modern bundlers (Vite, Rollup, Webpack 5+)

For CommonJS projects, use dynamic import:

```javascript
// CommonJS
const { compress } = await import("zstd-stream");
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Credits

Built on [Zstandard](https://github.com/facebook/zstd) by Meta.
