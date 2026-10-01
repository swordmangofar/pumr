import {
  LiveToolCall,
  Message,
  Mode,
  PermissionAuditEntry,
  ProjectRule,
  SensitiveFinding,
  Session,
  Settings,
  SystemInfo,
} from './models';

// A chat's debug log, exported as Markdown for the user to hand to an AI
// agent (or a maintainer) that tracks down what went wrong. It is a file
// format rather than UI, so its headings and labels stay in English.

/** Longer sections keep their start and end; the middle is left out. */
export const MAX_SECTION_CHARS = 20_000;
const CLIP_HEAD_CHARS = 12_000;
const CLIP_TAIL_CHARS = 6_000;

/** Size of the excerpts the anonymization model reads one at a time. */
export const ANONYMIZE_CHUNK_CHARS = 12_000;

/** One agent of the exported chat: the main session or a subagent. */
export interface DebugLogAgent {
  session: Session;
  messages: Message[];
  /** Tool calls that are still running and not stored as messages yet. */
  liveTools: LiveToolCall[];
  /** The error the chat shows for this session. */
  error: string | null;
  streaming: boolean;
}

/** What the main session's turns are built from, besides the messages. */
export interface DebugLogContext {
  systemPrompt: string;
  /** Whether the system prompt is the session's own or the default one. */
  systemPromptSource: 'session' | 'default';
  globalPrompts: string[];
  mode: Mode | null;
  rules: ProjectRule[];
}

export interface DebugLogInput {
  exportedAt: number;
  system: SystemInfo | null;
  settings: DebugLogSetting[];
  context: DebugLogContext;
  /** The main session first, then its subagents breadth first. */
  agents: DebugLogAgent[];
  /** The chat's permission decisions; `null` when they could not be read. */
  audit: PermissionAuditEntry[] | null;
}

export type DebugLogSetting = [label: string, value: string | number | boolean | null];

/** The settings that change how a turn runs; none of them are secret. */
export function debugLogSettings(settings: Settings | null): DebugLogSetting[] {
  if (!settings) {
    return [];
  }
  return [
    ['UI language', settings.language],
    ['Reply language', settings.replyLanguage ?? 'auto'],
    ['Default model', settings.defaultModel],
    ['Subagent model', settings.subagentModel],
    ['Compaction model', settings.compactionModel],
    ['Default mode', settings.defaultModeId],
    ['Max tool iterations', settings.maxToolIterations],
    ['Context message limit', settings.contextMessageLimit],
    ['Prompt caching', settings.promptCaching],
    ['Auto-approve read-only commands', settings.autoApproveReadOnly],
    ['Auto-approve package scripts', settings.autoApprovePackageScripts],
    ['Auto-approve project executables', settings.autoApproveProjectExecutables],
    ['Auto-approve project commands', settings.autoApproveProjectCommands],
    ['Ignore gitignored files', settings.ignoreGitignored],
    ['MCP progressive disclosure', settings.mcpProgressiveDisclosure],
    ['Interface zoom', settings.zoom],
  ];
}

/** The global system prompts a mode that includes them adds to every turn. */
export function enabledGlobalPrompts(settings: Settings): string[] {
  const prompts: string[] = [];
  for (const [enabled, prompt] of [
    [settings.securitySystemPromptEnabled, settings.securitySystemPrompt],
    [settings.testingSystemPromptEnabled, settings.testingSystemPrompt],
    [settings.architectureSystemPromptEnabled, settings.architectureSystemPrompt],
  ] as [boolean, string][]) {
    if (enabled && prompt.trim()) {
      prompts.push(prompt);
    }
  }
  for (const prompt of settings.userSystemPrompts) {
    if (prompt.enabled && prompt.prompt.trim()) {
      prompts.push(prompt.prompt);
    }
  }
  return prompts;
}

/** Renders the whole chat as one Markdown document. */
export function buildDebugLog(input: DebugLogInput): string {
  const out: string[] = [
    '# pumr chat debug log',
    '',
    `Exported ${iso(input.exportedAt)}. This file holds the whole chat: prompts, model replies and reasoning, tool arguments and outputs, and the permission decisions. Look at the Error sections, tool calls with status \`error\` or \`denied\`, and tool calls without a result to see what went wrong. Sections longer than ${MAX_SECTION_CHARS.toLocaleString('en-US')} characters are shortened in the middle.`,
    '',
    '## Environment',
    '',
  ];
  const system = input.system;
  if (system) {
    out.push(
      item('App', `pumr ${system.appVersion}`),
      item('OS', [system.osName, system.osVersion].filter(Boolean).join(' ')),
    );
    if (system.kernel) {
      out.push(item('Kernel', system.kernel));
    }
    out.push(item('Architecture', system.arch));
    if (system.webviewVersion) {
      out.push(item('WebView', system.webviewVersion));
    }
    if (system.desktop) {
      out.push(item('Desktop session', system.desktop));
    }
    if (system.osName === 'Linux') {
      out.push(item('AppImage', system.appImage));
    }
  } else {
    out.push('- System information could not be read.');
  }

  if (input.settings.length > 0) {
    out.push('', '## Settings', '');
    for (const [label, value] of input.settings) {
      out.push(item(label, value));
    }
  }

  const [main] = input.agents;
  if (main) {
    const errors = input.agents.filter((agent) => agent.error);
    if (errors.length > 0) {
      out.push('', '## Errors shown in the chat', '');
      for (const agent of errors) {
        out.push(`Session \`${agent.session.id}\` (${agent.session.title}):`, '');
        out.push(fence(clip(agent.error ?? '')), '');
      }
      trimTrailingBlank(out);
    }
    out.push('', ...contextSection(input.context));
    input.agents.forEach((agent, index) => {
      out.push('', ...agentSection(agent, index === 0));
    });
  }

  out.push('', '## Permission log', '');
  if (input.audit === null) {
    out.push('The permission log could not be read.');
  } else if (input.audit.length === 0) {
    out.push('No permission decisions recorded for this chat.');
  } else {
    for (const entry of input.audit) {
      out.push(auditItem(entry, main?.session.id ?? null));
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function contextSection(context: DebugLogContext): string[] {
  const out = ['## Context', ''];
  if (context.mode) {
    const mode = context.mode;
    out.push(
      item('Mode', `${mode.name} (${mode.id})`),
      item('Plan only', mode.planOnly),
      item('Global prompts included', mode.includeGlobalPrompts),
      item('Project rules included', mode.includeProjectRules),
    );
    if (mode.skills.length > 0) {
      out.push(item('Skills', mode.skills.join(', ')));
    }
    if (mode.mcpServers.length > 0) {
      out.push(item('MCP servers', mode.mcpServers.join(', ')));
    }
    out.push('');
  }
  if (context.systemPrompt.trim()) {
    out.push(
      `### System prompt (${context.systemPromptSource === 'session' ? 'session override' : 'default'})`,
      '',
      fence(clip(context.systemPrompt)),
      '',
    );
  }
  if (context.mode?.systemPrompt.trim()) {
    out.push('### Mode prompt', '', fence(clip(context.mode.systemPrompt)), '');
  }
  if (context.globalPrompts.length > 0) {
    out.push('### Global prompts', '', fence(clip(context.globalPrompts.join('\n\n'))), '');
  }
  for (const rule of context.rules) {
    out.push(`### Project rules: ${rule.path} (${rule.scope})`, '', fence(clip(rule.content)), '');
  }
  return trimTrailingBlank(out);
}

function agentSection(agent: DebugLogAgent, isMain: boolean): string[] {
  const session = agent.session;
  const out = [`## ${isMain ? 'Main agent' : 'Subagent'}: ${session.title}`, ''];
  out.push(item('Session ID', session.id));
  if (session.parentSessionId) {
    out.push(item('Parent session', session.parentSessionId));
  }
  out.push(
    item('Model', session.model),
    item('Provider routing', session.provider ?? 'auto'),
    item('Reasoning effort', session.reasoningEffort),
    item('Mode', session.modeId),
    item('Created', iso(session.createdAt)),
    item('Updated', iso(session.updatedAt)),
    item('Messages', agent.messages.length),
    item(
      'Tokens',
      `${session.promptTokens} prompt, ${session.completionTokens} completion, ${session.cachedTokens} cached`,
    ),
    item('Cost', money(session.cost)),
  );
  if (session.agentStatus) {
    out.push(item('Agent status', session.agentStatus));
  }
  out.push(
    item('Paused at tool-iteration limit', session.limitReached),
    item('Streaming at export', agent.streaming),
  );

  const calls = new Map<string, { name: string; arguments: string }>();
  for (const message of agent.messages) {
    for (const call of message.toolCalls) {
      calls.set(call.id, { name: call.name, arguments: call.arguments });
    }
  }
  const answered = new Set<string>();
  let step = 0;
  for (const message of agent.messages) {
    step += 1;
    out.push('', ...messageStep(step, message, calls, answered));
  }
  for (const tool of agent.liveTools) {
    if (answered.has(tool.callId)) {
      continue;
    }
    answered.add(tool.callId);
    step += 1;
    out.push(
      '',
      `### ${step}. Tool call: ${tool.name} (${tool.status}, not stored yet)`,
      '',
      item('Call ID', tool.callId),
      ...changeItems(tool.changes),
      '',
      ...block('Arguments', prettyJson(tool.arguments), 'json'),
      ...block('Output', tool.output),
    );
  }
  const unanswered = [...calls].filter(([id]) => !answered.has(id));
  if (unanswered.length > 0) {
    out.push('', '### Tool calls without a result', '');
    for (const [id, call] of unanswered) {
      out.push(
        `- \`${call.name}\` (call ID \`${id}\`)`,
        '',
        fence(clip(prettyJson(call.arguments)), 'json'),
        '',
      );
    }
  }
  return trimTrailingBlank(out);
}

function messageStep(
  step: number,
  message: Message,
  calls: Map<string, { name: string; arguments: string }>,
  answered: Set<string>,
): string[] {
  const at = iso(message.createdAt);
  if (message.role === 'user') {
    const out = [`### ${step}. User message · ${at}`, '', item('Message ID', message.id)];
    for (const mention of message.mentions) {
      out.push(item('Mention', `${mention.kind}: ${mention.value}`));
    }
    for (const attachment of message.attachments) {
      out.push(
        item('Attachment', `${attachment.name} (${attachment.mimeType}, ${attachment.size} B)`),
      );
    }
    out.push(
      '',
      ...block('Prompt', message.content),
      ...block('Referenced context', message.context),
    );
    return trimTrailingBlank(out);
  }

  if (message.role === 'assistant') {
    const status = message.status ?? 'ok';
    const out = [
      `### ${step}. Model response (${status}) · ${at}`,
      '',
      item('Message ID', message.id),
    ];
    out.push(item('Model', message.model), item('Provider', message.provider));
    if (message.promptTokens > 0 || message.completionTokens > 0) {
      out.push(
        item(
          'Tokens',
          `${message.promptTokens} prompt, ${message.completionTokens} completion, ${message.cachedTokens} cached`,
        ),
      );
    }
    if (message.cost > 0) {
      out.push(item('Cost', money(message.cost)));
    }
    if (message.durationMs > 0) {
      out.push(item('Duration', duration(message.durationMs)));
    }
    for (const call of message.toolCalls) {
      out.push(item('Tool call', `${call.name} (call ID ${call.id})`));
    }
    out.push('', ...block('Reasoning', message.reasoning), ...block('Content', message.content));
    return trimTrailingBlank(out);
  }

  if (message.role === 'tool') {
    const callId = message.toolCallId ?? message.id;
    answered.add(callId);
    const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
    const name = message.toolName ?? call?.name ?? 'tool';
    const facts = [message.status ?? 'ok'];
    if (message.durationMs > 0) {
      facts.push(duration(message.durationMs));
    }
    const out = [
      `### ${step}. Tool call: ${name} (${facts.join(', ')}) · ${at}`,
      '',
      item('Call ID', callId),
      ...changeItems(message.changes),
      '',
      ...block('Arguments', prettyJson(call?.arguments ?? ''), 'json'),
      ...block('Output', message.content),
    ];
    return trimTrailingBlank(out);
  }

  return trimTrailingBlank([
    `### ${step}. System message · ${at}`,
    '',
    item('Message ID', message.id),
    '',
    ...block('Content', message.content),
  ]);
}

function changeItems(
  changes: { status: string; path: string; additions: number; deletions: number }[],
): string[] {
  return changes.map((change) =>
    item(
      'File change',
      `${change.status} ${change.path} (+${change.additions} -${change.deletions})`,
    ),
  );
}

function auditItem(entry: PermissionAuditEntry, mainSessionId: string | null): string {
  const parts = [
    iso(entry.createdAt),
    entry.allowed ? 'allowed' : 'denied',
    entry.kind,
    code(entry.subject),
    `decided by ${entry.decidedBy}`,
  ];
  if (entry.decision) {
    parts.push(`choice ${entry.decision}`);
  }
  if (entry.rule) {
    parts.push(`rule ${code(entry.rule)}`);
  }
  if (entry.sessionId !== mainSessionId) {
    parts.push(`session ${entry.sessionId}`);
  }
  if (entry.reason) {
    parts.push(`why: ${entry.reason}`);
  }
  return `- ${parts.join(' · ')}`;
}

/** A labelled fenced block, or nothing for empty text. */
function block(label: string, text: string, language = 'text'): string[] {
  if (!text.trim()) {
    return [];
  }
  return [`**${label}**`, '', fence(clip(text), language), ''];
}

function item(label: string, value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined || value === '' ? '-' : String(value);
  return `- ${label}: ${text}`;
}

/** A code fence longer than any backtick run inside `text`. */
function fence(text: string, language = 'text'): string {
  const marks = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${marks}${language}\n${text.replace(/\s+$/, '')}\n${marks}`;
}

function code(text: string): string {
  const marks = '`'.repeat(longestBacktickRun(text) + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${marks}${padding}${text}${padding}${marks}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

/** Keeps the start and the end of very long text; errors tend to be at the end. */
function clip(text: string): string {
  if (text.length <= MAX_SECTION_CHARS) {
    return text;
  }
  const omitted = text.length - CLIP_HEAD_CHARS - CLIP_TAIL_CHARS;
  return `${text.slice(0, CLIP_HEAD_CHARS)}\n[… ${omitted.toLocaleString('en-US')} characters omitted …]\n${text.slice(-CLIP_TAIL_CHARS)}`;
}

function trimTrailingBlank(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function prettyJson(value: string): string {
  if (!value.trim()) {
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function iso(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '-';
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function duration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The file name the save dialog suggests, e.g. `pumr-debug-log-2026-09-30-1415.md`. */
export function debugLogFileName(exportedAt: number, anonymized: boolean): string {
  const date = new Date(exportedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `pumr-debug-log-${stamp}${anonymized ? '-anonymized' : ''}.md`;
}

/**
 * Splits the log into excerpts of at most `maxChars` for the anonymization
 * model, preferably between sections, else between lines.
 */
export function chunkDebugLog(log: string, maxChars = ANONYMIZE_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const section of log.split(/(?=^#{1,3} )/m)) {
    for (const piece of section.length > maxChars ? splitLines(section, maxChars) : [section]) {
      if (current && current.length + piece.length > maxChars) {
        chunks.push(current);
        current = '';
      }
      current += piece;
    }
  }
  if (current.trim()) {
    chunks.push(current);
  }
  return chunks;
}

function splitLines(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    if (current && current.length + line.length > maxChars) {
      pieces.push(current);
      current = '';
    }
    if (line.length > maxChars) {
      for (let start = 0; start < line.length; start += maxChars) {
        pieces.push(line.slice(start, start + maxChars));
      }
      continue;
    }
    current += line;
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

/** A value to replace in the log, and what replaces it. */
export interface Redaction {
  text: string;
  kind: string;
  placeholder: string;
  /** How often it occurs in the log. */
  count: number;
  enabled: boolean;
}

const PLACEHOLDER_LABELS: Record<string, string> = {
  name: 'NAME',
  username: 'USER',
  email: 'EMAIL',
  phone: 'PHONE',
  address: 'ADDRESS',
  secret: 'SECRET',
  ip: 'IP',
  url: 'URL',
  path: 'PATH',
  org: 'ORG',
  other: 'PRIVATE',
};

/**
 * Turns the model's findings into redactions with numbered placeholders
 * (`[EMAIL_1]`, `[EMAIL_2]`) that stay the same across the whole log. The
 * user's home folder always becomes `~`, so paths stay readable.
 */
export function planRedactions(
  log: string,
  findings: SensitiveFinding[],
  homeDir: string | null,
): Redaction[] {
  const candidates: { text: string; kind: string }[] = [];
  const home = homeDir?.replace(/[\\/]+$/, '') ?? '';
  if (home.length > 1) {
    candidates.push({ text: home, kind: 'home' });
    if (home.includes('\\')) {
      // Windows paths inside JSON tool arguments have doubled backslashes.
      candidates.push({ text: home.replaceAll('\\', '\\\\'), kind: 'home' });
    }
  }
  candidates.push(...findings);

  const seen = new Set<string>();
  const found: { text: string; kind: string; count: number; first: number }[] = [];
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    const positions = [...log.matchAll(new RegExp(escapeRegExp(text), 'g'))]
      .map((match) => match.index)
      .filter((index) => standsAlone(log, index, text));
    if (positions.length > 0) {
      found.push({ text, kind: candidate.kind, count: positions.length, first: positions[0] });
    }
  }

  const numbers = new Map<string, number>();
  return found
    .sort((a, b) => a.first - b.first)
    .map((entry) => {
      const kind = entry.kind === 'home' || entry.kind in PLACEHOLDER_LABELS ? entry.kind : 'other';
      let placeholder = '~';
      if (kind !== 'home') {
        const number = (numbers.get(kind) ?? 0) + 1;
        numbers.set(kind, number);
        placeholder = `[${PLACEHOLDER_LABELS[kind]}_${number}]`;
      }
      return { text: entry.text, kind, placeholder, count: entry.count, enabled: true };
    });
}

/** Replaces every enabled redaction and notes at the top that the log was anonymized. */
export function applyRedactions(log: string, redactions: Redaction[]): string {
  const active = redactions.filter((redaction) => redaction.enabled);
  if (active.length === 0) {
    return log;
  }
  const redacted = redactionSegments(log, active)
    .map((segment) => segment.replacement ?? segment.text)
    .join('');
  const example = active.find((redaction) => redaction.kind !== 'home') ?? active[0];
  const note = `> Anonymized before export: ${active.length} personal or secret values were replaced with placeholders such as \`${example.placeholder}\`.`;
  const newline = redacted.indexOf('\n');
  return newline < 0
    ? `${redacted}\n\n${note}\n`
    : `${redacted.slice(0, newline)}\n\n${note}${redacted.slice(newline)}`;
}

/** A piece of text; `match` numbers the search matches and marks changed values. */
export interface TextPart {
  text: string;
  match: number | null;
}

/** A line of the log that the anonymization changes, before and after. */
export interface DiffLine {
  /** 1-based line number in the original log. */
  number: number;
  before: TextPart[];
  after: TextPart[];
}

/**
 * The lines the enabled redactions change, with the replaced values and
 * their placeholders marked, so the user can see exactly what changed.
 */
export function redactionDiff(log: string, redactions: Redaction[]): DiffLine[] {
  const active = redactions.filter((redaction) => redaction.enabled);
  if (active.length === 0) {
    return [];
  }
  const lines: DiffLine[] = [];
  let line: DiffLine = { number: 1, before: [], after: [] };
  let changes = 0;
  let changed = false;
  const finish = () => {
    if (changed) {
      lines.push(line);
    }
    line = { number: line.number + 1, before: [], after: [] };
    changed = false;
  };
  for (const segment of redactionSegments(log, active)) {
    if (segment.replacement !== null) {
      line.before.push({ text: segment.text, match: changes });
      line.after.push({ text: segment.replacement, match: changes });
      changes += 1;
      changed = true;
      line.number += segment.text.split('\n').length - 1;
      continue;
    }
    const pieces = segment.text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) {
        finish();
      }
      if (piece) {
        line.before.push({ text: piece, match: null });
        line.after.push({ text: piece, match: null });
      }
    });
  }
  finish();
  return lines;
}

/**
 * Splits `text` around the case-insensitive matches of `query`, numbering
 * them from 0. An empty query leaves the text whole.
 */
export function searchParts(text: string, query: string): { parts: TextPart[]; count: number } {
  const needle = query.trim();
  if (!needle) {
    return { parts: [{ text, match: null }], count: 0 };
  }
  const parts: TextPart[] = [];
  let last = 0;
  let count = 0;
  for (const found of text.matchAll(new RegExp(escapeRegExp(needle), 'gi'))) {
    if (found.index > last) {
      parts.push({ text: text.slice(last, found.index), match: null });
    }
    parts.push({ text: found[0], match: count });
    count += 1;
    last = found.index + found[0].length;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last), match: null });
  }
  return { parts, count };
}

/** Whether `line` contains `query`, ignoring case, on either side. */
export function diffLineMatches(line: DiffLine, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [line.before, line.after].some((parts) =>
    parts
      .map((part) => part.text)
      .join('')
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * The log cut into plain text and replaced values, longest value first, so
 * a placeholder is never rewritten by a later one. Values that start or
 * end with a letter or digit only match as whole words.
 */
function redactionSegments(
  log: string,
  active: Redaction[],
): { text: string; replacement: string | null }[] {
  const sorted = [...active].sort((a, b) => b.text.length - a.text.length);
  const placeholders = new Map(sorted.map((redaction) => [redaction.text, redaction.placeholder]));
  const pattern = new RegExp(
    sorted.map((redaction) => escapeRegExp(redaction.text)).join('|'),
    'g',
  );
  const segments: { text: string; replacement: string | null }[] = [];
  let last = 0;
  for (const found of log.matchAll(pattern)) {
    const value = found[0];
    if (!standsAlone(log, found.index, value)) {
      continue;
    }
    if (found.index > last) {
      segments.push({ text: log.slice(last, found.index), replacement: null });
    }
    segments.push({ text: value, replacement: placeholders.get(value) ?? value });
    last = found.index + value.length;
  }
  if (last < log.length) {
    segments.push({ text: log.slice(last), replacement: null });
  }
  return segments;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = /^[\p{L}\p{N}_]$/u;

/**
 * Whether `text`, found at `index` of `log`, is not part of a longer word:
 * `jane` must not turn `janet` into `[NAME_1]t`. (A lookbehind would say
 * this in the pattern, but older WebKit versions reject lookbehinds.)
 */
function standsAlone(log: string, index: number, text: string): boolean {
  const first = String.fromCodePoint(text.codePointAt(0) ?? 0);
  const last = Array.from(text.slice(-2)).pop() ?? '';
  const before = Array.from(log.slice(Math.max(0, index - 2), index)).pop() ?? '';
  const end = index + text.length;
  const after = end < log.length ? String.fromCodePoint(log.codePointAt(end) ?? 0) : '';
  if (WORD_CHAR.test(first) && WORD_CHAR.test(before)) {
    return false;
  }
  return !(WORD_CHAR.test(last) && WORD_CHAR.test(after));
}
