// src/__tests__/integration.test.ts
import { beforeAll, describe, expect, it } from "@jest/globals";
import { compress, decompress, initialize } from "../src/index.js";

describe("Integration Tests", () => {
  beforeAll(async () => {
    await initialize();
  }, 30000);

  describe("round-trip compression", () => {
    it("handles small text", async () => {
      const original = new TextEncoder().encode("Hello, World!");

      const compressed = await compress(original);
      const decompressed = await decompress(compressed);

      expect(new TextDecoder().decode(decompressed)).toBe("Hello, World!");
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

      const compressed = await compress(stream);
      const decompressed = await decompress(compressed);

      expect(new TextDecoder().decode(decompressed)).toBe(
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

      const decompressed = await decompress(stream);
      expect(decompressed).toEqual(original);
    }, 10000);
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
});
