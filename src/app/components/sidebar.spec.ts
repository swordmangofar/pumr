import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { Sidebar } from './sidebar';

describe('Sidebar history', () => {
  afterEach(() => vi.useRealTimers());

  it('names the days from the day it is now, also once midnight has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 6, 23, 50));
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: {} },
        { provide: SettingsService, useValue: {} },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key, getActiveLang: () => 'en' },
        },
      ],
    });
    TestBed.overrideComponent(Sidebar, { set: { imports: [], template: '' } });
    const sidebar = TestBed.createComponent(Sidebar).componentInstance as unknown as {
      historyLabel: (dayStart: number) => string;
    };
    const tuesday = new Date(2026, 9, 6).getTime();
    const wednesday = new Date(2026, 9, 7).getTime();
    expect(sidebar.historyLabel(tuesday)).toBe('sidebar.today');

    // The app stays open over midnight and a chat is used on the new day.
    vi.setSystemTime(new Date(2026, 9, 7, 0, 10));

    expect(sidebar.historyLabel(wednesday)).toBe('sidebar.today');
    expect(sidebar.historyLabel(tuesday)).toBe('sidebar.yesterday');
  });
});
