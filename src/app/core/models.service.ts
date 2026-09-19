import { Injectable, computed, signal } from '@angular/core';
import { api } from './api';
import { EndpointInfo, ModelInfo, ProviderInfo } from './models';

@Injectable({ providedIn: 'root' })
export class ModelsService {
  readonly models = signal<ModelInfo[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly endpoints = signal<Record<string, EndpointInfo[]>>({});
  readonly endpointsLoading = signal<Record<string, boolean>>({});
  readonly endpointsError = signal<Record<string, string | null>>({});
  readonly providers = signal<ProviderInfo[]>([]);
  readonly providersBySlug = computed(
    () => new Map(this.providers().map((provider) => [provider.slug, provider])),
  );

  readonly modelIds = computed(() => new Set(this.models().map((model) => model.id)));

  async load(refresh = false): Promise<void> {
    if (this.loading()) {
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      this.models.set(await api.listModels(refresh));
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.loading.set(false);
    }
  }

  async loadProviders(refresh = false): Promise<void> {
    if (!refresh && this.providers().length > 0) {
      return;
    }
    try {
      this.providers.set(await api.listProviders(refresh));
    } catch {
      this.providers.set([]);
    }
  }

  providerIcon(slug: string): string | null {
    return this.providersBySlug().get(slug)?.iconUrl ?? null;
  }

  byId(id: string | null | undefined): ModelInfo | undefined {
    if (!id) {
      return undefined;
    }
    return this.models().find((model) => model.id === id);
  }

  async loadEndpoints(modelId: string, refresh = false): Promise<void> {
    if (!modelId) {
      return;
    }
    if (this.endpointsLoading()[modelId]) {
      return;
    }
    if (!refresh && this.endpoints()[modelId]) {
      return;
    }
    this.endpointsLoading.update((state) => ({ ...state, [modelId]: true }));
    try {
      const endpoints = await api.listEndpoints(modelId, refresh);
      this.endpoints.update((state) => ({ ...state, [modelId]: endpoints }));
      this.endpointsError.update((state) => ({ ...state, [modelId]: null }));
    } catch (error) {
      this.endpointsError.update((state) => ({ ...state, [modelId]: String(error) }));
    } finally {
      this.endpointsLoading.update((state) => ({ ...state, [modelId]: false }));
    }
  }
}
