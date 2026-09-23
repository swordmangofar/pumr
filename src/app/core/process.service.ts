import { Injectable, signal } from '@angular/core';
import { api } from './api';
import { ProcessInfo } from './models';

/** How often running processes are polled from the backend. */
const PROCESS_POLL_MS = 3000;

/**
 * Owns the running-process list and its polling loop, keeping the timer out of
 * `WorkspaceService`.
 */
@Injectable({ providedIn: 'root' })
export class ProcessService {
  private readonly processesState = signal<ProcessInfo[]>([]);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly processes = this.processesState.asReadonly();

  async refresh(): Promise<void> {
    try {
      this.processesState.set(await api.listProcesses());
    } catch {
      // process list is best effort
    }
  }

  async stop(processId: string): Promise<void> {
    await api.stopProcess(processId);
    await this.refresh();
  }

  startPolling(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.refresh(), PROCESS_POLL_MS);
  }
}