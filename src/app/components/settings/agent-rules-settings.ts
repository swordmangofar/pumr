import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsService } from '../../core/settings.service';

@Component({
  selector: 'app-agent-rules-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.commandRules' | transloco }}
      </h3>
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
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
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
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.websiteRules' | transloco }}
      </h3>
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
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
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
export class AgentRulesSettings {
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