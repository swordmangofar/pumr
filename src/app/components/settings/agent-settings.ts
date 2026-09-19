import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsService } from '../../core/settings.service';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-agent-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.systemPrompt' | transloco }}
      </label>
      <textarea
        class="h-56 w-full resize-y rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm leading-relaxed text-mist outline-none focus:border-accent/60"
        [value]="draft.draft().defaultSystemPrompt"
        (input)="draft.patch('defaultSystemPrompt', $any($event.target).value)"
      ></textarea>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.systemPromptHint' | transloco }}</p>
    </section>

    <section class="mt-8 grid grid-cols-2 gap-6">
      <div>
        <label class="mb-2 block text-sm text-mist/50">{{ 'settings.budget' | transloco }}</label>
        <input
          type="number"
          min="0"
          step="0.5"
          class="w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-2 text-sm text-mist outline-none focus:border-accent/60"
          [value]="draft.draft().budgetUsd"
          (input)="draft.patch('budgetUsd', +$any($event.target).value)"
        />
        <p class="mt-2 text-xs text-mist/30">{{ 'settings.budgetHint' | transloco }}</p>
      </div>

      <div>
        <label class="mb-2 block text-sm text-mist/50">{{
          'settings.contextLimit' | transloco
        }}</label>
        <input
          type="number"
          min="0"
          step="5"
          class="w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-2 text-sm text-mist outline-none focus:border-accent/60"
          [value]="draft.draft().contextMessageLimit"
          (input)="draft.patch('contextMessageLimit', +$any($event.target).value)"
        />
        <p class="mt-2 text-xs text-mist/30">{{ 'settings.contextLimitHint' | transloco }}</p>
      </div>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.commandRules' | transloco }}
      </label>
      <div class="space-y-1.5">
        @for (rule of commandRules(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-mist">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteRule(rule)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noCommandRules' | transloco }}</p>
        }
      </div>
      <div class="mt-3 flex gap-2">
        <input
          class="min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/60 px-4 py-2 font-mono text-sm text-mist outline-none focus:border-accent/60"
          [placeholder]="'settings.rulePlaceholder' | transloco"
          [value]="newRule()"
          (input)="newRule.set($any($event.target).value)"
          (keydown.enter)="addRule()"
        />
        <button
          type="button"
          class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
          (click)="addRule()"
        >
          {{ 'settings.addRule' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.commandRulesHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.websiteRules' | transloco }}
      </label>
      <div class="space-y-1.5">
        @for (rule of allowedWebsites(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-emerald-300">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteWebsite(rule, true)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noAllowedWebsites' | transloco }}</p>
        }
      </div>
      <div class="mt-3 space-y-1.5">
        @for (rule of deniedWebsites(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-rose-500/20 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-rose-300">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteWebsite(rule, false)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noDeniedWebsites' | transloco }}</p>
        }
      </div>
      <div class="mt-3 flex gap-2">
        <input
          class="min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/60 px-4 py-2 font-mono text-sm text-mist outline-none focus:border-accent/60"
          [placeholder]="'settings.websitePlaceholder' | transloco"
          [value]="newWebsite()"
          (input)="newWebsite.set($any($event.target).value)"
          (keydown.enter)="addWebsite(true)"
        />
        <button
          type="button"
          class="rounded-full border border-emerald-500/30 px-4 py-2 text-sm text-emerald-300 transition-colors hover:bg-emerald-500/10"
          (click)="addWebsite(true)"
        >
          {{ 'settings.allowWebsite' | transloco }}
        </button>
        <button
          type="button"
          class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
          (click)="addWebsite(false)"
        >
          {{ 'settings.denyWebsite' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.websiteRulesHint' | transloco }}</p>
    </section>
  `,
})
export class AgentSettings {
  protected readonly draft = inject(SettingsDraftService);
  private readonly settingsService = inject(SettingsService);

  protected readonly newRule = signal('');
  protected readonly commandRules = () => this.settingsService.settings()?.commandRules ?? [];
  protected readonly newWebsite = signal('');
  protected readonly allowedWebsites = () => this.settingsService.settings()?.allowedWebsites ?? [];
  protected readonly deniedWebsites = () => this.settingsService.settings()?.deniedWebsites ?? [];

  protected async addRule(): Promise<void> {
    const rule = this.newRule().trim();
    if (!rule) {
      return;
    }
    await this.settingsService.addCommandRule(rule);
    this.newRule.set('');
  }

  protected async deleteRule(rule: string): Promise<void> {
    await this.settingsService.deleteCommandRule(rule);
  }

  protected async addWebsite(allow: boolean): Promise<void> {
    const rule = this.newWebsite().trim();
    if (!rule) {
      return;
    }
    await this.settingsService.addWebsiteRule(rule, allow);
    this.newWebsite.set('');
  }

  protected async deleteWebsite(rule: string, allow: boolean): Promise<void> {
    await this.settingsService.deleteWebsiteRule(rule, allow);
  }
}
