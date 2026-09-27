import { Injectable, computed, signal } from '@angular/core';
import { OPENROUTER_PROVIDER, api, providerIdOf } from './api';
import { ProviderStatus, Settings } from './models';

/** The model providers, their keys and whether they are usable. */
@Injectable({ providedIn: 'root' })
export class ProvidersService {
  readonly providers = signal<ProviderStatus[]>([]);
  readonly connected = computed(() => this.providers().filter((provider) => provider.connected));
  /** Whether any provider can be used, i.e. chatting is possible at all. */
  readonly anyConnected = computed(() => this.connected().length > 0);
  private readonly byId = computed(
    () => new Map(this.providers().map((provider) => [provider.id, provider])),
  );

  async load(): Promise<void> {
    try {
      this.providers.set(await api.listLlmProviders());
    } catch {
      // Keep the last known state; the settings page shows what it has.
    }
  }

  get(id: string): ProviderStatus | undefined {
    return this.byId().get(id);
  }

  /** The provider serving `modelId`. */
  providerOf(modelId: string | null | undefined): ProviderStatus | undefined {
    return this.get(providerIdOf(modelId));
  }

  /** Display name of a provider id; brand names are not translated. */
  name(id: string): string {
    return this.get(id)?.name ?? (id === OPENROUTER_PROVIDER ? 'OpenRouter' : id);
  }

  async setKey(id: string, key: string): Promise<void> {
    await api.setApiKey(id, key);
    await this.load();
  }

  async deleteKey(id: string): Promise<void> {
    await api.deleteApiKey(id);
    await this.load();
  }

  /** Saves a provider's base URL or enabled state; returns the new settings. */
  async update(id: string, change: { baseUrl?: string; enabled?: boolean }): Promise<Settings> {
    const settings = await api.updateProvider(id, change);
    await this.load();
    return settings;
  }
}
