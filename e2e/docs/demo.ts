import { expect, type Locator, type Page } from '@playwright/test';
import type {
  FileChange,
  FileDiff,
  Mode,
  ModelInfo,
  Project,
  Settings,
} from '../../src/app/core/models';
import { installFakeBackend, type FakeReply, type FakeSeed } from '../support/fake-backend';
import { model, project, seed, session } from '../support/fixtures';

/** Demo data shared by the README scenes. */

export const PROJECT_PATH = '/Users/you/Projects/acme-storefront';

export const DEMO_PROJECTS: Project[] = [
  project({ id: 'project-1', name: 'acme-storefront', path: PROJECT_PATH, color: '#3b82f6' }),
  project({
    id: 'project-2',
    name: 'pumr',
    path: '/Users/you/Projects/pumr',
    color: '#f59e0b',
    lastOpenedAt: 1_699_000_000_000,
  }),
];

const hour = 3_600_000;
const t0 = Date.UTC(2026, 8, 27, 9);

export const DEMO_SESSIONS = [
  session({ id: 'session-1', title: 'Add Stripe checkout', updatedAt: t0 + 4 * hour, cost: 0.31 }),
  session({ id: 'session-2', title: 'Fix cart totals', updatedAt: t0 + 3 * hour, cost: 0.12 }),
  session({ id: 'session-3', title: 'Migrate to signals', updatedAt: t0 + 2 * hour, cost: 0.84 }),
  session({ id: 'session-4', title: 'Dark mode audit', updatedAt: t0 + hour, cost: 0.05 }),
  session({
    id: 'session-5',
    projectId: 'project-2',
    title: 'Release notes for 0.7',
    updatedAt: t0,
  }),
];

const mode = (id: string, name: string, description: string, patch: Partial<Mode> = {}): Mode => ({
  id,
  name,
  description,
  systemPrompt: '',
  userPromptIds: [],
  mcpServers: [],
  skills: [],
  includeGlobalPrompts: true,
  includeProjectRules: true,
  planOnly: false,
  builtin: true,
  ...patch,
});

/** Mirrors `config::default_modes` in the Rust backend, plus one custom mode. */
export const DEMO_MODES: Mode[] = [
  mode(
    'coding',
    'Coding',
    'Full coding mode with every activated prompt, rule, MCP server and skill.',
  ),
  mode('planning', 'Planning', 'Plans a feature with you. Cannot write or edit files.', {
    planOnly: true,
  }),
  mode('verification', 'Verification', 'Runs the build and tests and reports PASS/FAIL evidence.'),
  mode('nacked', 'Nacked', 'Fast mode: only the main system prompt.', {
    includeGlobalPrompts: false,
    includeProjectRules: false,
  }),
  mode('payments-review', 'Payments review', 'Reviews payment code against our Stripe rules.', {
    builtin: false,
    systemPrompt:
      'You review payment code. Flag any POST that moves money without an idempotency key, ' +
      'and any amount that is not integer cents.',
    userPromptIds: ['stripe-conventions', 'strict-reviewer'],
    mcpServers: ['github', 'sentry'],
    skills: ['stripe-best-practices'],
  }),
];

export const DEMO_USER_PROMPTS = [
  {
    id: 'stripe-conventions',
    name: 'Stripe conventions',
    prompt: 'Money is integer cents. Every Stripe POST sends an idempotency key.',
  },
  {
    id: 'strict-reviewer',
    name: 'Strict reviewer',
    prompt: 'Review like a senior engineer: point out risks first, then nits.',
  },
  {
    id: 'changelog',
    name: 'Changelog entry',
    prompt: 'Finish every change with a one-line CHANGELOG entry.',
  },
];

export const DEMO_SKILLS = [
  {
    path: '/Users/you/.claude/skills',
    label: 'Claude Code',
    source: 'claude',
    enabled: true,
    skills: [
      { name: 'frontend-design', enabled: true, description: 'Distinctive, production-grade UI.' },
      { name: 'release-notes', enabled: true, description: 'Draft release notes from git.' },
    ],
  },
  {
    path: '/Users/you/.agents/skills',
    label: 'Agents',
    source: 'agents',
    enabled: true,
    skills: [
      { name: 'stripe-best-practices', enabled: true, description: 'Stripe API conventions.' },
      { name: 'postgres-migrations', enabled: true, description: 'Safe schema migrations.' },
    ],
  },
];

const priced = (
  id: string,
  name: string,
  input: number,
  output: number,
  context = 200_000,
): ModelInfo => ({
  ...model(id, name),
  promptPricePerM: input,
  completionPricePerM: output,
  cacheReadPricePerM: input / 10,
  contextLength: context,
});

export const DEMO_MODELS: ModelInfo[] = [
  priced('anthropic/claude-sonnet-5', 'Claude Sonnet 5', 3, 15, 1_000_000),
  priced('anthropic/claude-opus-5-5', 'Claude Opus 5.5', 5, 25, 1_000_000),
  priced('openai/gpt-5.5', 'GPT-5.5', 1.25, 10, 400_000),
  priced('google/gemini-3-pro', 'Gemini 3 Pro', 2, 12, 1_048_576),
  priced('x-ai/grok-5', 'Grok 5', 3, 15, 256_000),
  priced('deepseek/deepseek-v4', 'DeepSeek V4', 0.28, 0.42, 128_000),
  priced('anthropic:claude-opus-5-5', 'Claude Opus 5.5', 5, 25, 1_000_000),
  priced('anthropic:claude-sonnet-5', 'Claude Sonnet 5', 3, 15, 1_000_000),
  priced('anthropic:claude-haiku-4-5', 'Claude Haiku 4.5', 1, 5),
  priced('openai:gpt-5.5', 'GPT-5.5', 1.25, 10, 400_000),
  priced('openai:gpt-5.5-mini', 'GPT-5.5 mini', 0.25, 2, 400_000),
  priced('google:gemini-3-pro', 'Gemini 3 Pro', 2, 12, 1_048_576),
  { ...priced('ollama:qwen3-coder:30b', 'qwen3-coder:30b', 0, 0, 262_144), supportsVision: false },
  { ...priced('ollama:gpt-oss:20b', 'gpt-oss:20b', 0, 0, 131_072), supportsVision: false },
];

const CHECKOUT_OLD = `import { Router } from 'express';
import { getCart } from '../lib/cart';

const router = Router();

router.get('/checkout', async (req, res) => {
  const cart = await getCart(req.user.id);
  const total = cart.items.reduce(sum);
  res.json({ total });
});

export default router;
`;

const CHECKOUT_NEW = `import { Router } from 'express';
import { getCart } from '../lib/cart';
import { stripe } from '../lib/stripe';

const router = Router();

router.get('/checkout', async (req, res) => {
  const cart = await getCart(req.user.id);
  const total = cart.items.reduce(sum, 0);
  res.json({ total });
});

router.post('/checkout/session', async (req, res) => {
  const cart = await getCart(req.user.id);
  if (cart.items.length === 0) {
    return res.status(400).json({ error: 'empty_cart' });
  }

  const session = await stripe.checkout.sessions.create({
    line_items: cart.items.map(toLine),
    mode: 'payment',
    success_url: \`\${base}/success\`,
    cancel_url: \`\${base}/cart\`,
  });

  res.json({ id: session.id, url: session.url });
});

export default router;
`;

export const DEMO_CHANGES: FileChange[] = [
  { path: 'src/routes/checkout.ts', additions: 17, deletions: 1, status: 'modified' },
  { path: 'src/lib/stripe.ts', additions: 11, deletions: 0, status: 'added' },
  { path: 'src/routes/checkout.test.ts', additions: 58, deletions: 0, status: 'added' },
];

export const DEMO_DIFFS: Record<string, FileDiff> = {
  'src/routes/checkout.ts': {
    path: 'src/routes/checkout.ts',
    oldContent: CHECKOUT_OLD,
    newContent: CHECKOUT_NEW,
    language: 'typescript',
    additions: 17,
    deletions: 1,
    status: 'modified',
  },
};

export const CHECKOUT_PROMPT = 'Add a Stripe checkout session endpoint and cover it with tests.';

/** The agent turn most scenes play: read, edit, write, test, summarise. */
export const CHECKOUT_REPLY: FakeReply = {
  steps: [
    {
      kind: 'reasoning',
      text:
        'The cart route already computes totals, so the session endpoint belongs next to it. ' +
        'I need a Stripe client in src/lib, a POST route that rejects empty carts, and tests ' +
        'that mock Stripe so they run offline.',
    },
    {
      kind: 'tool',
      name: 'read',
      summary: 'src/routes/checkout.ts',
      arguments: { path: `${PROJECT_PATH}/src/routes/checkout.ts` },
      result: CHECKOUT_OLD,
    },
    {
      kind: 'tool',
      name: 'grep',
      summary: 'getCart',
      arguments: { pattern: 'getCart' },
      result: 'src/lib/cart.ts:4\nsrc/routes/checkout.ts:2',
    },
    {
      kind: 'tool',
      name: 'edit',
      summary: 'src/routes/checkout.ts',
      arguments: { path: `${PROJECT_PATH}/src/routes/checkout.ts` },
      result: 'Edited src/routes/checkout.ts',
      changes: [DEMO_CHANGES[0]],
    },
    {
      kind: 'tool',
      name: 'write',
      summary: 'src/lib/stripe.ts',
      arguments: { path: `${PROJECT_PATH}/src/lib/stripe.ts` },
      result: 'Wrote src/lib/stripe.ts',
      changes: [DEMO_CHANGES[1]],
    },
    {
      kind: 'tool',
      name: 'write',
      summary: 'src/routes/checkout.test.ts',
      arguments: { path: `${PROJECT_PATH}/src/routes/checkout.test.ts` },
      result: 'Wrote src/routes/checkout.test.ts',
      changes: [DEMO_CHANGES[2]],
    },
    {
      kind: 'tool',
      name: 'bash',
      summary: 'pnpm test checkout',
      arguments: { command: 'pnpm test checkout' },
      result:
        ' ✓ src/routes/checkout.test.ts (6 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)',
    },
    {
      kind: 'text',
      text:
        'Added **`POST /checkout/session`**, which creates a Stripe Checkout session from the ' +
        'current cart:\n\n' +
        '- `src/lib/stripe.ts` builds the client from `STRIPE_SECRET_KEY`.\n' +
        '- Empty carts get a `400 empty_cart` instead of an empty session.\n' +
        '- The old `GET /checkout` crashed on empty carts; `reduce` now starts at `0`.\n\n' +
        'All **6 tests** pass with Stripe mocked, so they run offline.',
    },
  ],
};

export interface DemoOptions {
  seed?: Partial<FakeSeed>;
  settings?: Partial<Settings>;
  /** Tabs open in the header, first one active. */
  tabs?: string[];
  /** Extra backend replies keyed by command, served before the fake's own. */
  overrides?: Record<string, unknown>;
}

/**
 * Starts the app like `app.start`, with extra canned backend replies for
 * views the plain e2e fake leaves empty (diffs, rules, skills, MCP, ...).
 */
export async function startDemo(page: Page, options: DemoOptions = {}): Promise<void> {
  const tabs = options.tabs ?? ['session-1', 'session-4'];
  const initial = seed({
    apiKeys: ['openrouter', 'anthropic', 'openai', 'google'],
    projects: DEMO_PROJECTS,
    sessions: DEMO_SESSIONS,
    models: DEMO_MODELS,
    chunkDelayMs: 1,
    ...options.seed,
  });
  initial.settings = {
    ...initial.settings,
    defaultModel: 'anthropic/claude-sonnet-5',
    modes: DEMO_MODES,
    defaultModeId: 'coding',
    providers: { ...initial.settings.providers, ollama: { baseUrl: '', enabled: true } },
    ...options.settings,
  };

  await page.addInitScript((open) => {
    localStorage.setItem('pumr.tabs', JSON.stringify(open));
    localStorage.setItem('pumr.activeTab', open[0]);
  }, tabs);
  await page.addInitScript(installFakeBackend, initial);
  await page.addInitScript(
    (overrides: Record<string, unknown>) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: object) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const invoke = internals.invoke;
      internals.invoke = async (cmd, args = {}) => {
        if (!(cmd in overrides)) {
          return invoke(cmd, args);
        }
        const value = overrides[cmd];
        // A map keyed by `path` serves per-file replies (diffs).
        const path = (args as { path?: string }).path;
        if (value && typeof value === 'object' && !Array.isArray(value) && path && path in value) {
          return JSON.parse(JSON.stringify((value as Record<string, unknown>)[path]));
        }
        return JSON.parse(JSON.stringify(value));
      };
    },
    {
      get_git_info: { isRepo: true, branch: 'feat/checkout', head: 'a1b2c3d' },
      // Only the built-ins, so custom modes do not offer "Reset to original".
      get_default_modes: DEMO_MODES.filter((entry) => entry.builtin),
      get_spend: {
        totalCost: 1.24,
        todayCost: 0.31,
        sessionCost: 0.31,
        budgetUsd: 20,
        remainingUsd: 18.76,
        promptTokens: 48_200,
        completionTokens: 6_100,
        cachedTokens: 31_000,
      },
      ...options.overrides,
    },
  );
  await page.goto('/');
  await expect(page.getByTestId('splash')).toHaveCount(0);
  // Fonts and icons settle before any capture.
  await page.evaluate(() => document.fonts.ready);
}

/** Sends `prompt` in the active session and waits for the turn to finish. */
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: /Describe your task/ });
  await composer.click();
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');
}

export async function waitForTurn(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
}

/** Screenshot of `target` (or the page) into `docs/`. */
export async function capture(
  page: Page,
  file: string,
  target?: Locator,
  { keepFocus = false, clipHeight = 0 } = {},
): Promise<void> {
  // Let transitions and stick-to-bottom scrolling settle.
  await page.waitForTimeout(600);
  await page.mouse.move(0, 0);
  if (!keepFocus) {
    // Focus rings would otherwise outline the last clicked panel.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  const path = `docs/${file}`;
  if (clipHeight) {
    const width = page.viewportSize()?.width ?? 0;
    await page.screenshot({
      path,
      animations: 'disabled',
      clip: { x: 0, y: 0, width, height: clipHeight },
    });
  } else if (target) {
    await target.screenshot({ path, animations: 'disabled' });
  } else {
    await page.screenshot({ path, animations: 'disabled' });
  }
}

export const DEMO_WORKSPACE = [
  'src',
  'src/lib',
  'src/lib/cart.ts',
  'src/lib/stripe.ts',
  'src/routes',
  'src/routes/checkout.ts',
  'src/routes/checkout.test.ts',
  'src/routes/cart.ts',
  'src/app.ts',
  'package.json',
  'README.md',
  'AGENTS.md',
].map((path) => ({ path, kind: path.includes('.') ? 'file' : 'directory' }));

export const DEMO_MCP = [
  {
    path: '/Users/you/.claude.json',
    label: 'Claude Code',
    source: 'claude',
    format: 'json',
    enabled: true,
    servers: [
      { name: 'github', enabled: true, detail: 'https://api.githubcopilot.com/mcp/' },
      { name: 'playwright', enabled: true, detail: 'npx @playwright/mcp@latest' },
    ],
  },
  {
    path: '/Users/you/.cursor/mcp.json',
    label: 'Cursor',
    source: 'cursor',
    format: 'json',
    enabled: true,
    servers: [
      { name: 'linear', enabled: true, detail: 'https://mcp.linear.app/mcp' },
      { name: 'postgres', enabled: false, detail: 'uvx mcp-server-postgres' },
    ],
  },
  {
    path: '/Users/you/.codex/config.toml',
    label: 'Codex',
    source: 'codex',
    format: 'toml',
    enabled: true,
    servers: [{ name: 'sentry', enabled: true, detail: 'https://mcp.sentry.dev/mcp' }],
  },
];

const endpoint = (providerName: string, uptime: number, tps: number, latency: number) => ({
  name: `${providerName} | anthropic/claude-sonnet-5`,
  slug: providerName.toLowerCase(),
  providerName,
  providerSlug: providerName.toLowerCase().replace(/\s+/g, '-'),
  contextLength: 200_000,
  promptPricePerM: 3,
  completionPricePerM: 15,
  cacheReadPricePerM: 0.3,
  uptimeLast5m: uptime,
  uptimeLast30m: uptime,
  uptimeLast1d: uptime,
  throughputLast30m: tps,
  latencyLast30m: latency,
  maxCompletionTokens: 64_000,
  quantization: null,
  supportsImplicitCaching: true,
  training: false,
  retainsPrompts: false,
});

export const DEMO_ENDPOINTS = [
  endpoint('Anthropic', 99.9, 78, 1.2),
  endpoint('Amazon Bedrock', 99.4, 64, 1.6),
  endpoint('Google Vertex', 98.7, 71, 1.4),
];
