import { Component, signal } from '@angular/core';
import streamSaver from 'streamsaver';
import { compressStream, decompressStream } from 'zstd-stream';

type Mode = 'compress' | 'decompress';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly status = signal('Ready');
  protected readonly error = signal('');
  protected readonly isProcessing = signal(false);
  protected readonly progress = signal(0);
  protected readonly fileName = signal('');
  protected readonly mode = signal<Mode | null>(null);

  protected readonly levels = signal([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]);
  protected readonly selected = signal(9);

  protected onLevelSelected(event: Event) {
    const level = (event?.target as HTMLInputElement).value
    if (!level) return;
    this.selected.set(+level);
  }

  protected async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file
    if (!file) return;

    const mode: Mode = file.name.toLowerCase().endsWith('.zst')
      ? 'decompress'
      : 'compress';

    this.fileName.set(file.name);
    this.mode.set(mode);
    this.error.set('');
    this.progress.set(0);
    this.isProcessing.set(true);
    this.status.set(mode === 'compress' ? 'Compressing…' : 'Decompressing…');

    try {
      const onProgress = (bytes: number) =>
        this.progress.set(Math.min(99, Math.round((bytes / file.size) * 100)));

      const stream =
        mode === 'compress'
          ? await compressStream(file.stream(), { level: this.selected(), onProgress })
          : await decompressStream(file.stream(), { onProgress });

      const outputName =
        mode === 'compress'
          ? `${file.name}.zst`
          : file.name.replace(/\.zst$/i, '');

      // pipeTo drives the transfer and applies backpressure end to end.
      await stream.pipeTo(streamSaver.createWriteStream(outputName));

      this.progress.set(100);
      this.status.set(`✅ ${mode === 'compress' ? 'Compression' : 'Decompression'} complete!`);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Operation failed');
      this.status.set('❌ Failed');
    } finally {
      this.isProcessing.set(false);
    }
  }
}
