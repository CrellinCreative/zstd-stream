import { glue, wasm } from "./lib.js";
import type { Module } from "./types.js";

let module: Module | null = null;
let initPromise: Promise<void> | null = null;
const isNode = typeof process !== "undefined" && process.versions?.node != null;

/** Inflate one of the embedded gzipped, base64-encoded payloads. */
async function inflate(payload: string): Promise<Uint8Array> {
  if (isNode) {
    // Node.js path
    const { gunzip } = await import("node:zlib");
    const { promisify } = await import("node:util");
    return promisify(gunzip)(Buffer.from(payload, "base64"));
  }

  // Browser path
  const binaryString = atob(payload);
  const binaryData = Uint8Array.from(binaryString, (char) =>
    char.charCodeAt(0)
  );
  const stream = new Blob([binaryData])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function evaluateCode(code: string): Promise<any> {
  if (isNode) {
    // Node (18+) can import a data: URL directly.
    const url = `data:text/javascript,${encodeURIComponent(code)}`;
    const mod = await import(/* @vite-ignore */ url);
    return mod.default || mod.ZstdWasm || mod;
  }

  // Browser path
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
      const [code, wasmBinary] = await Promise.all([inflate(glue), inflate(wasm)]);
      const loader = await evaluateCode(new TextDecoder().decode(code));
      // The binary is supplied inline; locateFile stops the glue from deriving
      // a URL for it (nothing is ever fetched).
      module = await loader({ wasmBinary, locateFile: () => "" });
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
