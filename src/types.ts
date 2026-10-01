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
  ): bigint;
  _decompressStream(
    ctx: number,
    dst: number,
    dstSize: number,
    src: number,
    srcSize: number
  ): bigint;
  _dStreamOutSize(): number;
  _cStreamOutSize(): number;
  _cStreamInSize(): number;
  _dStreamInSize(): number;
  _getErrorName(error: number): number; // char*
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}
