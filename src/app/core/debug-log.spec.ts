import {
  applyRedactions,
  buildDebugLog,
  chunkDebugLog,
  DebugLogInput,
  debugLogFileName,
  diffLineMatches,
  MAX_SECTION_CHARS,
  planRedactions,
  redactionDiff,
  searchParts,
} from './debug-log';
import { Message, Session, SystemInfo } from './models';

const SYSTEM: SystemInfo = {
  osName: 'macOS',
  osVersion: '15.6 (24G84)',
  kernel: 'Darwin 25.6.0',
  arch: 'aarch64',
  appVersion: '0.6.2',
  webviewVersion: '20621.3.11',
  desktop: null,
  appImage: false,
};

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Fix the login',
    model: 'anthropic/claude-sonnet-5',
    reasoningEffort: 'medium',
    provider: null,
    systemPrompt: null,
    createdAt: Date.UTC(2026, 8, 30, 12, 0, 0),
    updatedAt: Date.UTC(2026, 8, 30, 12, 5, 0),
    cost: 0.0123,
    promptTokens: 1200,
    completionTokens: 300,
    cachedTokens: 800,
    messageCount: 3,
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

function message(role: Message['role'], content: string, patch: Partial<Message> = {}): Message {
  return {
    id: `${role}-1`,
    sessionId: 'session-1',
    seq: 1,
    role,
    content,
    reasoning: '',
    model: null,
    provider: null,
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    createdAt: Date.UTC(2026, 8, 30, 12, 1, 0),
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

function input(patch: Partial<DebugLogInput> = {}): DebugLogInput {
  return {
    exportedAt: Date.UTC(2026, 8, 30, 12, 10, 0),
    system: SYSTEM,
    settings: [['UI language', 'de']],
    context: {
      systemPrompt: 'You are pumr.',
      systemPromptSource: 'default',
      globalPrompts: [],
      mode: null,
      rules: [{ path: 'AGENTS.md', scope: 'project', content: 'Use pnpm.' }],
    },
    agents: [
      {
        session: session(),
        messages: [
          message('user', 'Why does `pnpm test` fail?', {
            mentions: [{ kind: 'file', value: 'src/login.ts', label: 'login.ts' }],
          }),
          message('assistant', 'Let me run it.', {
            id: 'assistant-1',
            model: 'anthropic/claude-sonnet-5',
            status: 'ok',
            toolCalls: [
              { id: 'call-1', name: 'bash', arguments: '{"command":"pnpm test"}' },
              { id: 'call-2', name: 'read', arguments: '{"path":"src/login.ts"}' },
            ],
          }),
          message('tool', 'Error: expected ``` to close', {
            id: 'tool-1',
            toolCallId: 'call-1',
            toolName: 'bash',
            status: 'error',
            durationMs: 1500,
          }),
        ],
        liveTools: [],
        error: 'Provider returned 400: tool_use ids without tool_result',
        streaming: false,
      },
      {
        session: session({ id: 'sub-1', title: 'Explore tests', parentSessionId: 'session-1' }),
        messages: [],
        liveTools: [],
        error: null,
        streaming: false,
      },
    ],
    audit: [
      {
        id: 1,
        createdAt: Date.UTC(2026, 8, 30, 12, 2, 0),
        sessionId: 'session-1',
        conversationId: 'session-1',
        kind: 'command',
        subject: 'pnpm test',
        allowed: true,
        decidedBy: 'auto',
        decision: null,
        reason: 'Read-only package script',
        rule: null,
      },
    ],
    ...patch,
  };
}

describe('buildDebugLog', () => {
  it('lists the environment, context, every agent and the permission log', () => {
    const log = buildDebugLog(input());

    expect(log.startsWith('# pumr chat debug log\n')).toBe(true);
    expect(log).toContain('- App: pumr 0.6.2');
    expect(log).toContain('- OS: macOS 15.6 (24G84)');
    expect(log).toContain('- Kernel: Darwin 25.6.0');
    expect(log).toContain('- Architecture: aarch64');
    expect(log).not.toContain('AppImage');
    expect(log).toContain('- UI language: de');
    expect(log).toContain('## Errors shown in the chat');
    expect(log).toContain('tool_use ids without tool_result');
    expect(log).toContain('### System prompt (default)');
    expect(log).toContain('### Project rules: AGENTS.md (project)');
    expect(log).toContain('## Main agent: Fix the login');
    expect(log).toContain('## Subagent: Explore tests');
    expect(log).toContain('- Parent session: session-1');
    expect(log).toContain('- Mention: file: src/login.ts');
    expect(log).toContain('### 3. Tool call: bash (error, 1.5 s) · 2026-09-30T12:01:00.000Z');
    expect(log).toContain('"command": "pnpm test"');
    expect(log).toContain(
      '- 2026-09-30T12:02:00.000Z · allowed · command · `pnpm test` · decided by auto · why: Read-only package script',
    );
  });

  it('fences text that contains backticks with a longer fence', () => {
    const log = buildDebugLog(input());
    expect(log).toContain('````text\nError: expected ``` to close\n````');
  });

  it('lists tool calls that never got a result', () => {
    const log = buildDebugLog(input());
    const unanswered = log.slice(log.indexOf('### Tool calls without a result'));
    expect(unanswered).toContain('`read` (call ID `call-2`)');
    expect(unanswered).not.toContain('call-1');
  });

  it('shortens very long sections in the middle', () => {
    const long = `START${'x'.repeat(MAX_SECTION_CHARS * 2)}END`;
    const log = buildDebugLog(
      input({
        agents: [
          {
            session: session(),
            messages: [message('tool', long)],
            liveTools: [],
            error: null,
            streaming: false,
          },
        ],
      }),
    );
    expect(log).toContain('START');
    expect(log).toContain('END');
    expect(log).toMatch(/\[… [\d,]+ characters omitted …\]/);
    expect(log.length).toBeLessThan(MAX_SECTION_CHARS * 1.5);
  });

  it('says what decides the prompts: the saved lists and what holds for this chat', () => {
    const log = buildDebugLog(
      input({
        permissions: {
          saved: {
            extraFolders: ['/work/shared'],
            readFolders: ['/opt/jdks'],
            pathFolders: [],
            secretFolders: [],
            commandRules: [{ kind: 'glob', value: './gradlew *' }],
            deniedCommandRules: [],
            sandboxWritableFolders: ['~/.gradle'],
            sandboxUnreadableFolders: ['~/.ssh'],
            sandboxExcludedCommands: ['pnpm e2e'],
          },
          live: {
            commandPath: '/opt/jdks/11/bin:/usr/bin:/bin',
            loginShell: false,
            projectVariables: ['JAVA_HOME', 'PATH'],
            sessionFolders: [],
            sessionReadFolders: ['/usr/lib/jvm'],
            chatPathFolders: ['/opt/jdks/11/bin'],
            chatSecretFolders: [],
            chatCommandRules: [{ kind: 'exact', value: 'npm run lint:ci' }],
          },
        },
      }),
    );
    const section = log.slice(log.indexOf('## Permissions'), log.indexOf('## Errors shown'));
    expect(section).toContain('- PATH of commands: /opt/jdks/11/bin:/usr/bin:/bin');
    expect(section).toContain('- Environment of commands: as pumr was started');
    expect(section).toContain('- Variables set by the project: JAVA_HOME, PATH');
    expect(section).toContain('- Folders the assistant may change:\n  - `/work/shared`');
    expect(section).toContain('- Folders the assistant may read:\n  - `/opt/jdks`');
    expect(section).toContain('- The same until the app restarts:\n  - `/usr/lib/jvm`');
    expect(section).toContain('- Folders trusted on PATH: -\n- The same in this chat:\n  - `/opt/jdks/11/bin`');
    expect(section).toContain('- Allowed command rules:\n  - glob `./gradlew *`');
    expect(section).toContain('  - exact `npm run lint:ci`');
    expect(section).toContain('- Sandbox: commands that run outside it:\n  - `pnpm e2e`');
  });

  it('says when what holds for the chat could not be read, and leaves the section out unasked', () => {
    const missing = buildDebugLog(input({ permissions: { saved: null, live: null } }));
    expect(missing).toContain('- What holds for this chat only could not be read.');
    expect(missing).toContain('- Folders the assistant may change: -');
    expect(buildDebugLog(input())).not.toContain('## Permissions');
  });

  it('says when system information or the permission log is missing', () => {
    const log = buildDebugLog(input({ system: null, audit: null }));
    expect(log).toContain('System information could not be read.');
    expect(log).toContain('The permission log could not be read.');
  });
});

describe('chunkDebugLog', () => {
  it('keeps every character and splits between sections', () => {
    const log = buildDebugLog(input());
    const chunks = chunkDebugLog(log, 400);
    expect(chunks.join('')).toBe(log);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 400)).toBe(true);
    expect(chunks.slice(1).every((chunk) => /^#{1,3} |^[^#]/.test(chunk))).toBe(true);
  });

  it('splits a single long line', () => {
    const chunks = chunkDebugLog('a'.repeat(25), 10);
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});

describe('redaction', () => {
  const log =
    '# pumr chat debug log\nPath /Users/jane/acme/src and jane.doe@example.com.\nAsk Jane or janet; mail jane.doe@example.com again. Key sk-123456.';

  it('numbers placeholders per kind and turns the home folder into ~', () => {
    const redactions = planRedactions(
      log,
      [
        { text: 'jane.doe@example.com', kind: 'email' },
        { text: 'Jane', kind: 'name' },
        { text: 'acme', kind: 'org' },
        { text: 'sk-123456', kind: 'secret' },
        { text: 'not in the log', kind: 'name' },
        { text: 'Jane', kind: 'username' },
      ],
      '/Users/jane/',
    );
    expect(redactions.map(({ text, placeholder, count }) => [text, placeholder, count])).toEqual([
      ['/Users/jane', '~', 1],
      ['acme', '[ORG_1]', 1],
      ['jane.doe@example.com', '[EMAIL_1]', 2],
      ['Jane', '[NAME_1]', 1],
      ['sk-123456', '[SECRET_1]', 1],
    ]);

    const redacted = applyRedactions(log, redactions);
    expect(redacted).toContain('Path ~/[ORG_1]/src and [EMAIL_1].');
    // Whole words only: "janet" stays.
    expect(redacted).toContain('Ask [NAME_1] or janet; mail [EMAIL_1] again. Key [SECRET_1].');
    expect(redacted).toContain('> Anonymized before export: 5 personal or secret values');
    expect(redacted.startsWith('# pumr chat debug log\n\n> Anonymized')).toBe(true);
  });

  it('leaves disabled redactions in place', () => {
    const redactions = planRedactions(log, [{ text: 'sk-123456', kind: 'secret' }], null).map(
      (redaction) => ({ ...redaction, enabled: false }),
    );
    expect(applyRedactions(log, redactions)).toBe(log);
  });

  it('matches Windows home folders inside JSON arguments', () => {
    const text = 'cwd C:\\Users\\Bob\\app and {"path": "C:\\\\Users\\\\Bob\\\\app"}';
    const redactions = planRedactions(text, [], 'C:\\Users\\Bob');
    expect(applyRedactions(text, redactions)).toContain('cwd ~\\app and {"path": "~\\\\app"}');
  });
});

describe('debugLogFileName', () => {
  it('stamps the local export time', () => {
    const at = new Date(2026, 8, 30, 14, 5).getTime();
    expect(debugLogFileName(at, false)).toBe('pumr-debug-log-2026-09-30-1405.md');
    expect(debugLogFileName(at, true)).toBe('pumr-debug-log-2026-09-30-1405-anonymized.md');
  });
});

describe('redactionDiff', () => {
  it('lists only changed lines, with the values and placeholders marked', () => {
    const log = '# log\nmail jane@example.com now\nnothing here\nkey sk-1234 and jane@example.com';
    const redactions = planRedactions(
      log,
      [
        { text: 'jane@example.com', kind: 'email' },
        { text: 'sk-1234', kind: 'secret' },
      ],
      null,
    );
    const diff = redactionDiff(log, redactions);
    expect(diff.map((line) => line.number)).toEqual([2, 4]);
    expect(diff[1].before).toEqual([
      { text: 'key ', match: null },
      { text: 'sk-1234', match: 1 },
      { text: ' and ', match: null },
      { text: 'jane@example.com', match: 2 },
    ]);
    expect(diff[1].after.map((part) => part.text).join('')).toBe('key [SECRET_1] and [EMAIL_1]');
    expect(diffLineMatches(diff[0], 'JANE')).toBe(true);
    expect(diffLineMatches(diff[0], 'secret')).toBe(false);

    const [, secret] = redactions;
    expect(
      redactionDiff(log, [redactions[0], { ...secret, enabled: false }]).map((line) => line.number),
    ).toEqual([2, 4]);
    expect(
      redactionDiff(
        log,
        redactions.map((r) => ({ ...r, enabled: false })),
      ),
    ).toEqual([]);
  });
});

describe('searchParts', () => {
  it('numbers case-insensitive matches', () => {
    expect(searchParts('Error: bad error', 'error')).toEqual({
      parts: [
        { text: 'Error', match: 0 },
        { text: ': bad ', match: null },
        { text: 'error', match: 1 },
      ],
      count: 2,
    });
    expect(searchParts('a.b', '.')).toEqual({
      parts: [
        { text: 'a', match: null },
        { text: '.', match: 0 },
        { text: 'b', match: null },
      ],
      count: 1,
    });
    expect(searchParts('text', '  ')).toEqual({ parts: [{ text: 'text', match: null }], count: 0 });
  });
});
