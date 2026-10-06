import { Injectable, computed, inject, signal } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { api, sideQuestionCancelKey } from './api';
import { SideAnswerEvent } from './models';
import { WorkspaceService } from './workspace.service';

/** The command that asks a side question from the chat box. */
export const SIDE_QUESTION_COMMAND = 'btw';

const SIDE_QUESTION_RE = /^\/btw(?:\s+([\s\S]*))?$/i;

/**
 * The question of a chat box draft that is a `/btw` command: empty while only
 * the command is typed, `null` for any other draft.
 */
export function sideQuestionOf(draft: string): string | null {
  const match = SIDE_QUESTION_RE.exec(draft.trim());
  return match ? (match[1] ?? '').trim() : null;
}

/** A question asked with `/btw` and what the model has answered so far. */
export interface SideQuestion {
  /** Tells a question apart from the one that replaced it in its session. */
  id: number;
  question: string;
  answer: string;
  status: 'running' | 'done' | 'stopped' | 'error';
  error: string | null;
}

/**
 * Side questions asked with `/btw`: one per session, answered below the chat
 * box without becoming part of the session. They only live in memory.
 */
@Injectable({ providedIn: 'root' })
export class SideQuestionService {
  private readonly workspace = inject(WorkspaceService);

  private readonly state = signal<Record<string, SideQuestion>>({});
  /** Streamed text that has not reached `state` yet, by session. */
  private readonly pending = new Map<string, { id: number; text: string }>();
  private flushScheduled = false;
  private nextId = 0;

  /** The side question of the session the chat shows. */
  readonly active = computed(() => {
    const session = this.workspace.activeAgent();
    return session ? (this.state()[session.id] ?? null) : null;
  });

  forSession(sessionId: string): SideQuestion | null {
    return this.state()[sessionId] ?? null;
  }

  /**
   * Asks `question` about the session with `model` and streams the answer. It
   * replaces the session's previous side question, which the backend cancels
   * if it is still running.
   */
  async ask(sessionId: string, question: string, model: string): Promise<void> {
    const id = ++this.nextId;
    this.pending.delete(sessionId);
    this.state.update((state) => ({
      ...state,
      [sessionId]: { id, question, answer: '', status: 'running', error: null },
    }));
    const channel = new Channel<SideAnswerEvent>();
    channel.onmessage = (event) => this.buffer(sessionId, id, event.text);
    try {
      const result = await api.askSideQuestion(sessionId, question, model, channel);
      this.flush();
      this.patch(sessionId, id, (entry) => ({
        ...entry,
        // The reply is the whole answer, also when a chunk went missing.
        answer: result.answer || entry.answer,
        status: result.cancelled ? 'stopped' : 'done',
      }));
      void this.workspace.refreshSpend();
    } catch (error) {
      this.flush();
      this.patch(sessionId, id, (entry) => ({ ...entry, status: 'error', error: String(error) }));
    }
  }

  /** Stops the answer that is streaming in; what has arrived stays. */
  async stop(sessionId: string): Promise<void> {
    if (this.state()[sessionId]?.status !== 'running') {
      return;
    }
    try {
      await api.stopGeneration(sideQuestionCancelKey(sessionId));
    } catch {
      // The answer then just runs to its end.
    }
  }

  /** Closes the session's side question, stopping it if it still runs. */
  dismiss(sessionId: string): void {
    if (!this.state()[sessionId]) {
      return;
    }
    void this.stop(sessionId);
    this.pending.delete(sessionId);
    this.state.update((state) => {
      const next = { ...state };
      delete next[sessionId];
      return next;
    });
  }

  private patch(sessionId: string, id: number, change: (entry: SideQuestion) => SideQuestion): void {
    this.state.update((state) => {
      const entry = state[sessionId];
      // A newer question took its place, or it was dismissed.
      return entry?.id === id ? { ...state, [sessionId]: change(entry) } : state;
    });
  }

  /** Collects streamed text for one update per frame instead of one per chunk. */
  private buffer(sessionId: string, id: number, text: string): void {
    // A late chunk of a question that was replaced or dismissed.
    if (this.state()[sessionId]?.id !== id) {
      return;
    }
    this.pending.set(sessionId, { id, text: (this.pending.get(sessionId)?.text ?? '') + text });
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    const run = (): void => this.flush();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const waiting = [...this.pending];
    this.pending.clear();
    for (const [sessionId, { id, text }] of waiting) {
      this.patch(sessionId, id, (entry) => ({ ...entry, answer: entry.answer + text }));
    }
  }
}
