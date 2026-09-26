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
}

const CATEGORIES: Category[] = [
  { id: 'providers', label: 'settings.categories.providers' },
  { id: 'agent', label: 'settings.categories.agent' },
  { id: 'agentRules', label: 'settings.categories.agentRules' },
  { id: 'general', label: 'settings.categories.general' },
  { id: 'chat', label: 'settings.categories.chat' },
  { id: 'appearance', label: 'settings.categories.appearance' },
  { id: 'notifications', label: 'settings.categories.notifications' },
  { id: 'hotkeys', label: 'settings.categories.hotkeys' },
  { id: 'window', label: 'settings.categories.window' },
  { id: 'skills', label: 'settings.categories.skills' },
  { id: 'mcp', label: 'settings.categories.mcp' },
  { id: 'workspace', label: 'settings.categories.workspace' },
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
                class="relative mb-1 flex w-full min-w-0 items-center break-words rounded-full px-4 py-2 text-left text-sm transition-colors"
                [class]="
                  category.id === active()
                    ? 'bg-accent font-medium text-ink'
                    : 'text-mist/50 hover:bg-white/5 hover:text-mist'
                "
                (click)="select(category.id)"
              >
                {{ category.label | transloco }}
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
