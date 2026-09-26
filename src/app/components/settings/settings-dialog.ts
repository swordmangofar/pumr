import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsService } from '../../core/settings.service';
import { UpdaterService } from '../../core/updater.service';
import { AgentSettings } from './agent-settings';
import { AppearanceSettings } from './appearance-settings';
import { ChatSettings } from './chat-settings';
import { GeneralSettings } from './general-settings';
import { HotkeysSettings } from './hotkeys-settings';
import { McpSettings } from './mcp-settings';
import { AgentRulesSettings } from './agent-rules-settings';
import { NotificationsSettings } from './notifications-settings';
import { ProvidersSettings } from './providers-settings';
import { SettingsDraftService } from './settings-draft.service';
import { SkillsSettings } from './skills-settings';
import { WindowSettings } from './window-settings';
import { WorkspaceSettings } from './workspace-settings';

interface Category {
  id: string;
  label: string;
  /** 24x24 stroke icon paths shown next to the label. */
  icon: string[];
}

const CATEGORIES: Category[] = [
  {
    id: 'providers',
    label: 'settings.categories.providers',
    icon: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z'],
  },
  {
    id: 'agent',
    label: 'settings.categories.agent',
    icon: [
      'M12 8V4H8',
      'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      'M2 14h2',
      'M20 14h2',
      'M15 13v2',
      'M9 13v2',
    ],
  },
  {
    id: 'agentRules',
    label: 'settings.categories.agentRules',
    icon: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  },
  {
    id: 'general',
    label: 'settings.categories.general',
    icon: [
      'M20 7h-9',
      'M14 17H5',
      'M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    ],
  },
  {
    id: 'chat',
    label: 'settings.categories.chat',
    icon: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  },
  {
    id: 'appearance',
    label: 'settings.categories.appearance',
    icon: [
      'M12 22a10 10 0 1 1 10-10c0 2.5-2 3.5-4 3.5h-2a2 2 0 0 0-1.5 3.3c.4.5.5 1 .5 1.4 0 1-.8 1.8-3 1.8z',
      'M13.5 6.5h.01',
      'M17.5 10.5h.01',
      'M8.5 7.5h.01',
      'M6.5 12.5h.01',
    ],
  },
  {
    id: 'notifications',
    label: 'settings.categories.notifications',
    icon: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  },
  {
    id: 'hotkeys',
    label: 'settings.categories.hotkeys',
    icon: [
      'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
      'M6 9h.01',
      'M10 9h.01',
      'M14 9h.01',
      'M18 9h.01',
      'M8 13h.01',
      'M16 13h.01',
      'M7 16h10',
    ],
  },
  {
    id: 'window',
    label: 'settings.categories.window',
    icon: [
      'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M3 9h18',
      'M9 21V9',
    ],
  },
  {
    id: 'skills',
    label: 'settings.categories.skills',
    icon: ['M9.94 14.06 2 22', 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
  },
  {
    id: 'mcp',
    label: 'settings.categories.mcp',
    icon: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z'],
  },
  {
    id: 'workspace',
    label: 'settings.categories.workspace',
    icon: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  },
];

@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SettingsDraftService],
  imports: [
    TranslocoPipe,
    ProvidersSettings,
    AgentSettings,
    AgentRulesSettings,
    GeneralSettings,
    ChatSettings,
    AppearanceSettings,
    NotificationsSettings,
    SkillsSettings,
    McpSettings,
    WorkspaceSettings,
    HotkeysSettings,
    WindowSettings,
  ],
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      (click)="close()"
    >
      <div
        class="flex h-[82vh] w-[72rem] max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
        (click)="$event.stopPropagation()"
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-white/5 px-6 py-4"
        >
          <h2 class="text-base font-semibold text-white">{{ 'settings.title' | transloco }}</h2>
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
            (click)="close()"
          >
            ✕
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          <nav class="min-h-0 w-48 shrink-0 overflow-y-auto border-r border-white/5 p-3 sm:w-60">
            @for (category of categories; track category.id) {
              <button
                type="button"
                class="relative mb-1 flex w-full min-w-0 items-center gap-2.5 break-words rounded-full px-4 py-2 text-left text-sm transition-colors"
                [class]="
                  category.id === active()
                    ? 'bg-accent font-medium text-ink'
                    : 'text-mist/50 hover:bg-white/5 hover:text-mist'
                "
                (click)="select(category.id)"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-4 w-4 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  @for (path of category.icon; track $index) {
                    <path [attr.d]="path" />
                  }
                </svg>
                <span class="min-w-0">{{ category.label | transloco }}</span>
                @if (category.id === 'general' && updater.available()) {
                  <span
                    class="absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-red-500"
                    aria-hidden="true"
                  ></span>
                }
              </button>
            }
          </nav>

          <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            @switch (active()) {
              @case ('providers') {
                <app-providers-settings />
              }
              @case ('agent') {
                <app-agent-settings />
              }
              @case ('agentRules') {
                <app-agent-rules-settings />
              }
              @case ('general') {
                <app-general-settings />
              }
              @case ('chat') {
                <app-chat-settings />
              }
              @case ('appearance') {
                <app-appearance-settings />
              }
              @case ('notifications') {
                <app-notifications-settings />
              }
              @case ('hotkeys') {
                <app-hotkeys-settings />
              }
              @case ('window') {
                <app-window-settings class="block" />
              }
              @case ('skills') {
                <app-skills-settings />
              }
              @case ('mcp') {
                <app-mcp-settings />
              }
              @case ('workspace') {
                <app-workspace-settings />
              }
            }
          </div>
        </div>

        <footer
          class="flex shrink-0 items-center justify-between border-t border-white/5 px-6 py-4"
        >
          <span class="text-xs">
            @if (draft.saved()) {
              <span class="text-emerald-400">{{ 'settings.saved' | transloco }}</span>
            } @else if (draft.dirty()) {
              <span class="text-accent">{{ 'settings.unsaved' | transloco }}</span>
            }
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
              (click)="close()"
            >
              {{ 'settings.close' | transloco }}
            </button>
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
              [disabled]="draft.saving() || !draft.dirty()"
              (click)="draft.save()"
            >
              {{ 'settings.save' | transloco }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  `,
})
export class SettingsDialog {
  private readonly settingsService = inject(SettingsService);
  protected readonly updater = inject(UpdaterService);
  protected readonly draft = inject(SettingsDraftService);
  readonly closed = output<void>();

  protected readonly categories = CATEGORIES;
  protected readonly active = signal(this.settingsService.focusSection() ?? 'providers');

  protected select(category: string): void {
    this.active.set(category);
    this.settingsService.focusAnchor.set(null);
  }

  protected close(): void {
    this.closed.emit();
  }

  protected onEscape(): void {
    if (this.draft.recording()) {
      return;
    }
    this.close();
  }
}
