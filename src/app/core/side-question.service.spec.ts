import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Channel } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { SideAnswer, SideAnswerEvent } from './models';
import { SideQuestionService, sideQuestionOf } from './side-question.service';
import { WorkspaceService } from './workspace.service';

describe('sideQuestionOf', () => {
  it('reads the question of a /btw draft', () => {
    expect(sideQuestionOf('/btw why is the build slow?')).toBe('why is the build slow?');
    expect(sideQuestionOf('  /BTW   first line\nsecond line  ')).toBe('first line\nsecond line');
    expect(sideQuestionOf('/btw\nasked on the next line')).toBe('asked on the next line');
  });

  it('has no question while only the command is typed', () => {
    expect(sideQuestionOf('/btw')).toBe('');
    expect(sideQuestionOf('/btw   ')).toBe('');
  });

  it('leaves every other draft alone', () => {
    expect(sideQuestionOf('fix the build')).toBeNull();
    expect(sideQuestionOf('/btwice more')).toBeNull();
    expect(sideQuestionOf('see /btw for details')).toBeNull();
    expect(sideQuestionOf('')).toBeNull();
  });
});

describe('SideQuestionService', () => {
  let service: SideQuestionService;
  let refreshSpend: ReturnType<typeof vi.fn>;
  let asked: {
    channel: Channel<SideAnswerEvent>;
    resolve: (answer: SideAnswer) => void;
    reject: (error: unknown) => void;
  }[];
  const frames: FrameRequestCallback[] = [];

  function nextFrame(): void {
    for (const run of frames.splice(0)) {
      run(0);
    }
  }

  beforeEach(() => {
    // `new Channel()` registers its callback with the Tauri runtime.
    let callbackId = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: { transformCallback: () => ++callbackId, unregisterCallback: () => {} },
    });
    // Text reaches the state once per frame; run frames when the test says so.
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      frames.push(run);
      return frames.length;
    });
    asked = [];
    vi.spyOn(api, 'askSideQuestion').mockImplementation(
      (_sessionId, _question, _model, channel) =>
        new Promise<SideAnswer>((resolve, reject) => asked.push({ channel, resolve, reject })),
    );
    vi.spyOn(api, 'stopGeneration').mockResolvedValue(undefined);
    refreshSpend = vi.fn(async () => {});
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: { activeAgent: signal({ id: 'chat' }), refreshSpend },
        },
      ],
    });
    service = TestBed.inject(SideQuestionService);
  });

  afterEach(() => {
    frames.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('streams the answer into the active session and finishes with the reply', async () => {
    const done = service.ask('chat', 'why?', 'model');
    expect(service.active()).toMatchObject({ question: 'why?', answer: '', status: 'running' });
    expect(api.askSideQuestion).toHaveBeenCalledWith('chat', 'why?', 'model', asked[0].channel);

    asked[0].channel.onmessage({ kind: 'delta', text: 'Because ' });
    asked[0].channel.onmessage({ kind: 'delta', text: 'of the cache.' });
    expect(service.active()?.answer).toBe('');
    nextFrame();
    expect(service.active()?.answer).toBe('Because of the cache.');

    asked[0].channel.onmessage({ kind: 'delta', text: ' Really' });
    asked[0].resolve({ answer: 'Because of the cache. Really.', cancelled: false });
    await done;

    expect(service.active()).toMatchObject({
      answer: 'Because of the cache. Really.',
      status: 'done',
      error: null,
    });
    expect(refreshSpend).toHaveBeenCalled();
  });

  it('keeps what arrived when the answer is stopped', async () => {
    const done = service.ask('chat', 'why?', 'model');
    asked[0].channel.onmessage({ kind: 'delta', text: 'Because' });

    await service.stop('chat');
    expect(api.stopGeneration).toHaveBeenCalledWith('side-question:chat');

    asked[0].resolve({ answer: 'Because', cancelled: true });
    await done;
    expect(service.active()).toMatchObject({ answer: 'Because', status: 'stopped' });

    // Nothing is running any more, so there is nothing left to stop.
    await service.stop('chat');
    expect(api.stopGeneration).toHaveBeenCalledTimes(1);
  });

  it('shows why a question could not be answered', async () => {
    const done = service.ask('chat', 'why?', 'model');
    asked[0].reject('No API key stored for this provider.');
    await done;

    expect(service.active()).toMatchObject({
      status: 'error',
      error: 'No API key stored for this provider.',
    });
  });

  it('lets a newer question replace the one before it', async () => {
    const first = service.ask('chat', 'first?', 'model');
    const second = service.ask('chat', 'second?', 'model');

    // The backend cancels the first one; its late text and result are dropped.
    asked[0].channel.onmessage({ kind: 'delta', text: 'old text' });
    asked[1].channel.onmessage({ kind: 'delta', text: 'new text' });
    asked[0].resolve({ answer: 'old text', cancelled: true });
    await first;
    expect(service.active()).toMatchObject({
      question: 'second?',
      answer: 'new text',
      status: 'running',
    });

    asked[1].resolve({ answer: 'new text', cancelled: false });
    await second;
    expect(service.active()).toMatchObject({ answer: 'new text', status: 'done' });
  });

  it('keeps one question per session', async () => {
    void service.ask('other', 'elsewhere?', 'model');
    expect(service.active()).toBeNull();
    expect(service.forSession('other')?.question).toBe('elsewhere?');
  });

  it('stops and forgets a dismissed question', async () => {
    const done = service.ask('chat', 'why?', 'model');
    service.dismiss('chat');

    expect(service.active()).toBeNull();
    expect(api.stopGeneration).toHaveBeenCalledWith('side-question:chat');

    asked[0].channel.onmessage({ kind: 'delta', text: 'late' });
    asked[0].resolve({ answer: 'late', cancelled: true });
    await done;
    nextFrame();
    expect(service.active()).toBeNull();
  });
});
