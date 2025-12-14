import { getModule } from "./loader.js";
import type { Module } from "./types.js";

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

export class ZstdCompressor extends BaseProcessor {
  private ctx = 0;
  private buffer = 0;
  private bufferSize = 0;

  constructor(private level: number) {
    super();
    if (level < 1 || level > 19) {
      throw new Error("Compression level must be between 1 and 19");
    }
  }

  async init(): Promise<void> {
    this.module = getModule();
  }

  process(data: Uint8Array, isLast: boolean): Uint8Array {
    if (!this.module) throw new Error("Not initialized");
    if (this.destroyed) throw new Error("Destroyed");

    if (!this.ctx) {
      this.ctx = this.module._createCCtx();
      if (!this.ctx || this.module._initCStream(this.ctx, this.level) !== 0) {
        this.cleanup();
        throw new Error("Failed to create compression context");
      }
    }

    if (!data.length && !isLast) return new Uint8Array(0);

    const srcPtr = this.module._malloc(data.length);
    if (!srcPtr) throw new Error("Failed to allocate source buffer");
    this.module.HEAPU8.set(data, srcPtr);

    try {
      if (!this.buffer) {
        this.bufferSize = this.module._cStreamOutSize();
        this.buffer = this.module._malloc(this.bufferSize);
        if (!this.buffer) throw new Error("Failed to allocate output buffer");
      }

      const result = Number(
        this.module._compressStream(
          this.ctx,
          this.buffer,
          this.bufferSize,
          srcPtr,
          data.length,
          isLast ? 2 : 0
        )
      );

      if (result < 0) {
        throw new Error(
          `Compression failed: ${this.module._getErrorName(-result)}`
        );
      }

      return result === 0
        ? new Uint8Array(0)
        : new Uint8Array(
            this.module.HEAPU8.subarray(this.buffer, this.buffer + result)
          );
    } finally {
      this.module._free(srcPtr);
    }
  }

  protected cleanup(): void {
    if (this.module) {
      if (this.ctx) this.module._freeCCtx(this.ctx);
      if (this.buffer) this.module._free(this.buffer);
      this.ctx = 0;
      this.buffer = 0;
    }
  }
}

export class ZstdDecompressor extends BaseProcessor {
  private ctx = 0;
  private buffer = 0;
  private bufferSize = 0;

  async init(): Promise<void> {
    this.module = getModule();
  }

  process(data: Uint8Array): Uint8Array {
    if (!this.module) throw new Error("Not initialized");
    if (this.destroyed) throw new Error("Destroyed");

    if (!this.ctx) {
      this.ctx = this.module._createDCtx();
      if (!this.ctx || this.module._initDStream(this.ctx) === 0) {
        this.cleanup();
        throw new Error("Failed to create decompression context");
      }
    }

    if (!data.length) return new Uint8Array(0);

    if (!this.buffer) {
      this.bufferSize = this.module._dStreamOutSize();
      this.buffer = this.module._malloc(this.bufferSize);
      if (!this.buffer) throw new Error("Failed to allocate output buffer");
    }

    const srcPtr = this.module._malloc(data.length);
    if (!srcPtr) throw new Error("Failed to allocate source buffer");
    this.module.HEAPU8.set(data, srcPtr);

    try {
      let srcPos = 0;
      const chunks: Uint8Array[] = [];

      while (srcPos < data.length) {
        const result = this.module._decompressStream(
          this.ctx,
          this.buffer,
          this.bufferSize,
          srcPtr + srcPos,
          data.length - srcPos
        );

        if (result < 0) {
          const errorCode = Number(BigInt(result) & 0x7fffffffffffffffn);
          throw new Error(
            `Decompression failed: ${this.module._getErrorName(errorCode)}`
          );
        }

        const consumed = Number(BigInt(result) >> 32n);
        const outputSize = Number(BigInt(result) & 0xffffffffn);

        if (consumed === 0 && outputSize === 0) {
          throw new Error("Decompression stalled");
        }

        if (outputSize > 0) {
          chunks.push(
            new Uint8Array(
              this.module.HEAPU8.subarray(this.buffer, this.buffer + outputSize)
            )
          );
        }

        srcPos += consumed;
      }

      return this.concat(chunks);
    } finally {
      this.module._free(srcPtr);
    }
  }

  private concat(chunks: Uint8Array[]): Uint8Array {
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

  protected cleanup(): void {
    if (this.module) {
      if (this.ctx) this.module._freeDCtx(this.ctx);
      if (this.buffer) this.module._free(this.buffer);
      this.ctx = 0;
      this.buffer = 0;
    }
  }
}
