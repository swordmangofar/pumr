import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { api } from './api';
import { SettingsService } from './settings.service';

/** One selectable skill or MCP server, merged across every source it appears in. */
export interface CapabilityItem {
  name: string;
  /** Skill description, or the MCP server's command line / URL. */
  description: string | null;
  /** Labels of the sources that provide it (e.g. "Claude Code", "pumr"). */
  sources: string[];
}

/**
 * The enabled skills and MCP servers the user can pick in the composer and in
 * modes. One app-wide copy that reloads whenever the discovery settings change,
 * and that settings panes refresh after installing or removing something, so
 * pickers never show a stale list.
 */
@Injectable({ providedIn: 'root' })
export class CapabilityCatalogService {
  private readonly settings = inject(SettingsService);

  readonly skills = signal<CapabilityItem[]>([]);
  readonly mcpServers = signal<CapabilityItem[]>([]);
  readonly loaded = signal(false);

  private readonly discoveryKey = computed(() => {
    const settings = this.settings.settings();
    if (!settings) {
      return '';
    }
    return JSON.stringify([
      settings.mcpFolders,
      settings.mcpDisabled,
      settings.mcpDisabledServers,
      settings.mcpAutoDiscovery,
      settings.skillFolders,
      settings.skillsDisabled,
      settings.skillsDisabledItems,
      settings.skillsAutoDiscovery,
    ]);
  });

  private generation = 0;

  constructor() {
    effect(() => {
      if (this.discoveryKey()) {
        untracked(() => void this.refresh());
      }
    });
  }

  async refresh(): Promise<void> {
    const settings = this.settings.settings();
    if (!settings) {
      return;
    }
    const generation = ++this.generation;
    const [mcp, skills] = await Promise.all([
      api
        .discoverMcpSources(
          settings.mcpFolders,
          settings.mcpDisabled,
          settings.mcpDisabledServers,
          settings.mcpAutoDiscovery,
        )
        .catch(() => []),
      api
        .discoverSkills(
          settings.skillFolders,
          settings.skillsDisabled,
          settings.skillsDisabledItems,
          settings.skillsAutoDiscovery,
        )
        .catch(() => []),
    ]);
    // A newer refresh started while this one ran; its result wins.
    if (generation !== this.generation) {
      return;
    }
    this.mcpServers.set(
      merge(
        mcp.flatMap((candidate) =>
          candidate.servers
            .filter((server) => server.enabled)
            .map((server) => ({
              name: server.name,
              description: server.detail,
              source: candidate.label,
            })),
        ),
      ),
    );
    this.skills.set(
      merge(
        skills.flatMap((candidate) =>
          candidate.skills
            .filter((skill) => skill.enabled)
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
              source: candidate.label,
            })),
        ),
      ),
    );
    this.loaded.set(true);
  }
}

function merge(
  entries: { name: string; description: string | null; source: string }[],
): CapabilityItem[] {
  const byName = new Map<string, CapabilityItem>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (existing) {
      existing.description ??= entry.description;
      if (!existing.sources.includes(entry.source)) {
        existing.sources.push(entry.source);
      }
    } else {
      byName.set(entry.name, {
        name: entry.name,
        description: entry.description,
        sources: [entry.source],
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Filters catalog items by a search term and ranks them: name prefix matches
 * first, then name substring matches, then description or source matches.
 */
export function searchCapabilities(items: CapabilityItem[], term: string): CapabilityItem[] {
  const needle = term.trim().toLowerCase();
  if (!needle) {
    return items;
  }
  const ranked: { item: CapabilityItem; rank: number }[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    let rank = -1;
    if (name.startsWith(needle)) {
      rank = 0;
    } else if (name.includes(needle)) {
      rank = 1;
    } else if (
      (item.description ?? '').toLowerCase().includes(needle) ||
      item.sources.some((source) => source.toLowerCase().includes(needle))
    ) {
      rank = 2;
    }
    if (rank >= 0) {
      ranked.push({ item, rank });
    }
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.item);
}
