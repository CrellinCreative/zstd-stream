import { CommonModule } from '@angular/common';
import { Component, signal } from '@angular/core';
import streamSaver from 'streamsaver';
import { compressStream, decompressStream } from 'zstd-stream';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.html',
})
export class App {
  status = signal('Ready');
  error = signal<string | null>(null);
  isProcessing = signal(false);
  progress = signal(0);
  fileName = signal('');
  mode = signal<'compress' | 'decompress' | null>(null);

  async onFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.fileName.set(file.name);
    this.error.set(null);
    this.progress.set(0);

    const isZstFile = file.name.toLowerCase().endsWith('.zst');
    this.mode.set(isZstFile ? 'decompress' : 'compress');
    this.isProcessing.set(true);
    this.status.set(isZstFile ? 'Decompressing...' : 'Compressing...');

    try {
      await this.processFile(file, isZstFile);
      this.status.set(`✅ ${isZstFile ? 'Decompression' : 'Compression'} complete!`);
      this.progress.set(100);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Operation failed');
      this.status.set('❌ Failed');
    } finally {
      this.isProcessing.set(false);
      (event.target as HTMLInputElement).value = '';
    }
  }

  private async processFile(file: File, decompress: boolean): Promise<void> {
    const streamFn = decompress ? decompressStream : compressStream;
    const outputName = decompress ? file.name.replace(/\.zst$/i, '') : `${file.name}.zst`;

    const options = {
      ...(decompress ? {} : { level: 9 }),
      onProgress: (bytes: number) => {
        this.progress.set(Math.min(99, Math.round((bytes / file.size) * 100)));
      },
    };

    const stream = await streamFn(file.stream(), options);
    await this.saveStream(stream, outputName);
  }

  private async saveStream(stream: ReadableStream<Uint8Array>, filename: string): Promise<void> {
    const writer = streamSaver.createWriteStream(filename).getWriter();
    const reader = stream.getReader();
    const chunkSize = navigator.userAgent.toLowerCase().includes('firefox')
      ? 64 * 1024
      : 256 * 1024;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.length > chunkSize) {
          for (let offset = 0; offset < value.length; offset += chunkSize) {
            await writer.write(value.slice(offset, offset + chunkSize));
          }
        } else {
          await writer.write(value);
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort();
      throw err;
    }
  }

  triggerFileInput(): void {
    document.getElementById('fileInput')?.click();
  }
}
