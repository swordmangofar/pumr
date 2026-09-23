/**
 * Curated quick-add sources shown in Settings. These are suggestions only: the
 * user still reviews and opts in, and nothing here is trusted automatically.
 *
 * Skill marketplaces are Claude-style git repositories (a repo with
 * `.claude-plugin/marketplace.json` at the root). MCP servers are registry search
 * terms, because pumr never installs a registry entry on the user's behalf.
 */

export interface RecommendedMarketplace {
  nameKey: string;
  descriptionKey: string;
  url: string;
}

export interface RecommendedMcpServer {
  nameKey: string;
  descriptionKey: string;
  query: string;
}

export const RECOMMENDED_MARKETPLACES: readonly RecommendedMarketplace[] = [
  {
    nameKey: 'settings.skills.items.claudeCodeWorkflows.name',
    descriptionKey: 'settings.skills.items.claudeCodeWorkflows.description',
    url: 'https://github.com/wshobson/agents',
  },
  {
    nameKey: 'settings.skills.items.buildWithClaude.name',
    descriptionKey: 'settings.skills.items.buildWithClaude.description',
    url: 'https://github.com/davepoon/claude-code-subagents-collection',
  },
  {
    nameKey: 'settings.skills.items.superpowers.name',
    descriptionKey: 'settings.skills.items.superpowers.description',
    url: 'https://github.com/obra/superpowers',
  },
];

export const RECOMMENDED_MCP_SERVERS: readonly RecommendedMcpServer[] = [
  {
    nameKey: 'settings.mcp.items.filesystem.name',
    descriptionKey: 'settings.mcp.items.filesystem.description',
    query: 'filesystem',
  },
  {
    nameKey: 'settings.mcp.items.github.name',
    descriptionKey: 'settings.mcp.items.github.description',
    query: 'github',
  },
  {
    nameKey: 'settings.mcp.items.postgres.name',
    descriptionKey: 'settings.mcp.items.postgres.description',
    query: 'postgres',
  },
  {
    nameKey: 'settings.mcp.items.puppeteer.name',
    descriptionKey: 'settings.mcp.items.puppeteer.description',
    query: 'puppeteer',
  },
  {
    nameKey: 'settings.mcp.items.memory.name',
    descriptionKey: 'settings.mcp.items.memory.description',
    query: 'memory',
  },
  {
    nameKey: 'settings.mcp.items.braveSearch.name',
    descriptionKey: 'settings.mcp.items.braveSearch.description',
    query: 'brave-search',
  },
  {
    nameKey: 'settings.mcp.items.slack.name',
    descriptionKey: 'settings.mcp.items.slack.description',
    query: 'slack',
  },
  {
    nameKey: 'settings.mcp.items.sentry.name',
    descriptionKey: 'settings.mcp.items.sentry.description',
    query: 'sentry',
  },
];
