import { TestBed } from '@angular/core/testing';
import { api } from './api';
import { RenderingService } from './rendering.service';

const root = document.documentElement;

describe('RenderingService', () => {
  let service: RenderingService;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    service = TestBed.inject(RenderingService);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    delete root.dataset['renderer'];
    vi.restoreAllMocks();
  });

  it('marks the document when the webview paints on the CPU', async () => {
    vi.spyOn(api, 'isSoftwareRendered').mockResolvedValue(true);

    await service.init();

    expect(service.software()).toBe(true);
    expect(root.dataset['renderer']).toBe('software');
  });

  it('leaves a GPU-composited webview alone', async () => {
    vi.spyOn(api, 'isSoftwareRendered').mockResolvedValue(false);

    await service.init();

    expect(service.software()).toBe(false);
    expect(root.dataset['renderer']).toBeUndefined();
  });

  it('assumes GPU compositing when the backend cannot tell', async () => {
    vi.spyOn(api, 'isSoftwareRendered').mockRejectedValue(new Error('unknown command'));

    await service.init();

    expect(service.software()).toBe(false);
    expect(root.dataset['renderer']).toBeUndefined();
  });

  it('does not ask outside Tauri', async () => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    const asked = vi.spyOn(api, 'isSoftwareRendered');

    await service.init();

    expect(asked).not.toHaveBeenCalled();
    expect(service.software()).toBe(false);
  });
});
