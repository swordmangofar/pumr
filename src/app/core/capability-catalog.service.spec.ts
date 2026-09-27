import { CapabilityItem, searchCapabilities } from './capability-catalog.service';
import {
  McpInstallDraft,
  draftConfig,
  suggestServerName,
} from '../components/settings/mcp-install-dialog';

function item(name: string, description: string | null = null, sources = ['pumr']): CapabilityItem {
  return { name, description, sources };
}

describe('searchCapabilities', () => {
  const items = [
    item('code-review', 'Review a diff for bugs'),
    item('commit-message', 'Write a commit message'),
    item('pdf', 'Extract text from documents', ['Claude Code']),
    item('review-notes'),
  ];

  it('returns everything for an empty term', () => {
    expect(searchCapabilities(items, '  ')).toEqual(items);
  });

  it('ranks name prefix, then name substring, then description matches', () => {
    expect(searchCapabilities(items, 'review').map((entry) => entry.name)).toEqual([
      'review-notes',
      'code-review',
    ]);
    expect(searchCapabilities(items, 'commit').map((entry) => entry.name)).toEqual([
      'commit-message',
    ]);
    expect(searchCapabilities(items, 'diff').map((entry) => entry.name)).toEqual(['code-review']);
  });

  it('matches source labels', () => {
    expect(searchCapabilities(items, 'claude code').map((entry) => entry.name)).toEqual(['pdf']);
  });
});

describe('suggestServerName', () => {
  it('uses the last path segment and strips unsupported characters', () => {
    expect(suggestServerName('io.github.acme/weather-server')).toBe('weather-server');
    expect(suggestServerName('Brave Search!')).toBe('Brave-Search');
    expect(suggestServerName('///')).toBe('server');
  });
});

describe('draftConfig', () => {
  const base: McpInstallDraft = {
    name: 'acme',
    displayName: 'Acme',
    command: 'npx',
    args: ['-y', '@acme/server'],
    url: null,
    transport: null,
    env: [{ name: 'API_KEY', required: true, secret: true }],
    requirements: [],
    cli: null,
  };

  it('builds an mcpServers entry with empty env placeholders', () => {
    expect(JSON.parse(draftConfig(base))).toEqual({
      mcpServers: {
        acme: { command: 'npx', args: ['-y', '@acme/server'], env: { API_KEY: '' } },
      },
    });
  });

  it('uses the URL and transport for remote servers', () => {
    const remote = {
      ...base,
      command: null,
      args: [],
      env: [],
      url: 'https://x.dev/mcp',
      transport: 'http',
    };
    expect(JSON.parse(draftConfig(remote, 'x'))).toEqual({
      mcpServers: { x: { url: 'https://x.dev/mcp', type: 'http' } },
    });
  });

  it('returns the CLI command when that is the only install method', () => {
    const cli = { ...base, command: null, args: [], cli: 'claude mcp add acme' };
    expect(draftConfig(cli)).toBe('claude mcp add acme');
  });
});
