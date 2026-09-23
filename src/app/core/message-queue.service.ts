import { Injectable, signal } from '@angular/core';
import { SendMessageArgs } from './models';

/**
 * Per-session follow-up prompt queue. Holds only the state; dispatching stays in
 * `WorkspaceService` because it needs to start a send.
 */
@Injectable({ providedIn: 'root' })
export class MessageQueueService {
  private readonly queueState = signal<Record<string, SendMessageArgs[]>>({});

  readonly queue = this.queueState.asReadonly();

  forSession(sessionId: string): SendMessageArgs[] {
    return this.queueState()[sessionId] ?? [];
  }

  first(sessionId: string): SendMessageArgs | undefined {
    return this.queueState()[sessionId]?.[0];
  }

  enqueue(args: SendMessageArgs): void {
    this.queueState.update((state) => ({
      ...state,
      [args.sessionId]: [...(state[args.sessionId] ?? []), args],
    }));
  }

  remove(sessionId: string, index: number): void {
    this.queueState.update((state) => {
      const queue = state[sessionId] ?? [];
      if (index < 0 || index >= queue.length) {
        return state;
      }
      return { ...state, [sessionId]: queue.filter((_, i) => i !== index) };
    });
  }

  removeFirst(sessionId: string, args: SendMessageArgs): void {
    this.queueState.update((state) => {
      const queue = state[sessionId] ?? [];
      if (queue[0] !== args) {
        return state;
      }
      return { ...state, [sessionId]: queue.slice(1) };
    });
  }

  clear(sessionId: string): void {
    this.queueState.update((state) => {
      if (!state[sessionId]?.length) {
        return state;
      }
      const next = { ...state };
      delete next[sessionId];
      return next;
    });
  }
}