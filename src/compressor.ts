import { getModule } from "./loader.js";
import type { Module } from "./types.js";

const EMPTY = new Uint8Array(0);

/** Read the C string returned by `ZSTD_getErrorName`. */
function errorName(m: Module, code: number): string {
  const p = m._getErrorName(code);
  return new TextDecoder().decode(m.HEAPU8.subarray(p, m.HEAPU8.indexOf(0, p)));
}

// ZSTD operation modes for the streaming wrapper.
const ZSTD_E_CONTINUE = 0;
const ZSTD_E_END = 2;

// Supported compression levels. 20-22 ("ultra") are excluded: in streaming mode
// they pin the window to 32-128 MB, forcing every decompressor to allocate that
// much even for tiny files, and cost 200 MB-1 GB of WASM heap to compress.
const MIN_LEVEL = 1;
const MAX_LEVEL = 19;
const DEFAULT_LEVEL = 3;

// Set by the wasm wrapper on _decompressStream results when the decoder sits
// between frames.
const FRAME_DONE = 1n << 62n;

/**
 * Coerce a requested level into the supported 1-19 range, warning (rather than
 * throwing) so a misconfigured caller still gets a working stream.
 */
function normalizeLevel(level: number): number {
  if (!Number.isFinite(level)) {
    console.warn(
      `zstd-stream: invalid compression level ${level}; using default ${DEFAULT_LEVEL}.`
    );
    return DEFAULT_LEVEL;
  }
  const valid = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
  if (valid !== level) {
    console.warn(
      `zstd-stream: compression level ${level} is outside ${MIN_LEVEL}-${MAX_LEVEL}; using ${valid}.`
    );
  }
  return valid;
}

/** Join an array of chunks into a single contiguous Uint8Array. */
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return EMPTY;
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

abstract class BaseProcessor {
  protected destroyed = false;
  protected module: Module | null = null;

  destroy(): void {
    if (!this.destroyed) {
      this.cleanup();
      this.destroyed = true;
    }
  }

  protected abstract cleanup(): void;
}

/**
 * Incremental Zstandard compressor.
 *
 * The engine works on two fixed WASM buffers: an input buffer sized to
 * `_cStreamInSize()` and an output buffer sized to `_cStreamOutSize()` (which
 * zstd guarantees is large enough to flush one full block). Feeding no more
 * than `inputBufferSize` bytes per call keeps every call's output within a
 * single output buffer, so memory never scales with the total stream length.
 */
export class ZstdCompressor extends BaseProcessor {
  private ctx = 0;
  private inBuffer = 0;
  private outBuffer = 0;
  private outBufferSize = 0;
  inputBufferSize = 0;

  private readonly level: number;

  constructor(level: number) {
    super();
    this.level = normalizeLevel(level);
  }

  async init(): Promise<void> {
    const m = (this.module = getModule());

    this.ctx = m._createCCtx();
    if (!this.ctx || m._initCStream(this.ctx, this.level) !== 0) {
      this.cleanup();
      throw new Error("Failed to create compression context");
    }

    this.outBufferSize = m._cStreamOutSize();
    this.inputBufferSize = m._cStreamInSize();
    this.outBuffer = m._malloc(this.outBufferSize);
    this.inBuffer = m._malloc(this.inputBufferSize);
    if (!this.outBuffer || !this.inBuffer) {
      this.cleanup();
      throw new Error("Failed to allocate compression buffers");
    }
  }

  /**
   * Compress one input slice (`length` must be <= `inputBufferSize`). The
   * slice is fully consumed; returns the bytes produced this call, which may
   * be empty when the engine is still buffering toward a block boundary.
   */
  compressStep(data: Uint8Array, offset: number, length: number): Uint8Array {
    const m = this.requireModule();
    m.HEAPU8.set(data.subarray(offset, offset + length), this.inBuffer);
    return this.run(length, ZSTD_E_CONTINUE);
  }

  /**
   * Emit one output buffer of the closing frame. `done` is true once the frame
   * has been fully flushed (i.e. the engine returned less than a full buffer).
   */
  compressFinish(): { output: Uint8Array; done: boolean } {
    this.requireModule();
    const output = this.run(0, ZSTD_E_END);
    return { output, done: output.length < this.outBufferSize };
  }

  /** Single-shot compression of an in-memory buffer. */
  process(data: Uint8Array, isLast: boolean): Uint8Array {
    this.requireModule();
    if (!data.length && !isLast) return EMPTY;

    const chunks: Uint8Array[] = [];

    let pos = 0;
    while (pos < data.length) {
      const n = Math.min(this.inputBufferSize, data.length - pos);
      const out = this.compressStep(data, pos, n);
      if (out.length) chunks.push(out);
      pos += n;
    }

    if (isLast) {
      let result: { output: Uint8Array; done: boolean };
      do {
        result = this.compressFinish();
        if (result.output.length) chunks.push(result.output);
      } while (!result.done);
    }

    return concat(chunks);
  }

  /** Run one `_compressStream` call and copy out any produced bytes. */
  private run(length: number, mode: number): Uint8Array {
    const m = this.module!;
    const result = Number(
      m._compressStream(
        this.ctx,
        this.outBuffer,
        this.outBufferSize,
        this.inBuffer,
        length,
        mode
      )
    );

    if (result < 0) {
      throw new Error(`Compression failed: ${errorName(m, -result)}`);
    }

    return result === 0
      ? EMPTY
      : new Uint8Array(
          m.HEAPU8.subarray(this.outBuffer, this.outBuffer + result)
        );
  }

  private requireModule(): Module {
    if (!this.module) throw new Error("Not initialized");
    if (this.destroyed) throw new Error("Destroyed");
    return this.module;
  }

  protected cleanup(): void {
    if (this.module) {
      if (this.ctx) this.module._freeCCtx(this.ctx);
      if (this.outBuffer) this.module._free(this.outBuffer);
      if (this.inBuffer) this.module._free(this.inBuffer);
      this.ctx = 0;
      this.outBuffer = 0;
      this.inBuffer = 0;
    }
  }
}

/**
 * Incremental Zstandard decompressor.
 *
 * Input is loaded into a fixed WASM buffer one `inputBufferSize`-sized slice at
 * a time; `decompressStep()` then drains it one output buffer at a time. A
 * single compressed slice can expand to far more than memory, so the caller is
 * expected to enqueue each produced slice before requesting the next one.
 */
export class ZstdDecompressor extends BaseProcessor {
  private ctx = 0;
  private inBuffer = 0;
  private outBuffer = 0;
  private outBufferSize = 0;
  inputBufferSize = 0;

  // Position within the slice currently resident in the WASM input buffer.
  private inLen = 0;
  private inPos = 0;
  // False while a frame is partially decoded.
  private frameDone = true;

  async init(): Promise<void> {
    const m = (this.module = getModule());

    this.ctx = m._createDCtx();
    if (!this.ctx || m._initDStream(this.ctx) === 0) {
      this.cleanup();
      throw new Error("Failed to create decompression context");
    }

    this.outBufferSize = m._dStreamOutSize();
    this.inputBufferSize = m._dStreamInSize();
    this.outBuffer = m._malloc(this.outBufferSize);
    this.inBuffer = m._malloc(this.inputBufferSize);
    if (!this.outBuffer || !this.inBuffer) {
      this.cleanup();
      throw new Error("Failed to allocate decompression buffers");
    }
  }

  /** Load one input slice (`length` must be <= `inputBufferSize`) for decoding. */
  setInput(data: Uint8Array, offset: number, length: number): void {
    const m = this.requireModule();
    m.HEAPU8.set(data.subarray(offset, offset + length), this.inBuffer);
    this.inLen = length;
    this.inPos = 0;
  }

  /** True while the resident input slice still has bytes to decode. */
  hasInput(): boolean {
    return this.inPos < this.inLen;
  }

  /**
   * Decode one output buffer's worth of data from the resident input slice.
   * Returns the produced bytes (possibly empty). Advances the internal input
   * position; throws if the engine can neither consume nor produce (corrupt
   * input).
   */
  decompressStep(): Uint8Array {
    const m = this.requireModule();

    const result = m._decompressStream(
      this.ctx,
      this.outBuffer,
      this.outBufferSize,
      this.inBuffer + this.inPos,
      this.inLen - this.inPos
    );

    if (result < 0n) {
      throw new Error(`Decompression failed: ${errorName(m, Number(result & 0xffffffffn))}`);
    }

    this.frameDone = (result & FRAME_DONE) !== 0n;
    const consumed = Number((result >> 32n) & 0x3fffffffn);
    const outputSize = Number(result & 0xffffffffn);

    if (consumed === 0 && outputSize === 0) {
      throw new Error("Decompression stalled");
    }

    this.inPos += consumed;

    return outputSize === 0
      ? EMPTY
      : new Uint8Array(
          m.HEAPU8.subarray(this.outBuffer, this.outBuffer + outputSize)
        );
  }

  /** Single-shot decompression of an in-memory buffer. */
  process(data: Uint8Array): Uint8Array {
    this.requireModule();
    if (!data.length) return EMPTY;

    const chunks: Uint8Array[] = [];

    let pos = 0;
    while (pos < data.length) {
      const n = Math.min(this.inputBufferSize, data.length - pos);
      this.setInput(data, pos, n);
      while (this.hasInput()) {
        const out = this.decompressStep();
        if (out.length) chunks.push(out);
      }
      pos += n;
    }

    this.assertComplete();
    return concat(chunks);
  }

  /** Throw if the input ended partway through a frame. */
  assertComplete(): void {
    if (!this.frameDone) {
      throw new Error("Decompression failed: truncated input (incomplete frame)");
    }
  }

  private requireModule(): Module {
    if (!this.module) throw new Error("Not initialized");
    if (this.destroyed) throw new Error("Destroyed");
    return this.module;
  }

  protected cleanup(): void {
    if (this.module) {
      if (this.ctx) this.module._freeDCtx(this.ctx);
      if (this.outBuffer) this.module._free(this.outBuffer);
      if (this.inBuffer) this.module._free(this.inBuffer);
      this.ctx = 0;
      this.outBuffer = 0;
      this.inBuffer = 0;
    }
  }
}
