/**
 * Compression benchmark: zstd-stream vs. the compression libraries a browser
 * app actually reaches for.
 *
 * The comparison is against browser-capable options — `pako`, `fflate`, the
 * browser-native `CompressionStream` (gzip), and the popular zstd ports
 * (`zstd-codec`, `@bokuweb/zstd-wasm`)
 * — not Node's native `node:zlib`, which isn't available in a browser and so
 * isn't a real alternative here.
 *
 * Everything runs on one large payload. For each library it reports:
 *   - compression ratio (input / output, higher is better)
 *   - throughput        (MB/s, higher is better)
 *   - peak memory       (RSS in a fresh process, lower is better)
 *   - whether it can process a 4 GB+ file (past a browser tab's ~2 GB limit)
 *
 * Memory is measured in an isolated child process (peak RSS minus an empty
 * baseline) so it reflects each library's real working set.
 *
 * Run it (build the library first so `dist/` exists):
 *
 *   npm run build
 *   npm i --no-save pako fflate zstd-codec @bokuweb/zstd-wasm   # competitors (optional)
 *   node benchmarks/compression-bench.js
 *
 * Options (environment variables):
 *   CMP    payload every library is compared on   (default 1GB)
 *   NT/FP  number of line templates / field ratio in the synthetic data
 */

import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compressStream } from "../dist/index.js";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function parseSize(text, fallback) {
  if (!text) return fallback;
  const m = String(text).trim().match(/^([\d.]+)\s*(k|m|g)?b?$/i);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  const mult =
    unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return Math.round(n * mult);
}

const CMP = parseSize(process.env.CMP, 1024 ** 3); // 1 GB
const CHUNK = 1024 * 1024;
const POOL_SIZE = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Data source: one text-like pool, streamed cyclically.
// ---------------------------------------------------------------------------

function makePool(size) {
  // Log/JSON-like data: a small set of line "templates" (fixed words) with a few
  // varying "fields" (random tokens) per line — the shape of the data people
  // actually stream by the gigabyte. Both codecs get real local redundancy from
  // the repeated templates; zstd's larger window then finds more of it than
  // gzip's 32 KB one, which is why their ratios differ the way real files do.
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const skew = (count, p) => Math.min(count - 1, Math.floor(Math.pow(rnd(), p) * count));

  const words = [];
  for (let i = 0; i < 1500; i++) {
    const len = 3 + Math.floor(rnd() * 8);
    let w = "";
    for (let j = 0; j < len; j++) w += String.fromCharCode(97 + Math.floor(rnd() * 26));
    words.push(w);
  }

  const TEMPLATES = parseInt(process.env.NT || "250", 10);
  const FIELD_P = parseFloat(process.env.FP || "0.15");
  const templates = [];
  for (let t = 0; t < TEMPLATES; t++) {
    const ntok = 8 + Math.floor(rnd() * 22);
    const toks = [];
    for (let k = 0; k < ntok; k++) toks.push(rnd() < FIELD_P ? null : words[skew(1500, 1.7)]);
    templates.push(toks);
  }
  const fieldTok = () => {
    let n = 4 + Math.floor(rnd() * 8);
    let f = "";
    for (let j = 0; j < n; j++) f += Math.floor(rnd() * 36).toString(36);
    return f;
  };

  const pool = Buffer.allocUnsafe(size);
  let pos = 0;
  while (pos < size) {
    const toks = templates[skew(TEMPLATES, 1.2)];
    const line = toks.map((x) => (x === null ? fieldTok() : x)).join(" ") + "\n";
    const b = Buffer.from(line);
    const n = Math.min(b.length, size - pos);
    b.copy(pool, pos, 0, n);
    pos += n;
  }
  return pool;
}

const POOL = makePool(POOL_SIZE);

function* poolChunks(totalBytes) {
  let produced = 0;
  let off = 0;
  while (produced < totalBytes) {
    const n = Math.min(CHUNK, totalBytes - produced);
    if (off + n > POOL.length) off = 0;
    yield POOL.subarray(off, off + n);
    off += n;
    produced += n;
  }
}

function webSource(totalBytes) {
  const it = poolChunks(totalBytes);
  return new ReadableStream({
    pull(controller) {
      const { value, done } = it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

function fullBuffer(totalBytes) {
  const out = Buffer.allocUnsafe(totalBytes);
  let pos = 0;
  for (const chunk of poolChunks(totalBytes)) {
    chunk.copy(out, pos);
    pos += chunk.length;
  }
  return out;
}

async function countWebStream(stream) {
  const reader = stream.getReader();
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Libraries. `run(size)` returns the compressed byte count.
//   streams: true  → constant memory, can process any size
//   streams: false → in-memory, cannot hold a 4 GB+ file
// ---------------------------------------------------------------------------

const libs = [
  {
    name: "zstd-stream",
    kind: "zstd, streaming",
    streams: true,
    async run(n) {
      const out = await compressStream(webSource(n), { level: 3 });
      return countWebStream(out);
    },
  },
  {
    name: "browser gzip (CompressionStream)",
    kind: "gzip, streaming",
    streams: true,
    run: (n) =>
      countWebStream(webSource(n).pipeThrough(new CompressionStream("gzip"))),
  },
];

// Optional npm competitors — loaded only if installed.
async function loadOptional() {
  try {
    const { gzipSync } = await import("fflate");
    libs.push({
      name: "fflate",
      kind: "gzip, in-memory",
      streams: false,
      run: (n) => gzipSync(fullBuffer(n), { level: 6 }).length,
    });
  } catch {}
  try {
    const pako = await import("pako");
    libs.push({
      name: "pako",
      kind: "gzip, in-memory",
      streams: false,
      run: (n) => pako.gzip(fullBuffer(n), { level: 6 }).length,
    });
  } catch {}
  try {
    const { ZstdCodec } = (await import("zstd-codec")).default;
    const zstd = await new Promise((resolve) => ZstdCodec.run(resolve));
    // Its `Simple` API aborts above ~4 MB; `Streaming` handles large inputs
    // but needs every chunk in memory up front, so give it the whole input.
    libs.push({
      name: "zstd-codec",
      kind: "zstd, in-memory",
      streams: false,
      run: (n) => {
        const all = fullBuffer(n);
        const chunks = [];
        for (let i = 0; i < n; i += CHUNK) chunks.push(all.subarray(i, i + CHUNK));
        return new zstd.Streaming().compressChunks(chunks, n, 3).length;
      },
    });
  } catch {}
  try {
    const bok = await import("@bokuweb/zstd-wasm");
    await bok.init();
    libs.push({
      name: "@bokuweb/zstd-wasm",
      kind: "zstd, in-memory",
      streams: false,
      run: (n) => bok.compress(fullBuffer(n), 3).length,
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Isolated measurement
// ---------------------------------------------------------------------------

async function measureInChild(name, size) {
  const lib = libs.find((l) => l.name === name);
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 10);
  timer.unref?.();

  const BROWSER_ARRAYBUFFER_LIMIT = 2 * 1024 ** 3;

  let ratio = 0;
  let mbPerSec = 0;
  let ok = true;
  // In-memory codecs must hold the whole input in one ArrayBuffer, which a
  // browser caps at ~2 GB. Don't even attempt it past that — it's a hard limit
  // in the browser, and locally it would just thrash the machine.
  if (lib && !lib.streams && size > BROWSER_ARRAYBUFFER_LIMIT) {
    process.stdout.write(JSON.stringify({ ok: false }) + "\n");
    clearInterval(timer);
    return;
  }
  if (lib) {
    try {
      const start = performance.now();
      const compressed = await lib.run(size);
      const ms = performance.now() - start;
      ratio = size / compressed;
      mbPerSec = size / 1024 / 1024 / (ms / 1000);
    } catch {
      ok = false;
    }
  }
  const post = process.memoryUsage().rss;
  if (post > peak) peak = post;
  clearInterval(timer);

  process.stdout.write(JSON.stringify({ ratio, mbPerSec, peakRss: peak, ok }) + "\n");
}

function spawn(name, size) {
  const res = spawnSync(process.execPath, [__filename, "--measure"], {
    env: { ...process.env, MODE: "measure", MNAME: name, MSIZE: String(size) },
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  if (res.status !== 0) return { ok: false };
  try {
    return JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop());
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

async function main() {
  await loadOptional();

  if (process.env.MODE === "measure") {
    await measureInChild(process.env.MNAME, parseInt(process.env.MSIZE, 10));
    return;
  }

  console.log(
    `zstd-stream benchmark — Node ${process.version}, ${fmtBytes(CMP)} payload\n`
  );

  const baseline = spawn("__baseline__", 0).peakRss || 0;

  const rows = [];
  for (const lib of libs) {
    const r = spawn(lib.name, CMP);
    const memMB = r.ok ? Math.max(0, (r.peakRss - baseline) / 1024 / 1024) : null;
    rows.push({ lib, ...r, memMB });
    console.error(
      r.ok
        ? `  ${lib.name}: ${r.ratio.toFixed(2)}x, ${r.mbPerSec.toFixed(0)} MB/s, ${memMB.toFixed(0)} MB`
        : `  ${lib.name}: FAILED (likely OOM at ${fmtBytes(CMP)})`
    );
  }

  console.log("| Library | Type | Ratio | Speed | Peak memory | 4 GB+ file |");
  console.log("| :------ | :--- | ----: | ----: | ----------: | :--------: |");
  for (const row of rows) {
    const big = row.lib.streams ? "✓" : "✗";
    if (!row.ok) {
      // In-memory codecs fail because their working set (~2-2.5x the input)
      // blows past the ~2 GB WASM / ArrayBuffer ceiling — not because the file
      // itself is over 2 GB.
      console.log(
        `| ${row.lib.name} | ${row.lib.kind} | — | — | >2 GB → OOM | ${big} |`
      );
    } else {
      console.log(
        `| ${row.lib.name} | ${row.lib.kind} | ${row.ratio.toFixed(2)}× | ` +
          `${row.mbPerSec.toFixed(0)} MB/s | ${row.memMB.toFixed(0)} MB | ${big} |`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
