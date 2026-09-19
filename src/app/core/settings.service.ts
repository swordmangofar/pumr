import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { OPENROUTER_PROVIDER, api } from './api';
import { DefaultSystemPrompts, Settings, UserSystemPrompt } from './models';
import { ThemeService } from './theme.service';
import { DEFAULT_THEME_ID } from './themes';

export const FALLBACK_SETTINGS: Settings = {
  defaultSystemPrompt: '',
  securitySystemPromptEnabled: false,
  securitySystemPrompt: '',
  testingSystemPromptEnabled: false,
  testingSystemPrompt: '',
  architectureSystemPromptEnabled: false,
  architectureSystemPrompt: '',
  userSystemPrompts: [],
  budgetUsd: 0,
  language: 'en',
  theme: DEFAULT_THEME_ID,
  highContrast: false,
  extraFolders: [],
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: null,
  defaultReasoningEffort: 'medium',
  favoriteModels: [],
  contextMessageLimit: 40,
  commandRules: [],
  allowedWebsites: [],
  deniedWebsites: [],
  mcpAutoDiscovery: true,
  mcpFolders: [],
  mcpDisabled: [],
  skillsAutoDiscovery: true,
  skillFolders: [],
  skillsDisabled: [],
  keepAwake: true,
  tabsMultiline: true,
};

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly transloco = inject(TranslocoService);
  private readonly theme = inject(ThemeService);
  private readonly state = signal<Settings | null>(null);

  constructor() {
    this.theme.init();
  }

  readonly settings = this.state.asReadonly();
  readonly hasApiKey = signal(false);
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
  readonly dialogOpen = signal(false);
  readonly focusSection = signal<string | null>(null);
  readonly focusAnchor = signal<string | null>(null);

  open(section?: string, anchor?: string): void {
    this.focusSection.set(section ?? null);
    this.focusAnchor.set(anchor ?? null);
    this.dialogOpen.set(true);
  }

  close(): void {
    this.theme.apply(this.state()?.theme);
    this.theme.applyContrast(this.state()?.highContrast ?? false);
    this.dialogOpen.set(false);
    this.focusSection.set(null);
    this.focusAnchor.set(null);
  }

  async init(): Promise<void> {
    try {
      const settings = await api.getSettings();
      this.state.set(settings);
      this.theme.apply(settings.theme);
      this.theme.applyContrast(settings.highContrast);
      try {
        const defaults = await api.getDefaultSystemPrompts();
        this.originalSystemPrompts.set(defaults);
        this.originalUserSystemPrompts.set(defaults.userSystemPrompts);
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
      this.hasApiKey.set(await api.hasApiKey(OPENROUTER_PROVIDER));
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.loaded.set(true);
    }
  }

  async save(settings: Settings): Promise<Settings> {
    const saved = await api.saveSettings(settings);
    this.state.set(saved);
    this.theme.apply(saved.theme);
    this.theme.applyContrast(saved.highContrast);
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

  async setApiKey(key: string): Promise<void> {
    await api.setApiKey(OPENROUTER_PROVIDER, key);
    this.hasApiKey.set(await api.hasApiKey(OPENROUTER_PROVIDER));
  }

  async deleteApiKey(): Promise<void> {
    await api.deleteApiKey(OPENROUTER_PROVIDER);
    this.hasApiKey.set(false);
  }

  async addCommandRule(rule: string): Promise<void> {
    const settings = await api.addCommandRule(rule);
    this.state.set(settings);
  }

  async deleteCommandRule(rule: string): Promise<void> {
    const settings = await api.deleteCommandRule(rule);
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
}
