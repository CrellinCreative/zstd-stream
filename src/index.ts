// src/index.ts
import { ZstdCompressor, ZstdDecompressor } from "./compressor.js";
import { initZstd } from "./loader.js";

export interface CompressOptions {
  level?: number; // 1-22, default 3
  onProgress?: (bytesWritten: number) => void;
}

export interface DecompressOptions {
  onProgress?: (bytesWritten: number) => void;
}

type Input = Uint8Array | ReadableStream<Uint8Array>;

let initialized = false;

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await initZstd();
    initialized = true;
  }
}

function isStream(input: Input): input is ReadableStream<Uint8Array> {
  return input && typeof (input as any).getReader === "function";
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function compress(
  input: Input,
  options: CompressOptions = {}
): Promise<Uint8Array> {
  await ensureInit();

  const { level = 3, onProgress } = options;
  const compressor = new ZstdCompressor(level);
  await compressor.init();

  try {
    const chunks: Uint8Array[] = [];
    let totalWritten = 0;

    if (isStream(input)) {
      const reader = input.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          const chunk = compressor.process(value || new Uint8Array(0), done);
          if (chunk.length > 0) {
            chunks.push(chunk);
            totalWritten += chunk.length;
            onProgress?.(totalWritten);
          }
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const chunk = compressor.process(input, true);
      if (chunk.length > 0) {
        chunks.push(chunk);
        totalWritten += chunk.length;
        onProgress?.(totalWritten);
      }
    }

    return concat(chunks);
  } finally {
    compressor.destroy();
  }
}

export async function decompress(
  input: Input,
  options: DecompressOptions = {}
): Promise<Uint8Array> {
  await ensureInit();

  const { onProgress } = options;
  const decompressor = new ZstdDecompressor();
  await decompressor.init();

  try {
    const chunks: Uint8Array[] = [];
    let totalWritten = 0;

    if (isStream(input)) {
      const reader = input.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decompressor.process(value);
          if (chunk.length > 0) {
            chunks.push(chunk);
            totalWritten += chunk.length;
            onProgress?.(totalWritten);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const chunk = decompressor.process(input);
      if (chunk.length > 0) {
        chunks.push(chunk);
        totalWritten += chunk.length;
        onProgress?.(totalWritten);
      }
    }

    return concat(chunks);
  } finally {
    decompressor.destroy();
  }
}

export async function initialize(): Promise<void> {
  await ensureInit();
}
