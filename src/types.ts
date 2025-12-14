export interface Module {
  _createCCtx(): number;
  _createDCtx(): number;
  _freeCCtx(ctx: number): void;
  _freeDCtx(ctx: number): void;
  _initCStream(ctx: number, level: number): number;
  _initDStream(ctx: number): number;
  _compressStream(
    ctx: number,
    dst: number,
    dstSize: number,
    src: number,
    srcSize: number,
    end: number
  ): number;
  _decompressStream(
    ctx: number,
    dst: number,
    dstSize: number,
    src: number,
    srcSize: number
  ): number;
  _dStreamOutSize(): number;
  _cStreamOutSize(): number;
  _getErrorName(error: number): string;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}
