import { Injectable, signal } from '@angular/core';
import { api } from '../../core/api';
import {
  DirectoryPage,
  InstalledSkill,
  MarketplaceServer,
  SkillMarketplace,
} from '../../core/models';

export interface DirectoryQuery {
  query: string | null;
  category: string | null;
  source: string;
  sort: string;
  limit: number;
  offset: number;
}

/**
 * Shared access to the MCP/skill marketplace commands. Owns the single error
 * channel and normalises failures to `String(error)` so the MCP and skills
 * settings panes do not each re-implement the same try/catch/error dance.
 *
 * Provided per settings pane so each pane has its own error state.
 */
@Injectable()
export class MarketplaceRegistryService {
  readonly error = signal<string | null>(null);

  clearError(): void {
    this.error.set(null);
  }

  async searchMcp(query: string | null, includeUnverified: boolean): Promise<MarketplaceServer[]> {
    return this.guard(() => api.searchMcpMarketplace(query, null, includeUnverified), []);
  }

  async browseDirectory(query: DirectoryQuery): Promise<DirectoryPage | null> {
    return this.guard(
      () =>
        api.browseMcpDirectory(
          query.query,
          query.category,
          query.source,
          query.sort,
          query.limit,
          query.offset,
        ),
      null,
    );
  }

  async loadSkills(): Promise<{
    marketplaces: SkillMarketplace[];
    installed: InstalledSkill[];
  }> {
    return this.guard(async () => {
      const [marketplaces, installed] = await Promise.all([
        api.listSkillMarketplaces(),
        api.listInstalledMarketplaceSkills(),
      ]);
      return { marketplaces, installed };
    }, { marketplaces: [], installed: [] });
  }

  async addMarketplace(url: string): Promise<boolean> {
    return this.guard(async () => {
      await api.addSkillMarketplace(url);
      return true;
    }, false);
  }

  async removeMarketplace(url: string): Promise<boolean> {
    return this.guard(async () => {
      await api.removeSkillMarketplace(url);
      return true;
    }, false);
  }

  async installSkills(url: string, plugin: string, includeUnverified: boolean): Promise<boolean> {
    return this.guard(async () => {
      await api.installMarketplaceSkills(url, plugin, includeUnverified);
      return true;
    }, false);
  }

  async uninstallSkills(marketplace: string, skill: string): Promise<boolean> {
    return this.guard(async () => {
      await api.uninstallMarketplaceSkills(marketplace, skill);
      return true;
    }, false);
  }

  private async guard<T>(action: () => Promise<T>, fallback: T): Promise<T> {
    this.clearError();
    try {
      return await action();
    } catch (error) {
      this.error.set(String(error));
      return fallback;
    }
  }
}
