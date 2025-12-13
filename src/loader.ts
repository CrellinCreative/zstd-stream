// src/loader.ts
import { lib } from "./lib.js";
import type { Module } from "./types.ts";

let module: Module | null = null;
let initPromise: Promise<void> | null = null;
const isNode = typeof process !== "undefined" && process.versions?.node != null;

async function loadGzipped(): Promise<string> {
  if (isNode) {
    // Node.js path
    const { gunzip } = await import("node:zlib");
    const { promisify } = await import("node:util");
    const binaryData = Buffer.from(lib, "base64");
    const decompressed = await promisify(gunzip)(binaryData);
    return decompressed.toString("utf-8");
  }

  // Browser path
  const binaryString = atob(lib);
  const binaryData = Uint8Array.from(binaryString, (char) =>
    char.charCodeAt(0)
  );
  const stream = new Blob([binaryData])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buffer);
}

async function evaluateCode(code: string): Promise<any> {
  if (isNode) {
    const vm = await import("node:vm");
    // Optionally import util if you want guaranteed TextEncoder/Decoder (Node <12 fallback)
    // But Node ≥ 12 has them globally
    const { TextEncoder, TextDecoder } = await import("node:util"); // safe to use
    const URL = globalThis.URL;

    // Create a context with required globals
    const context = vm.createContext({
      // ES module-compatible globals
      TextEncoder,
      TextDecoder,
      Buffer, // global in Node
      URL, // global
      Uint8Array, // global
      ArrayBuffer, // global
      DataView, // global
      // Some WASM loaders check these
      window: {}, // dummy
      self: {}, // dummy (for Web Worker env check)
      globalThis: {}, // harmless stub
      // Avoid require/module/exports — ESM doesn’t use them
    });

    // Create and evaluate as ESM
    const mod = new vm.SourceTextModule(code, {
      context,
      identifier: "zstd-bundle.js",
      importModuleDynamically: async (specifier: string) => {
        // Allow dynamic ESM imports (e.g., import("node:buffer"))
        // Most embedded bundles won't use this, but safe to allow
        try {
          return await import(specifier);
        } catch (e: any) {
          console.warn(`⚠️ Dynamic import failed: ${specifier}`, e.message);
          throw new Error(`Dynamic import not supported: ${specifier}`);
        }
      },
    });

    // Link — since it's a self-contained bundle, it likely has no static imports
    // If it does, you'd need a resolver — but most don't
    await mod.link((specifier) => {
      throw new Error(`Static import not supported: ${specifier}`);
    });

    await mod.evaluate();

    const ns = mod.namespace;
    return (ns as any).default || (ns as any).ZstdWasm || ns;
  }

  // Browser path — unchanged
  const { URL } = globalThis;
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    return mod.default || mod.ZstdWasm || mod;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function initZstd(): Promise<void> {
  if (initPromise) return initPromise;
  if (module) return;
  initPromise = (async () => {
    try {
      const code = await loadGzipped();
      const loader = await evaluateCode(code);
      module = await loader();
      if (!module) throw new Error("WASM module initialization returned null");
    } catch (error) {
      initPromise = null;
      throw new Error(
        `Failed to initialize Zstandard: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  })();
  return initPromise;
}

export function getModule(): Module {
  if (!module)
    throw new Error("Module not initialized. Call initZstd() first.");
  return module;
}
