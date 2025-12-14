import { ZstdCompressor, ZstdDecompressor } from "./compressor.js";
import { initZstd } from "./loader.js";

export interface CompressOptions {
  level?: number; // 1-19, default 3
  onProgress?: (bytesWritten: number) => void;
}

export interface DecompressOptions {
  onProgress?: (bytesWritten: number) => void;
}

let initialized = false;

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await initZstd();
    initialized = true;
  }
}

// Compress Uint8Array -> Uint8Array
export async function compress(
  input: Uint8Array,
  options?: CompressOptions
): Promise<Uint8Array> {
  await ensureInit();
  const { level = 3, onProgress } = options || {};
  const compressor = new ZstdCompressor(level);
  await compressor.init();

  try {
    const result = compressor.process(input, true);
    onProgress?.(result.length);
    return result;
  } finally {
    compressor.destroy();
  }
}

export async function compressStream(
  input: ReadableStream<Uint8Array>,
  options?: CompressOptions
): Promise<ReadableStream<Uint8Array>> {
  await ensureInit();
  const { level = 3, onProgress } = options || {};

  const reader = input.getReader();
  let compressor: ZstdCompressor | null = null;
  let totalWritten = 0;
  let inputDone = false;

  return new ReadableStream<Uint8Array>({
    async start() {
      compressor = new ZstdCompressor(level);
      await compressor.init();
    },

    async pull(controller) {
      try {
        if (inputDone) return;
        let loopIterations = 0;

        // Keep reading until we have data to enqueue or input is exhausted
        while (!inputDone) {
          loopIterations++;
          const { done, value } = await reader.read();

          if (done) {
            // Final flush
            const chunk = compressor!.process(new Uint8Array(0), true);
            if (chunk.length > 0) {
              controller.enqueue(chunk);
              totalWritten += chunk.length;
              onProgress?.(totalWritten);
            }
            controller.close();
            reader.releaseLock();
            compressor?.destroy();
            inputDone = true;
            return;
          }

          // Process chunk
          const chunk = compressor!.process(value, false);
          if (chunk.length > 0) {
            controller.enqueue(chunk);
            totalWritten += chunk.length;
            onProgress?.(totalWritten);
            return; // Exit after enqueuing data
          }
          // If chunk is empty, continue loop to read next input chunk
        }
      } catch (error) {
        inputDone = true;
        reader.releaseLock();
        compressor?.destroy();
        controller.error(error);
      }
    },

    cancel() {
      reader.releaseLock();
      compressor?.destroy();
    },
  });
}

// Decompress Uint8Array -> Uint8Array
export async function decompress(
  input: Uint8Array,
  options?: DecompressOptions
): Promise<Uint8Array> {
  await ensureInit();
  const { onProgress } = options || {};
  const decompressor = new ZstdDecompressor();
  await decompressor.init();

  try {
    const result = decompressor.process(input);
    onProgress?.(result.length);
    return result;
  } finally {
    decompressor.destroy();
  }
}

// Decompress ReadableStream -> ReadableStream with backpressure
export async function decompressStream(
  input: ReadableStream<Uint8Array>,
  options?: DecompressOptions
): Promise<ReadableStream<Uint8Array>> {
  await ensureInit();
  const { onProgress } = options || {};

  const reader = input.getReader();
  let decompressor: ZstdDecompressor | null = null;
  let totalWritten = 0;
  let inputDone = false;

  return new ReadableStream<Uint8Array>({
    async start() {
      decompressor = new ZstdDecompressor();
      await decompressor.init();
    },

    async pull(controller) {
      try {
        if (inputDone) {
          return; // Already finished
        }

        const { done, value } = await reader.read();

        if (done) {
          inputDone = true;
          controller.close();
          reader.releaseLock();
          decompressor?.destroy();
          return;
        }

        const chunk = decompressor!.process(value);

        if (chunk.length > 0) {
          controller.enqueue(chunk);
          totalWritten += chunk.length;
          onProgress?.(totalWritten);
        }
      } catch (error) {
        inputDone = true;
        reader.releaseLock();
        decompressor?.destroy();
        controller.error(error);
        throw error;
      }
    },

    cancel() {
      reader.releaseLock();
      decompressor?.destroy();
    },
  });
}

export async function initialize(): Promise<void> {
  await ensureInit();
}
