// src/__tests__/loader.test.ts
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getModule, initZstd } from "../src/loader.js";

jest.mock("../src/lib.js", () => ({
  lib: "H4sIAAAAAAAAA+3OMQ6AIBAE0N5TzN7AguKBbCwsrSwJJh5f+80r/mQym1cVNQVF5KnIjpxsyYWc7MiFXMiF3MiFXMiN3MiN3MiD3MiD3MiDPMiDPMiDvMiDvMiLvMiLvMiLvMiHvMiHvMiHfMiHfMiHfMiPfMiPfMiP/MiP/MiP/MhfDAAA//8BAAD//wMA5z9WLAADAAA=",
}));

describe("loader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("initZstd", () => {
    it("initializes module", async () => {
      await expect(initZstd()).resolves.not.toThrow();
    });

    it("returns same module on repeated calls", async () => {
      await initZstd();
      const module1 = getModule();

      await initZstd();
      const module2 = getModule();

      expect(module1).toBe(module2);
    });

    it("handles concurrent initialization", async () => {
      await expect(
        Promise.all([initZstd(), initZstd(), initZstd()])
      ).resolves.toBeDefined();

      expect(() => getModule()).not.toThrow();
    });
  });

  describe("getModule", () => {
    it("throws before initialization", async () => {
      jest.resetModules();
      const { getModule: freshGetModule } = await import("../src/loader.js");

      expect(() => freshGetModule()).toThrow(/Module not initialized/);
    });

    it("returns module after initialization", async () => {
      await initZstd();
      const module = getModule();

      expect(module).toBeDefined();
      expect(module).not.toBeNull();
    });

    it("returns consistent module reference", async () => {
      await initZstd();

      expect(getModule()).toBe(getModule());
      expect(getModule()).toBe(getModule());
    });
  });
});
