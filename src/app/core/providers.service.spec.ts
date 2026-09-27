import { TestBed } from '@angular/core/testing';
import { api, providerIdOf, providerModelId } from './api';
import { ProviderStatus } from './models';
import { FALLBACK_SETTINGS } from './settings-defaults';
import { ProvidersService } from './providers.service';

function status(id: string, patch: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id,
    name: id.toUpperCase(),
    local: false,
    popular: true,
    hasKey: false,
    enabled: true,
    connected: false,
    baseUrl: `https://${id}.example/v1`,
    defaultBaseUrl: `https://${id}.example/v1`,
    keyPlaceholder: '',
    keysUrl: '',
    error: null,
    ...patch,
  };
}

describe('provider ids', () => {
  it('reads the provider from a model id', () => {
    expect(providerIdOf('openai:gpt-5')).toBe('openai');
    expect(providerIdOf('ollama:llama3.1:8b')).toBe('ollama');
    expect(providerIdOf('openai/gpt-5:free')).toBe('openrouter');
    expect(providerIdOf('anthropic/claude-opus-5')).toBe('openrouter');
    expect(providerIdOf(null)).toBe('openrouter');
    expect(providerModelId('ollama:llama3.1:8b')).toBe('llama3.1:8b');
    expect(providerModelId('openai/gpt-5:free')).toBe('openai/gpt-5:free');
  });
});

describe('ProvidersService', () => {
  let service: ProvidersService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ProvidersService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('loads the providers and knows which are connected', async () => {
    vi.spyOn(api, 'listLlmProviders').mockResolvedValue([
      status('openrouter'),
      status('openai', { hasKey: true, connected: true, name: 'OpenAI' }),
    ]);

    await service.load();

    expect(service.anyConnected()).toBe(true);
    expect(service.connected().map((provider) => provider.id)).toEqual(['openai']);
    expect(service.providerOf('openai:gpt-5')?.name).toBe('OpenAI');
    expect(service.name('openai')).toBe('OpenAI');
    expect(service.name('mystery')).toBe('mystery');
  });

  it('keeps the last state when loading fails', async () => {
    vi.spyOn(api, 'listLlmProviders')
      .mockResolvedValueOnce([status('openai', { connected: true })])
      .mockRejectedValueOnce('offline');
    await service.load();
    await service.load();
    expect(service.anyConnected()).toBe(true);
  });

  it('stores and removes keys, then refreshes', async () => {
    const setApiKey = vi.spyOn(api, 'setApiKey').mockResolvedValue();
    const deleteApiKey = vi.spyOn(api, 'deleteApiKey').mockResolvedValue();
    const list = vi.spyOn(api, 'listLlmProviders').mockResolvedValue([]);

    await service.setKey('anthropic', 'sk-ant-test');
    expect(setApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-test');
    await service.deleteKey('anthropic');
    expect(deleteApiKey).toHaveBeenCalledWith('anthropic');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('saves provider changes and returns the new settings', async () => {
    const saved = { ...FALLBACK_SETTINGS, providers: { ollama: { baseUrl: '', enabled: true } } };
    const update = vi.spyOn(api, 'updateProvider').mockResolvedValue(saved);
    vi.spyOn(api, 'listLlmProviders').mockResolvedValue([]);

    expect(await service.update('ollama', { enabled: true })).toBe(saved);
    expect(update).toHaveBeenCalledWith('ollama', { enabled: true });
  });
});
