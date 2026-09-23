import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { Update } from '@tauri-apps/plugin-updater';
import { isTauri } from './api';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class UpdaterService {
  private update: Update | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly destroyRef = inject(DestroyRef);

  readonly status = signal<UpdateStatus>('idle');
  readonly version = signal<string | null>(null);
  readonly notes = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly progress = signal(0);

  readonly available = computed(() => this.status() === 'available');
  readonly downloading = computed(() => this.status() === 'downloading');
  readonly busy = computed(() => this.status() === 'checking' || this.status() === 'downloading');

  constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  start(): void {
    if (!isTauri() || this.timer) {
      return;
    }
    void this.check();
    this.timer = setInterval(() => {
      if (this.status() === 'idle' || this.status() === 'error') {
        void this.check();
      }
    }, UPDATE_POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<void> {
    if (!isTauri() || this.busy()) {
      return;
    }
    this.status.set('checking');
    this.error.set(null);
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        this.update = update;
        this.version.set(update.version);
        this.notes.set(update.body ?? null);
        this.status.set('available');
      } else {
        this.update = null;
        this.version.set(null);
        this.notes.set(null);
        this.status.set('idle');
      }
    } catch (error) {
      this.error.set(String(error));
      this.status.set('error');
    }
  }

  async install(): Promise<void> {
    if (!this.update || this.status() === 'downloading') {
      return;
    }
    this.status.set('downloading');
    this.progress.set(0);
    this.error.set(null);
    try {
      let total = 0;
      let downloaded = 0;
      await this.update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            this.progress.set(Math.min(100, Math.round((downloaded / total) * 100)));
          }
        } else if (event.event === 'Finished') {
          this.progress.set(100);
        }
      });
      this.status.set('ready');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (error) {
      this.error.set(String(error));
      this.status.set('error');
    }
  }
}
