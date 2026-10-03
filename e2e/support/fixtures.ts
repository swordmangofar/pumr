import { expect, test as base, type Page } from '@playwright/test';
import type { Message, ModelInfo, Project, Session } from '../../src/app/core/models';
import { FALLBACK_SETTINGS } from '../../src/app/core/settings-defaults';
import {
  installFakeBackend,
  type FakeCall,
  type FakeEmit,
  type FakeHandle,
  type FakeReply,
  type FakeResume,
  type FakeSeed,
} from './fake-backend';

export const MODEL_ID = 'anthropic/claude-sonnet-5';

export function model(id = MODEL_ID, name = 'Claude Sonnet 5'): ModelInfo {
  return {
    id,
    name,
    description: 'Test model',
    contextLength: 200_000,
    promptPricePerM: 3,
    completionPricePerM: 15,
    cacheReadPricePerM: 0.3,
    supportsReasoning: true,
    supportsVision: true,
    supportsTools: true,
    inputModalities: ['text', 'image'],
    supportedParameters: ['tools', 'reasoning'],
    created: 1_700_000_000,
    source: /^[^/:]+:/.test(id) ? id.slice(0, id.indexOf(':')) : 'openrouter',
  };
}

export function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    path: '/Users/e2e/code/demo-app',
    name: 'demo-app',
    createdAt: 1_700_000_000_000,
    lastOpenedAt: 1_700_000_000_000,
    sessionCount: 0,
    totalCost: 0,
    color: null,
    icon: null,
    iconImage: null,
    ...patch,
  };
}

export function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Existing session',
    model: MODEL_ID,
    reasoningEffort: 'medium',
    provider: null,
    systemPrompt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    messageCount: 0,
    parentSessionId: null,
    agentStatus: null,
    archived: false,
    modeId: 'coding',
    limitReached: false,
    autoContinue: false,
    interrupted: false,
    ...patch,
  };
}

export function chatMessage(
  role: Message['role'],
  content: string,
  patch: Partial<Message> = {},
): Message {
  return {
    id: `${role}-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    seq: 1,
    role,
    content,
    reasoning: '',
    model: role === 'assistant' ? MODEL_ID : null,
    provider: null,
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    createdAt: 1_700_000_000_000,
    toolCalls: [],
    toolCallId: null,
    toolName: null,
    status: null,
    changes: [],
    baseCommit: null,
    attachments: [],
    mentions: [],
    context: '',
    durationMs: 0,
    ...patch,
  };
}

export function seed(patch: Partial<FakeSeed> = {}): FakeSeed {
  return {
    settings: {
      ...FALLBACK_SETTINGS,
      defaultModel: MODEL_ID,
      // Keep tests quiet and deterministic.
      soundsEnabled: false,
      keepAwake: false,
    },
    apiKeys: ['openrouter'],
    projects: [],
    sessions: [],
    messages: [],
    models: [model()],
    files: {},
    repo: false,
    pickFolder: null,
    confirm: true,
    replies: [],
    chunkDelayMs: 5,
    ...patch,
  };
}

/** Test-side view of the fake backend running inside the page. */
export class Backend {
  constructor(private readonly page: Page) {}

  handle(): Promise<FakeHandle> {
    return this.page.evaluate(() => (window as unknown as { __pumrFake: FakeHandle }).__pumrFake);
  }

  async calls(cmd?: string): Promise<FakeCall[]> {
    const { calls } = await this.handle();
    return cmd ? calls.filter((call) => call.cmd === cmd) : calls;
  }

  async lastCall(cmd: string): Promise<FakeCall | undefined> {
    return (await this.calls(cmd)).at(-1);
  }

  /** Resolves once the frontend has invoked `cmd` at least `count` times. */
  async waitForCall(cmd: string, count = 1): Promise<FakeCall> {
    await expect.poll(async () => (await this.calls(cmd)).length).toBeGreaterThanOrEqual(count);
    return (await this.calls(cmd))[count - 1];
  }

  async state(): Promise<FakeHandle['state']> {
    return (await this.handle()).state;
  }

  queueReply(reply: FakeReply): Promise<void> {
    return this.page.evaluate((next) => {
      (window as unknown as { __pumrFake: FakeHandle }).__pumrFake.replies.push(next);
    }, reply);
  }

  /** Delivers a backend event to the app, as the Rust side would emit it. */
  emit(event: string, payload: unknown = null): Promise<void> {
    return this.page.evaluate(
      ([name, data]) => {
        (window as unknown as { __pumrFakeEmit: FakeEmit }).__pumrFakeEmit(name as string, data);
      },
      [event, payload],
    );
  }

  /** Lets every turn waiting in a `pause` step go on. */
  resume(): Promise<void> {
    return this.page.evaluate(() => {
      (window as unknown as { __pumrFakeResume: FakeResume }).__pumrFakeResume();
    });
  }

  setPickFolder(path: string | null): Promise<void> {
    return this.page.evaluate((value) => {
      (window as unknown as { __pumrFake: FakeHandle }).__pumrFake.pickFolder = value;
    }, path);
  }
}

export interface PumrApp {
  /** Installs the fake backend with `seed` and loads the app past the splash. */
  start(seed?: FakeSeed): Promise<void>;
  backend: Backend;
}

export const test = base.extend<{ app: PumrApp }>({
  app: async ({ page }, use) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const backend = new Backend(page);
    let started = false;
    await use({
      backend,
      async start(initial = seed()) {
        await page.addInitScript(installFakeBackend, initial);
        await page.goto('/');
        await expect(page.getByTestId('splash')).toHaveCount(0);
        started = true;
      },
    });

    // Every command the app sends must be one the fake knows, so a new
    // backend call cannot silently resolve to `null` in these tests.
    if (started && !page.isClosed()) {
      const { unhandled } = await backend.handle();
      expect([...new Set(unhandled)], 'Tauri commands the fake backend does not handle').toEqual(
        [],
      );
    }
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
