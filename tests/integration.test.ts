// src/__tests__/integration.test.ts
import { beforeAll, describe, expect, it, jest } from "@jest/globals";
import { createHash, type Hash } from "node:crypto";
import {
  compress,
  compressStream,
  decompress,
  decompressStream,
  initialize,
} from "../src/index.js";

// Native SHA-256 — Jest's `toEqual` is pathologically slow on multi-MB typed
// arrays, so large buffers are compared by digest instead.
const sha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(sha(actual)).toBe(sha(expected));
}

async function streamToArray(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// Cryptographically random (i.e. incompressible) bytes. getRandomValues is
// capped at 65536 bytes per call, so fill in slices.
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, offset + 65536));
  }
  return out;
}

describe("Integration Tests", () => {
  beforeAll(async () => {
    await initialize();
  }, 30000);

  describe("round-trip compression", () => {
    it("handles small text", async () => {
      const testString = "Hello, World!";
      const original = new TextEncoder().encode(testString);

      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      expect(new TextDecoder().decode(decompressed)).toBe(testString);
    }, 10000);

    it("handles large text", async () => {
      const text = "Lorem ipsum dolor sit amet, ".repeat(100);
      const original = new TextEncoder().encode(text);

      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      expect(decompressed).toEqual(original);
      expect(compressed.length).toBeLessThan(original.length);
    }, 10000);

    it("handles different compression levels (1-19)", async () => {
      const original = new TextEncoder().encode("Test data ".repeat(50));

      const level1 = await compress(original, { level: 1 });
      const level10 = await compress(original, { level: 10 });
      const level19 = await compress(original, { level: 19 });

      expect(await decompress(level1)).toEqual(original);
      expect(await decompress(level10)).toEqual(original);
      expect(await decompress(level19)).toEqual(original);

      // Higher levels should compress better
      expect(level19.length).toBeLessThanOrEqual(level10.length);
      expect(level10.length).toBeLessThanOrEqual(level1.length);
    }, 15000);

    it("clamps out-of-range levels with a warning instead of failing", async () => {
      const original = new TextEncoder().encode("clamp me ".repeat(100));
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Ultra level 22 clamps to 19; still produces a valid round-trip.
        const compressed = await compress(original, { level: 22 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("using 19"));
        expect(await decompress(compressed)).toEqual(original);

        // A level-22 request must equal a genuine level-19 compression.
        const atNineteen = await compress(original, { level: 19 });
        expect(compressed).toEqual(atNineteen);

        // Too-low and invalid values are coerced too.
        warn.mockClear();
        expect(await decompress(await compress(original, { level: 0 }))).toEqual(
          original
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("using 1"));

        // A valid level produces no warning.
        warn.mockClear();
        await compress(original, { level: 5 });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }, 15000);

    it("handles empty data", async () => {
      const original = new Uint8Array(0);
      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      expect(decompressed).toEqual(original);
    }, 10000);

    it("handles binary data", async () => {
      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        original[i] = i;
      }

      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      expect(decompressed).toEqual(original);
    }, 10000);

    // Regression: a single compress() call must drain output across multiple
    // internal block boundaries. Incompressible data larger than one ZSTD
    // block (~128 KB) previously truncated to a single output buffer.
    it("handles incompressible data larger than one block", async () => {
      const original = randomBytes(700 * 1024);

      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      // Incompressible data exceeds one ZSTD block (~128 KB), so the output
      // spans multiple buffers; it must round-trip without truncation.
      expect(compressed.length).toBeGreaterThan(512 * 1024);
      expectSameBytes(decompressed, original);
    }, 20000);

    it("handles compressible data spanning many blocks", async () => {
      const original = new TextEncoder().encode(
        "The quick brown fox. ".repeat(200 * 1024)
      );

      const compressed = await compress(original, { level: 5 });
      const decompressed = await decompress(compressed);

      expect(compressed.length).toBeLessThan(original.length);
      expectSameBytes(decompressed, original);
    }, 20000);
  });

  describe("streaming", () => {
    it("compresses and decompresses stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("First chunk. "));
          controller.enqueue(new TextEncoder().encode("Second chunk. "));
          controller.enqueue(new TextEncoder().encode("Third chunk."));
          controller.close();
        },
      });

      const compressed = await compressStream(stream);
      const decompressed = await decompressStream(compressed);

      const result = await streamToArray(decompressed);
      expect(new TextDecoder().decode(result)).toBe(
        "First chunk. Second chunk. Third chunk."
      );
    }, 10000);

    it("decompresses from stream", async () => {
      const original = new TextEncoder().encode("Stream test data");
      const compressed = await compress(original);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        },
      });

      const decompressed = await decompressStream(stream);
      const result = await streamToArray(decompressed);
      expect(result).toEqual(original);
    }, 10000);

    // Regression: browsers hand File.stream() chunks that are often larger
    // than one ZSTD block. A single oversized input chunk must round-trip.
    it("round-trips a single oversized stream chunk", async () => {
      const original = randomBytes(600 * 1024);

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(original);
          controller.close();
        },
      });

      const compressed = await compressStream(source, { level: 5 });
      const decompressed = await decompressStream(compressed);
      const result = await streamToArray(decompressed);

      expectSameBytes(result, original);
    }, 20000);
  });

  describe("progress tracking", () => {
    it("tracks compression progress", async () => {
      const original = new TextEncoder().encode("Test ".repeat(100));
      const progress: number[] = [];

      await compress(original, {
        onProgress: (bytes) => progress.push(bytes),
      });

      expect(progress.length).toBeGreaterThan(0);
      expect(progress[progress.length - 1]).toBeGreaterThan(0);
    }, 10000);

    it("tracks decompression progress", async () => {
      const original = new TextEncoder().encode("Test ".repeat(100));
      const compressed = await compress(original);
      const progress: number[] = [];

      await decompress(compressed, {
        onProgress: (bytes) => progress.push(bytes),
      });

      expect(progress.length).toBeGreaterThan(0);
      expect(progress[progress.length - 1]).toBe(original.length);
    }, 10000);
  });

  describe("compression effectiveness", () => {
    it("compresses repetitive data efficiently", async () => {
      const original = new TextEncoder().encode("A".repeat(1000));
      const compressed = await compress(original);

      expect(compressed.length).toBeLessThan(original.length * 0.1);
    }, 10000);

    it("handles random data", async () => {
      const original = new Uint8Array(1000);
      for (let i = 0; i < original.length; i++) {
        original[i] = Math.floor(Math.random() * 256);
      }

      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      expect(decompressed).toEqual(original);
    }, 10000);
  });

  describe("concurrent operations", () => {
    it("handles sequential compressions", async () => {
      const data = [
        new TextEncoder().encode("First"),
        new TextEncoder().encode("Second"),
        new TextEncoder().encode("Third"),
      ];

      const compressed = await Promise.all(data.map((d) => compress(d)));
      const decompressed = await Promise.all(
        compressed.map((c) => decompress(c))
      );

      expect(decompressed).toHaveLength(3);
      decompressed.forEach((d, i) => {
        expect(d).toEqual(data[i]);
      });
    }, 15000);

    it("handles parallel operations", async () => {
      const data = new TextEncoder().encode("Parallel test");

      const results = await Promise.all([
        compress(data),
        compress(data),
        compress(data),
      ]);

      for (const compressed of results) {
        expect(await decompress(compressed)).toEqual(data);
      }
    }, 15000);
  });

  describe("bounded memory (streaming)", () => {
    // The library exists to handle data larger than RAM, so a single hugely
    // expanding compressed chunk must NEVER be decoded into one buffer.
    it("decompresses without accumulating the whole expansion", async () => {
      const expandedSize = 16 * 1024 * 1024; // 16 MB of zeros
      const compressed = await compress(new Uint8Array(expandedSize));

      // The compressed form is tiny; the old code would emit one 16 MB chunk.
      expect(compressed.length).toBeLessThan(64 * 1024);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        },
      });

      const out = await decompressStream(stream);
      const reader = out.getReader();

      let total = 0;
      let maxChunk = 0;
      let chunkCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        maxChunk = Math.max(maxChunk, value.length);
        chunkCount++;
      }

      expect(total).toBe(expandedSize);
      // Output is sliced, never accumulated into one giant buffer.
      expect(maxChunk).toBeLessThanOrEqual(512 * 1024);
      expect(chunkCount).toBeGreaterThan(50);
    }, 20000);

    // A paused consumer must stop us decoding ahead — otherwise a "zip bomb"
    // (tiny input, enormous output) would exhaust memory.
    it("stops decoding ahead of a paused consumer", async () => {
      const expandedSize = 128 * 1024 * 1024; // 128 MB of zeros
      const compressed = await compress(new Uint8Array(expandedSize));

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        },
      });

      const out = await decompressStream(stream, {
        highWaterMark: 256 * 1024,
      });
      const reader = out.getReader();

      // Read only a handful of chunks, then stop.
      let decoded = 0;
      for (let i = 0; i < 3; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        decoded += value.length;
      }

      // We decoded only what was asked for, not the full 128 MB.
      expect(decoded).toBeLessThan(4 * 1024 * 1024);
      await reader.cancel();
    }, 20000);

    it("compresses without reading the whole source ahead of the consumer", async () => {
      const CHUNK = 64 * 1024;
      const TOTAL_CHUNKS = 2000; // 128 MB if fully drained
      let produced = 0;

      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced < TOTAL_CHUNKS) {
            const chunk = new Uint8Array(CHUNK);
            chunk.fill(produced & 0xff);
            produced++;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      });

      const out = await compressStream(source, { highWaterMark: 256 * 1024 });
      const reader = out.getReader();
      for (let i = 0; i < 5; i++) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Let any background prefill settle, then check read-ahead: this source
      // compresses ~30000:1, so an output-sized budget would drain all 128 MB.
      // Source bytes must stay within a few multiples of highWaterMark.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(produced).toBeGreaterThan(0);
      expect(produced * CHUNK).toBeLessThanOrEqual(2 * 1024 * 1024);
      await reader.cancel();
    }, 20000);

    // End-to-end proof: push far more data through the pipeline than we ever
    // hold at once, and verify it survives byte-exact.
    it("round-trips a stream larger than the working buffers", async () => {
      const CHUNK = 64 * 1024;
      const CHUNKS = 512; // 32 MB generated on the fly, never all in memory
      let produced = 0;

      // Hash the data as it flows through both ends rather than retaining it,
      // so the test itself stays within bounded memory.
      const inHash: Hash = createHash("sha256");
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced < CHUNKS) {
            const chunk = randomBytes(CHUNK);
            inHash.update(chunk);
            produced++;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      });

      const compressed = await compressStream(source, { level: 1 });
      const decompressed = await decompressStream(compressed);

      const reader = decompressed.getReader();
      const outHash: Hash = createHash("sha256");
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outHash.update(value);
        total += value.length;
      }

      expect(total).toBe(CHUNK * CHUNKS);
      expect(outHash.digest("hex")).toBe(inHash.digest("hex"));
    }, 60000);
  });

  describe("backpressure", () => {
    it("applies backpressure with realistic data", async () => {
      let sourcePullCount = 0;
      const CHUNK_SIZE = 8192; // 8KB chunks
      const TOTAL_CHUNKS = 200; // 1.6MB total

      // Generate varied, realistic data that compresses incrementally
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sourcePullCount < TOTAL_CHUNKS) {
            const chunk = new Uint8Array(CHUNK_SIZE);

            // Mix of patterns: repeated sequences + random-ish data
            // This mimics real-world text/binary files
            for (let i = 0; i < CHUNK_SIZE; i++) {
              const offset = sourcePullCount * CHUNK_SIZE + i;
              // Combination of patterns and pseudo-random values
              chunk[i] = offset % 256 ^ (offset / 256) % 128;
            }

            sourcePullCount++;
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      });

      const compressed = await compressStream(source);
      const reader = compressed.getReader();

      // Read just a few output chunks
      let outputChunks = 0;
      for (let i = 0; i < 5; i++) {
        const { done } = await reader.read();
        if (done) break;
        outputChunks++;
      }

      // Verify backpressure: source shouldn't be fully consumed
      // With realistic data, compression produces output regularly
      // so source pulls should be bounded relative to output reads
      expect(sourcePullCount).toBeLessThan(TOTAL_CHUNKS);
      expect(sourcePullCount).toBeGreaterThan(0);
      expect(outputChunks).toBeGreaterThan(0);

      // Cleanup
      reader.releaseLock();
    }, 10000);

    //   it("stops reading on cancel", async () => {
    //     let produced = 0;

    //     const source = new ReadableStream<Uint8Array>({
    //       pull(controller) {
    //         produced++;
    //         controller.enqueue(new Uint8Array(1024));
    //       },
    //     });

    //     const compressed = await compressStream(source);
    //     const reader = compressed.getReader();

    //     for (let i = 0; i < 5; i++) await reader.read();
    //     await reader.cancel();
    //     await new Promise((resolve) => setTimeout(resolve, 100));

    //     // Should only produce what was needed + small buffer
    //     expect(produced).toBeLessThan(15);
    //   }, 10000);

    //   it("applies backpressure through pipeline", async () => {
    //     let produced = 0;
    //     let consumed = 0;

    //     const source = new ReadableStream<Uint8Array>({
    //       pull(controller) {
    //         if (produced < 50) {
    //           controller.enqueue(new Uint8Array(2048).fill(produced % 256));
    //           produced++;
    //         } else {
    //           controller.close();
    //         }
    //       },
    //     });

    //     const compressed = await compressStream(source);
    //     const decompressed = await decompressStream(compressed);
    //     const reader = decompressed.getReader();

    //     while (true) {
    //       const { done } = await reader.read();
    //       if (done) break;
    //       consumed++;
    //       await new Promise((resolve) => setTimeout(resolve, 20));
    //       expect(produced - consumed).toBeLessThanOrEqual(15);
    //     }

    //     expect(produced).toBe(50);
    //   }, 30000);
  });
});

describe("integrity", () => {
  const data = new TextEncoder().encode("integrity ".repeat(50_000));
  let frame: Uint8Array;
  const chunked = (bytes: Uint8Array, size = 1000) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    });

  beforeAll(async () => {
    await initialize();
    frame = await compress(data);
  });

  it.each([1, 6, 0.5])("rejects input truncated to %p of a frame", async (keep) => {
    const cut = frame.subarray(0, keep < 1 ? frame.length * keep : frame.length - keep);
    await expect(decompress(cut)).rejects.toThrow(/truncated/);
    await expect(streamToArray(await decompressStream(chunked(cut)))).rejects.toThrow(/truncated/);
  });

  it("accepts concatenated frames split into 1-byte chunks", async () => {
    const two = new Uint8Array([...frame, ...frame]);
    const out = await streamToArray(await decompressStream(chunked(two, 1)));
    expect(out.length).toBe(data.length * 2);
  });

  it("writes a checksum and rejects data that fails it", async () => {
    expect(frame[4] & 0x04).toBe(0x04); // Frame_Header_Descriptor checksum flag
    const bad = frame.slice();
    bad[bad.length - 1] ^= 0x01; // last byte of the content checksum
    await expect(decompress(bad)).rejects.toThrow(/checksum/);
  });

  it("reports zstd error names", async () => {
    await expect(decompress(new Uint8Array(8).fill(1))).rejects.toThrow(
      "Decompression failed: Unknown frame descriptor"
    );
  });

  it("cancels the source when the output stream is cancelled", async () => {
    let reason: unknown;
    const source = new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array(65536)),
      cancel: (r) => void (reason = r),
    });
    await (await compressStream(source)).cancel("stop");
    expect(reason).toBe("stop");
  });
});
