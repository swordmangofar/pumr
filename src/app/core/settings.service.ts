import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { api } from './api';
import { BackgroundService } from './background.service';
import { LogoService } from './logo.service';
import {
  CommandRule,
  DefaultSystemPrompts,
  McpToolGrant,
  Mode,
  Settings,
  UserSystemPrompt,
} from './models';
import { ModelsService } from './models.service';
import { ProvidersService } from './providers.service';
import { ThemeService } from './theme.service';
import { ZoomService } from './zoom.service';

export { FALLBACK_SETTINGS } from './settings-defaults';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly background = inject(BackgroundService);
  private readonly logo = inject(LogoService);
  private readonly zoom = inject(ZoomService);
  private readonly providers = inject(ProvidersService);
  private readonly models = inject(ModelsService);
  private readonly state = signal<Settings | null>(null);

  constructor() {
    this.theme.init();
  }

  readonly settings = this.state.asReadonly();
  /**
   * A provider is set up and offers models, but none is the default yet, so
   * new sessions start without a model.
   */
  readonly needsDefaultModel = computed(() => {
    const settings = this.state();
    return (
      !!settings &&
      !settings.defaultModel &&
      this.providers.anyConnected() &&
      this.models.models().length > 0
    );
  });
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly defaultSystemPrompt = computed(() => this.state()?.defaultSystemPrompt ?? '');
  readonly originalSystemPrompts = signal<DefaultSystemPrompts>({
    defaultSystemPrompt: '',
    securitySystemPrompt: '',
    testingSystemPrompt: '',
    architectureSystemPrompt: '',
    userSystemPrompts: [],
  });
  readonly originalUserSystemPrompts = signal<UserSystemPrompt[]>([]);
  readonly originalModes = signal<Mode[]>([]);
  readonly modes = computed(() => this.state()?.modes ?? []);
  readonly dialogOpen = signal(false);
  readonly focusSection = signal<string | null>(null);
  readonly focusAnchor = signal<string | null>(null);

  open(section?: string, anchor?: string): void {
    this.focusSection.set(section ?? null);
    this.focusAnchor.set(anchor ?? null);
    this.dialogOpen.set(true);
  }

  close(): void {
    const settings = this.state();
    if (settings) {
      this.theme.setCustom(settings.customTheme);
    }
    this.theme.apply(settings?.theme);
    this.theme.applyContrast(settings?.highContrast ?? false);
    this.theme.applyGlassOpacity(settings?.glassOpacity ?? 1);
    this.background.apply(settings);
    this.logo.apply(settings?.logo);
    this.zoom.apply(settings?.zoom ?? 1);
    this.dialogOpen.set(false);
    this.focusSection.set(null);
    this.focusAnchor.set(null);
  }

  async init(): Promise<void> {
    try {
      const settings = await api.getSettings();
      this.state.set(settings);
      this.theme.setCustom(settings.customTheme);
      this.theme.apply(settings.theme);
      this.theme.applyContrast(settings.highContrast);
      this.theme.applyGlassOpacity(settings.glassOpacity);
      this.background.apply(settings);
      this.logo.apply(settings.logo);
      this.zoom.apply(settings.zoom);
      try {
        const defaults = await api.getDefaultSystemPrompts();
        this.originalSystemPrompts.set(defaults);
        this.originalUserSystemPrompts.set(defaults.userSystemPrompts);
        this.originalModes.set(await api.getDefaultModes());
      } catch {
        this.originalSystemPrompts.set({
          defaultSystemPrompt: settings.defaultSystemPrompt,
          securitySystemPrompt: settings.securitySystemPrompt,
          testingSystemPrompt: settings.testingSystemPrompt,
          architectureSystemPrompt: settings.architectureSystemPrompt,
          userSystemPrompts: settings.userSystemPrompts,
        });
        this.originalUserSystemPrompts.set(settings.userSystemPrompts);
      }
      this.transloco.setActiveLang(settings.language || 'en');
      await this.providers.load();
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.loaded.set(true);
    }
  }

  async save(settings: Settings): Promise<Settings> {
    const saved = await api.saveSettings(settings);
    this.state.set(saved);
    this.theme.setCustom(saved.customTheme);
    this.theme.apply(saved.theme);
    this.theme.applyContrast(saved.highContrast);
    this.theme.applyGlassOpacity(saved.glassOpacity);
    this.background.apply(saved);
    this.logo.apply(saved.logo);
    this.zoom.apply(saved.zoom);
    this.transloco.setActiveLang(saved.language || 'en');
    return saved;
  }

  async patch(patch: Partial<Settings>): Promise<Settings> {
    const current = this.state();
    if (!current) {
      throw new Error('Settings not loaded');
    }
    return this.save({ ...current, ...patch });
  }

  async reload(): Promise<void> {
    try {
      this.state.set(await api.getSettings());
    } catch {
      // Keep the last known settings when the refresh fails.
    }
  }

  /** Takes over settings the backend already saved (e.g. a provider change). */
  adopt(settings: Settings): void {
    this.state.set(settings);
  }

  async addCommandRule(rule: CommandRule, allow: boolean): Promise<void> {
    const settings = await api.addCommandRule(rule, allow);
    this.state.set(settings);
  }

  async deleteCommandRule(rule: CommandRule, allow: boolean): Promise<void> {
    const settings = await api.deleteCommandRule(rule, allow);
    this.state.set(settings);
  }

  async addWebsiteRule(rule: string, allow: boolean): Promise<void> {
    const settings = await api.addWebsiteRule(rule, allow);
    this.state.set(settings);
  }

  async deleteWebsiteRule(rule: string, allow: boolean): Promise<void> {
    const settings = await api.deleteWebsiteRule(rule, allow);
    this.state.set(settings);
  }

  async deleteMcpToolGrant(grant: McpToolGrant): Promise<void> {
    const settings = await api.deleteMcpToolGrant(grant);
    this.state.set(settings);
  }

  async deleteSecretFolder(folder: string): Promise<void> {
    const settings = await api.deleteSecretFolder(folder);
    this.state.set(settings);
  }
}
