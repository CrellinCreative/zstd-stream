import { beforeEach, expect, it, jest } from "@jest/globals";
import { CompressOptions, DecompressOptions } from "../src/index.js";

// 1. Define mock implementations FIRST
const mockInitZstd = jest.fn<any>();
const MockZstdCompressor = jest.fn();
const MockZstdDecompressor = jest.fn();

// 2. Mock the modules BEFORE any imports
jest.unstable_mockModule("../src/loader.js", () => ({
  initZstd: mockInitZstd,
}));

jest.unstable_mockModule("../src/compressor.js", () => ({
  ZstdCompressor: MockZstdCompressor,
  ZstdDecompressor: MockZstdDecompressor,
}));

// Helper to consume a stream into Uint8Array
async function streamToUint8Array(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let iteration = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    iteration++;
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

describe("initialize", () => {
  let initialize: () => Promise<void>;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockInitZstd.mockResolvedValue(undefined);

    const module = await import("../src/index.js");
    initialize = module.initialize;
  });

  it("initializes module", async () => {
    await initialize();
    expect(mockInitZstd).toHaveBeenCalledTimes(1);
  });

  it("is idempotent", async () => {
    await initialize();
    await initialize();
    await initialize();
    expect(mockInitZstd).toHaveBeenCalledTimes(1);
  });
});

describe("compress (Uint8Array)", () => {
  let compress: (
    data: Uint8Array,
    options?: CompressOptions
  ) => Promise<Uint8Array>;
  let mockCompressor: {
    init: jest.Mock<() => Promise<void>>;
    process: jest.Mock<(data: Uint8Array, isLast: boolean) => Uint8Array>;
    destroy: jest.Mock<() => void>;
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockInitZstd.mockResolvedValue(undefined);

    mockCompressor = {
      init: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      process: jest.fn<(data: Uint8Array, isLast: boolean) => Uint8Array>(),
      destroy: jest.fn<() => void>(),
    };

    MockZstdCompressor.mockImplementation(() => mockCompressor);

    const module = await import("../src/index.js");
    compress = module.compress;
  });

  it("compresses Uint8Array with default level", async () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const compressed = new Uint8Array([10, 20, 30]);
    mockCompressor.process.mockReturnValue(compressed);

    const result = await compress(input);

    expect(MockZstdCompressor).toHaveBeenCalledWith(3);
    expect(mockCompressor.init).toHaveBeenCalled();
    expect(mockCompressor.process).toHaveBeenCalledWith(input, true);
    expect(mockCompressor.destroy).toHaveBeenCalled();
    expect(result).toEqual(compressed);
  });

  it("compresses with custom level", async () => {
    const input = new Uint8Array([1, 2, 3]);
    mockCompressor.process.mockReturnValue(new Uint8Array([10]));

    await compress(input, { level: 15 });

    expect(MockZstdCompressor).toHaveBeenCalledWith(15);
  });

  it("calls progress callback", async () => {
    const compressed = new Uint8Array([10, 20, 30]);
    const onProgress = jest.fn();
    mockCompressor.process.mockReturnValue(compressed);

    await compress(new Uint8Array([1, 2, 3]), { onProgress });

    expect(onProgress).toHaveBeenCalledWith(3);
  });

  it("destroys compressor on error", async () => {
    mockCompressor.process.mockImplementation(() => {
      throw new Error("Compression failed");
    });

    await expect(compress(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "Compression failed"
    );
    expect(mockCompressor.destroy).toHaveBeenCalled();
  });

  it("initializes once for multiple calls", async () => {
    mockCompressor.process.mockReturnValue(new Uint8Array([10]));

    await compress(new Uint8Array([1]));
    await compress(new Uint8Array([2]));
    await compress(new Uint8Array([3]));

    expect(mockInitZstd).toHaveBeenCalledTimes(1);
  });
});

describe("compressStream (ReadableStream)", () => {
  let compressStream: (
    stream: ReadableStream<Uint8Array>,
    options?: CompressOptions
  ) => Promise<ReadableStream<Uint8Array>>;
  let mockCompressor: {
    init: jest.Mock<() => Promise<void>>;
    inputBufferSize: number;
    compressStep: jest.Mock<
      (data: Uint8Array, offset: number, length: number) => Uint8Array
    >;
    compressFinish: jest.Mock<
      () => { output: Uint8Array; done: boolean }
    >;
    destroy: jest.Mock<() => void>;
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockInitZstd.mockResolvedValue(undefined);

    mockCompressor = {
      init: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      inputBufferSize: 1024,
      compressStep:
        jest.fn<(d: Uint8Array, o: number, l: number) => Uint8Array>(),
      compressFinish: jest
        .fn<() => { output: Uint8Array; done: boolean }>()
        .mockReturnValue({ output: new Uint8Array(0), done: true }),
      destroy: jest.fn<() => void>(),
    };

    MockZstdCompressor.mockImplementation(() => mockCompressor);

    const module = await import("../src/index.js");
    compressStream = module.compressStream;
  });

  it("compresses ReadableStream", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    mockCompressor.compressStep
      .mockReturnValueOnce(new Uint8Array([10, 20]))
      .mockReturnValueOnce(new Uint8Array([30, 40]));

    const resultStream = await compressStream(stream);
    const result = await streamToUint8Array(resultStream);

    expect(result).toEqual(new Uint8Array([10, 20, 30, 40]));
    expect(mockCompressor.compressStep).toHaveBeenCalledTimes(2);
    expect(mockCompressor.compressFinish).toHaveBeenCalled();
  });

  it("feeds source chunks in inputBufferSize-sized slices", async () => {
    mockCompressor.inputBufferSize = 2; // force a 5-byte chunk into 3 slices
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
        controller.close();
      },
    });

    mockCompressor.compressStep.mockReturnValue(new Uint8Array([9]));

    const resultStream = await compressStream(stream);
    await streamToUint8Array(resultStream);

    expect(mockCompressor.compressStep).toHaveBeenCalledTimes(3);
    expect(mockCompressor.compressStep).toHaveBeenNthCalledWith(
      1,
      new Uint8Array([1, 2, 3, 4, 5]),
      0,
      2
    );
    expect(mockCompressor.compressStep).toHaveBeenNthCalledWith(
      2,
      new Uint8Array([1, 2, 3, 4, 5]),
      2,
      2
    );
    expect(mockCompressor.compressStep).toHaveBeenNthCalledWith(
      3,
      new Uint8Array([1, 2, 3, 4, 5]),
      4,
      1
    );
  });

  it("skips empty step output (engine still buffering)", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });

    mockCompressor.compressStep.mockReturnValue(new Uint8Array(0));
    mockCompressor.compressFinish.mockReturnValue({
      output: new Uint8Array([10]),
      done: true,
    });

    const resultStream = await compressStream(stream);
    const result = await streamToUint8Array(resultStream);

    expect(result).toEqual(new Uint8Array([10]));
  });

  it("flushes the final frame across multiple finish calls", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close(); // empty source
      },
    });

    mockCompressor.compressFinish
      .mockReturnValueOnce({ output: new Uint8Array([1, 2]), done: false })
      .mockReturnValueOnce({ output: new Uint8Array([3]), done: true });

    const resultStream = await compressStream(stream);
    const result = await streamToUint8Array(resultStream);

    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(mockCompressor.compressFinish).toHaveBeenCalledTimes(2);
  });

  it("tracks cumulative progress", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });

    const onProgress = jest.fn();
    mockCompressor.compressStep
      .mockReturnValueOnce(new Uint8Array([10, 20]))
      .mockReturnValueOnce(new Uint8Array([30]));

    const resultStream = await compressStream(stream, { onProgress });
    await streamToUint8Array(resultStream);

    expect(onProgress).toHaveBeenNthCalledWith(1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 3);
  });

  it("destroys compressor on error", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    mockCompressor.compressStep.mockImplementation(() => {
      throw new Error("Compression failed");
    });

    const resultStream = await compressStream(stream);

    await expect(streamToUint8Array(resultStream)).rejects.toThrow(
      "Compression failed"
    );
    expect(mockCompressor.destroy).toHaveBeenCalled();
  });
});

describe("decompress (Uint8Array)", () => {
  let decompress: (
    data: Uint8Array,
    options?: DecompressOptions
  ) => Promise<Uint8Array>;
  let mockDecompressor: {
    init: jest.Mock<() => Promise<void>>;
    process: jest.Mock<(data: Uint8Array) => Uint8Array>;
    destroy: jest.Mock<() => void>;
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockInitZstd.mockResolvedValue(undefined);

    mockDecompressor = {
      init: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      process: jest.fn<(data: Uint8Array) => Uint8Array>(),
      destroy: jest.fn<() => void>(),
    };

    MockZstdDecompressor.mockImplementation(() => mockDecompressor);

    const module = await import("../src/index.js");
    decompress = module.decompress;
  });

  it("decompresses Uint8Array", async () => {
    const decompressed = new Uint8Array([1, 2, 3, 4, 5]);
    mockDecompressor.process.mockReturnValue(decompressed);

    const result = await decompress(new Uint8Array([10, 20, 30]));

    expect(mockDecompressor.init).toHaveBeenCalled();
    expect(result).toEqual(decompressed);
  });

  it("calls progress callback", async () => {
    const decompressed = new Uint8Array([1, 2, 3, 4, 5]);
    const onProgress = jest.fn();
    mockDecompressor.process.mockReturnValue(decompressed);

    await decompress(new Uint8Array([10, 20, 30]), { onProgress });

    expect(onProgress).toHaveBeenCalledWith(5);
  });

  it("handles empty result", async () => {
    mockDecompressor.process.mockReturnValue(new Uint8Array(0));
    const result = await decompress(new Uint8Array([10, 20]));
    expect(result).toEqual(new Uint8Array(0));
  });

  it("destroys decompressor on error", async () => {
    mockDecompressor.process.mockImplementation(() => {
      throw new Error("Decompression failed");
    });

    await expect(decompress(new Uint8Array([10]))).rejects.toThrow(
      "Decompression failed"
    );
    expect(mockDecompressor.destroy).toHaveBeenCalled();
  });
});

describe("decompressStream (ReadableStream)", () => {
  let decompressStream: (
    stream: ReadableStream<Uint8Array>,
    options?: DecompressOptions
  ) => Promise<ReadableStream<Uint8Array>>;
  let mockDecompressor: {
    init: jest.Mock<() => Promise<void>>;
    inputBufferSize: number;
    setInput: jest.Mock<
      (data: Uint8Array, offset: number, length: number) => void
    >;
    hasInput: jest.Mock<() => boolean>;
    decompressStep: jest.Mock<() => Uint8Array>;
    assertComplete: jest.Mock<() => void>;
    destroy: jest.Mock<() => void>;
  };

  // Model the engine: setInput() loads `steps` worth of decode work; each
  // decompressStep() consumes one step. hasInput() drains accordingly.
  function wireEngine(stepsPerInput: number, outputs: Uint8Array[]) {
    let remaining = 0;
    let i = 0;
    mockDecompressor.setInput.mockImplementation(() => {
      remaining = stepsPerInput;
    });
    mockDecompressor.hasInput.mockImplementation(() => remaining > 0);
    mockDecompressor.decompressStep.mockImplementation(() => {
      remaining--;
      return outputs[i++] ?? new Uint8Array(0);
    });
  }

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockInitZstd.mockResolvedValue(undefined);

    mockDecompressor = {
      init: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      inputBufferSize: 1024,
      setInput:
        jest.fn<(d: Uint8Array, o: number, l: number) => void>(),
      hasInput: jest.fn<() => boolean>(),
      decompressStep: jest.fn<() => Uint8Array>(),
      assertComplete: jest.fn<() => void>(),
      destroy: jest.fn<() => void>(),
    };

    MockZstdDecompressor.mockImplementation(() => mockDecompressor);

    const module = await import("../src/index.js");
    decompressStream = module.decompressStream;
  });

  it("decompresses ReadableStream", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([10, 20]));
        controller.enqueue(new Uint8Array([30, 40]));
        controller.close();
      },
    });

    wireEngine(1, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);

    const resultStream = await decompressStream(stream);
    const result = await streamToUint8Array(resultStream);

    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("emits one output slice per decode step (no accumulation)", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([10])); // one compressed chunk...
        controller.close();
      },
    });

    // ...expands to three separate output slices.
    wireEngine(3, [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);

    const resultStream = await decompressStream(stream);
    const chunks: Uint8Array[] = [];
    const reader = resultStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // Each slice is enqueued individually rather than concatenated.
    expect(chunks).toEqual([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
  });

  it("loads source chunks in inputBufferSize-sized slices", async () => {
    mockDecompressor.inputBufferSize = 2;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([10, 20, 30, 40, 50]));
        controller.close();
      },
    });

    wireEngine(1, [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);

    const resultStream = await decompressStream(stream);
    await streamToUint8Array(resultStream);

    expect(mockDecompressor.setInput).toHaveBeenNthCalledWith(
      1,
      new Uint8Array([10, 20, 30, 40, 50]),
      0,
      2
    );
    expect(mockDecompressor.setInput).toHaveBeenNthCalledWith(
      2,
      new Uint8Array([10, 20, 30, 40, 50]),
      2,
      2
    );
    expect(mockDecompressor.setInput).toHaveBeenNthCalledWith(
      3,
      new Uint8Array([10, 20, 30, 40, 50]),
      4,
      1
    );
  });

  it("destroys decompressor on error", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([10]));
        controller.close();
      },
    });

    mockDecompressor.setInput.mockImplementation(() => {});
    mockDecompressor.hasInput.mockReturnValue(true);
    mockDecompressor.decompressStep.mockImplementation(() => {
      throw new Error("Decompression failed");
    });

    const resultStream = await decompressStream(stream);

    await expect(streamToUint8Array(resultStream)).rejects.toThrow(
      "Decompression failed"
    );
    expect(mockDecompressor.destroy).toHaveBeenCalled();
  });
});
