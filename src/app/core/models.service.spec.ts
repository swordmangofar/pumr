import { TestBed } from '@angular/core/testing';
import { api } from './api';
import { EndpointInfo, ModelInfo, ProviderInfo } from './models';
import { ModelsService } from './models.service';

function model(id: string): ModelInfo {
  return {
    id,
    name: id,
    description: '',
    contextLength: 128_000,
    promptPricePerM: 1,
    completionPricePerM: 2,
    cacheReadPricePerM: 0,
    supportsReasoning: false,
    supportsVision: false,
    supportsTools: true,
    inputModalities: ['text'],
    supportedParameters: [],
    created: 0,
  };
}

function provider(slug: string, iconUrl: string | null = null): ProviderInfo {
  return { slug, name: slug, iconUrl, headquarters: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('ModelsService', () => {
  let service: ModelsService;

  beforeEach(() => {
    service = TestBed.inject(ModelsService);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('load', () => {
    it('stores the models and indexes them by id', async () => {
      const listModels = vi
        .spyOn(api, 'listModels')
        .mockResolvedValue([model('a/one'), model('b/two')]);

      await service.load(true);

      expect(listModels).toHaveBeenCalledWith(true);
      expect(service.modelIds()).toEqual(new Set(['a/one', 'b/two']));
      expect(service.byId('b/two')?.id).toBe('b/two');
      expect(service.byId('missing')).toBeUndefined();
      expect(service.byId(null)).toBeUndefined();
      expect(service.loading()).toBe(false);
    });

    it('ignores a second load while one is in flight', async () => {
      const pending = deferred<ModelInfo[]>();
      const listModels = vi.spyOn(api, 'listModels').mockReturnValue(pending.promise);

      const first = service.load();
      await service.load();
      expect(listModels).toHaveBeenCalledTimes(1);
      expect(service.loading()).toBe(true);

      pending.resolve([model('a/one')]);
      await first;
      expect(service.loading()).toBe(false);
    });

    it('surfaces a failure and clears it on the next successful load', async () => {
      vi.spyOn(api, 'listModels').mockRejectedValueOnce('offline');
      await service.load();
      expect(service.error()).toBe('offline');
      expect(service.loading()).toBe(false);

      vi.spyOn(api, 'listModels').mockResolvedValueOnce([]);
      await service.load();
      expect(service.error()).toBeNull();
    });
  });

  describe('loadProviders', () => {
    it('caches providers until a refresh is requested', async () => {
      const listProviders = vi
        .spyOn(api, 'listProviders')
        .mockResolvedValue([provider('openai', 'https://icons/openai.svg'), provider('bare')]);

      await service.loadProviders();
      await service.loadProviders();
      expect(listProviders).toHaveBeenCalledTimes(1);

      await service.loadProviders(true);
      expect(listProviders).toHaveBeenCalledTimes(2);
      expect(listProviders).toHaveBeenLastCalledWith(true);

      expect(service.providerIcon('openai')).toBe('https://icons/openai.svg');
      expect(service.providerIcon('bare')).toBeNull();
      expect(service.providerIcon('unknown')).toBeNull();
    });

    it('falls back to an empty list when the request fails', async () => {
      vi.spyOn(api, 'listProviders').mockRejectedValue(new Error('offline'));
      await service.loadProviders();
      expect(service.providers()).toEqual([]);
    });
  });

  describe('loadEndpoints', () => {
    const endpoint = { slug: 'openai/gpt' } as EndpointInfo;

    it('does nothing without a model id', async () => {
      const listEndpoints = vi.spyOn(api, 'listEndpoints');
      await service.loadEndpoints('');
      expect(listEndpoints).not.toHaveBeenCalled();
    });

    it('caches endpoints per model until refreshed', async () => {
      const listEndpoints = vi.spyOn(api, 'listEndpoints').mockResolvedValue([endpoint]);

      await service.loadEndpoints('m');
      await service.loadEndpoints('m');
      expect(listEndpoints).toHaveBeenCalledTimes(1);
      expect(service.endpoints()['m']).toEqual([endpoint]);
      expect(service.endpointsLoading()['m']).toBe(false);

      await service.loadEndpoints('m', true);
      expect(listEndpoints).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent requests for the same model', async () => {
      const pending = deferred<EndpointInfo[]>();
      const listEndpoints = vi.spyOn(api, 'listEndpoints').mockReturnValue(pending.promise);

      const first = service.loadEndpoints('m');
      await service.loadEndpoints('m', true);
      expect(listEndpoints).toHaveBeenCalledTimes(1);
      expect(service.endpointsLoading()['m']).toBe(true);

      pending.resolve([endpoint]);
      await first;
      expect(service.endpointsLoading()['m']).toBe(false);
    });

    it('records the error per model and clears it after a success', async () => {
      vi.spyOn(api, 'listEndpoints').mockRejectedValueOnce('boom');
      await service.loadEndpoints('m');
      expect(service.endpointsError()['m']).toBe('boom');
      expect(service.endpoints()['m']).toBeUndefined();

      vi.spyOn(api, 'listEndpoints').mockResolvedValueOnce([endpoint]);
      await service.loadEndpoints('m');
      expect(service.endpointsError()['m']).toBeNull();
    });
  });
});
