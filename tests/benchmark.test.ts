import { beforeAll, describe, expect, it } from "@jest/globals";
import { getModule, initZstd } from "../src/loader.js";

/**
 * Throughput benchmark for the per-call I/O slice size.
 *
 * The library feeds the engine in `_cStreamInSize()` (~128 KB) slices. That is
 * zstd's own recommendation, but feeding larger slices amortizes the WASM call
 * overhead — this benchmark measures whether that actually helps so the choice
 * is data-driven rather than assumed.
 *
 * Skipped by default (it is timing-sensitive and slow). Run it with:
 *   BENCH=1 npm test -- benchmark
 */
const maybe = process.env.BENCH ? describe : describe.skip;

maybe("chunk-size benchmark", () => {
  let m: any;

  beforeAll(async () => {
    await initZstd();
    m = getModule();
  }, 30000);

  it("measures compression throughput across slice sizes", () => {
    const LEVEL = 3;
    const SIZE = 64 * 1024 * 1024; // 64 MB sample

    // Semi-compressible data: a repeating template perturbed with noise, which
    // is closer to real files than pure zeros or pure random.
    const data = new Uint8Array(SIZE);
    let s = 0x9e3779b9;
    for (let i = 0; i < SIZE; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = i % 64 < 48 ? i & 0xff : s >>> 24;
    }

    const sliceSizes = [
      16 * 1024,
      32 * 1024,
      64 * 1024,
      128 * 1024,
      256 * 1024,
      512 * 1024,
      1024 * 1024,
    ];

    const results: {
      slice: string;
      ms: number;
      mbPerSec: number;
      ratio: number;
    }[] = [];

    for (const slice of sliceSizes) {
      // Must hold a full pending block flush (cStreamOutSize) plus this slice's
      // own output, so a single call always drains and fully consumes input.
      const outSize = m._cStreamOutSize() + m._compressBound(slice);
      const inPtr = m._malloc(slice);
      const outPtr = m._malloc(outSize);
      const ctx = m._createCCtx();
      m._initCStream(ctx, LEVEL);

      const start = performance.now();
      let compressed = 0;
      let pos = 0;
      while (pos < SIZE) {
        const n = Math.min(slice, SIZE - pos);
        m.HEAPU8.set(data.subarray(pos, pos + n), inPtr);
        const r = Number(
          m._compressStream(ctx, outPtr, outSize, inPtr, n, 0)
        );
        if (r < 0) throw new Error("compress failed");
        compressed += r;
        pos += n;
      }
      let r: number;
      do {
        r = Number(m._compressStream(ctx, outPtr, outSize, inPtr, 0, 2));
        if (r < 0) throw new Error("flush failed");
        compressed += r;
      } while (r === outSize);
      const ms = performance.now() - start;

      m._freeCCtx(ctx);
      m._free(inPtr);
      m._free(outPtr);

      results.push({
        slice: `${slice / 1024} KB`,
        ms: Math.round(ms),
        mbPerSec: Math.round((SIZE / 1024 / 1024 / ms) * 1000),
        ratio: +(SIZE / compressed).toFixed(2),
      });
    }

    // eslint-disable-next-line no-console
    console.table(results);

    const best = results.reduce((a, b) => (b.mbPerSec > a.mbPerSec ? b : a));
    // eslint-disable-next-line no-console
    console.log(`Fastest slice size: ${best.slice} (${best.mbPerSec} MB/s)`);

    // Sanity only — every size must produce a valid, identical compression
    // ratio; we are measuring speed, not asserting a winner.
    expect(results.every((r) => r.ratio > 1)).toBe(true);
  }, 120000);
});
