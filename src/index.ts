import { ZstdCompressor, ZstdDecompressor } from "./compressor.js";
import { initZstd } from "./loader.js";

export interface CompressOptions {
  level?: number; // 1-19, default 3
  onProgress?: (bytesWritten: number) => void;
  /**
   * How far (in source bytes) compression may run ahead of the consumer
   * before backpressure pauses reading the source. Larger values trade
   * memory for throughput. Default: 1 MiB.
   */
  highWaterMark?: number;
}

export interface DecompressOptions {
  onProgress?: (bytesWritten: number) => void;
  /**
   * Max bytes of output buffered before backpressure pauses reading the
   * source. Larger values trade memory for throughput. Default: 1 MiB.
   */
  highWaterMark?: number;
}

const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;

// Frees WASM memory of output streams dropped without being read to the end
// or cancelled. Best effort: GC timing is not tied to WASM heap pressure.
const finalizer = new FinalizationRegistry<{ destroy(): void }>((p) => p.destroy());

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
  const { level = 3, onProgress, highWaterMark = DEFAULT_HIGH_WATER_MARK } =
    options || {};

  const compressor = new ZstdCompressor(level);
  await compressor.init();
  // Lock the source only once init has succeeded, so a failed init leaves it usable.
  const reader = input.getReader();

  let chunk: Uint8Array | null = null; // current source chunk
  let chunkPos = 0; // bytes of `chunk` already fed
  let finishing = false; // source drained, flushing the frame
  let consumed = 0; // source bytes fed since the last enqueue
  let totalWritten = 0;

  const release = (reason?: unknown) => {
    reader.cancel(reason).catch(() => {});
    compressor.destroy();
    finalizer.unregister(compressor);
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      // Produce exactly one output slice per pull so the returned stream's
      // queue (and thus how far we read ahead of the consumer) stays bounded.
      async pull(controller) {
        try {
          while (true) {
            if (chunk && chunkPos < chunk.length) {
              const n = Math.min(
                compressor.inputBufferSize,
                chunk.length - chunkPos
              );
              const out = compressor.compressStep(chunk, chunkPos, n);
              chunkPos += n;
              consumed += n;
              if (out.length) {
                controller.enqueue(out);
                consumed = 0;
                totalWritten += out.length;
                onProgress?.(totalWritten);
                return;
              }
              continue; // buffered internally; keep feeding
            }

            if (!finishing) {
              const { done, value } = await reader.read();
              if (done) {
                finishing = true;
                continue;
              }
              if (value.length === 0) continue;
              chunk = value;
              chunkPos = 0;
              continue;
            }

            // Flushing the final frame, one output buffer at a time.
            const { output, done } = compressor.compressFinish();
            if (output.length) {
              controller.enqueue(output);
              totalWritten += output.length;
              onProgress?.(totalWritten);
            }
            if (done) {
              controller.close();
              release();
            }
            return;
          }
        } catch (error) {
          release(error);
          controller.error(error);
        }
      },

      cancel(reason) {
        release(reason);
      },
    },
    // Count each chunk as the larger of its size and the source bytes that
    // produced it: highly compressible input (e.g. zeros, ~30000:1) would
    // otherwise be read far ahead of the consumer to fill an output budget.
    { highWaterMark, size: (out) => Math.max(out.byteLength, consumed) }
  );
  finalizer.register(stream, compressor, compressor);
  return stream;
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
  const { onProgress, highWaterMark = DEFAULT_HIGH_WATER_MARK } = options || {};

  const decompressor = new ZstdDecompressor();
  await decompressor.init();
  const reader = input.getReader();

  let chunk: Uint8Array | null = null; // current source chunk
  let chunkPos = 0; // bytes of `chunk` already loaded into WASM
  let totalWritten = 0;

  const release = (reason?: unknown) => {
    reader.cancel(reason).catch(() => {});
    decompressor.destroy();
    finalizer.unregister(decompressor);
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      // One output slice per pull. A small compressed slice can expand to many
      // gigabytes, so we never decode more than one output buffer ahead of the
      // consumer.
      async pull(controller) {
        try {
          while (true) {
            if (decompressor.hasInput()) {
              const out = decompressor.decompressStep();
              if (out.length) {
                controller.enqueue(out);
                totalWritten += out.length;
                onProgress?.(totalWritten);
                return;
              }
              continue; // consumed input without output yet
            }

            if (chunk && chunkPos < chunk.length) {
              const n = Math.min(
                decompressor.inputBufferSize,
                chunk.length - chunkPos
              );
              decompressor.setInput(chunk, chunkPos, n);
              chunkPos += n;
              continue;
            }

            const { done, value } = await reader.read();
            if (done) {
              decompressor.assertComplete();
              controller.close();
              release();
              return;
            }
            if (value.length === 0) continue;
            chunk = value;
            chunkPos = 0;
          }
        } catch (error) {
          release(error);
          controller.error(error);
        }
      },

      cancel(reason) {
        release(reason);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark })
  );
  finalizer.register(stream, decompressor, decompressor);
  return stream;
}

export async function initialize(): Promise<void> {
  await ensureInit();
}
