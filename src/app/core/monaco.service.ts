import { Injectable, inject } from '@angular/core';
import { ThemeService } from './theme.service';

interface MonacoEditorApi {
  colorize(
    text: string,
    languageId: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
  defineTheme?(name: string, theme: Record<string, unknown>): void;
  setTheme?(name: string): void;
}

export interface MonacoApi {
  editor: MonacoEditorApi;
}

@Injectable({ providedIn: 'root' })
export class MonacoService {
  private readonly themeService = inject(ThemeService);
  private loading: Promise<unknown> | null = null;
  private appliedThemeId: string | null = null;

  load(): Promise<unknown> {
    if (!this.loading) {
      this.loading = this.loadInternal();
    }
    return this.loading;
  }

  currentThemeName(): string {
    return `pumr-${this.themeService.current().id}`;
  }

  async colorize(text: string, languageId: string): Promise<string> {
    const monaco = (await this.load()) as MonacoApi;
    this.applyTheme(monaco);
    return monaco.editor.colorize(text, languageId, { tabSize: 2 });
  }

  applyTheme(monaco: MonacoApi): void {
    const theme = this.themeService.current();
    if (this.appliedThemeId === theme.id) {
      return;
    }
    monaco.editor.defineTheme?.(this.currentThemeName(), {
      base: theme.scheme === 'light' ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': theme.ink,
        'editorGutter.background': theme.ink,
        'editorLineNumber.foreground': `${theme.mist}33`,
        'editorLineNumber.activeForeground': theme.accent,
        'diffEditor.insertedTextBackground': `${theme.accent}1f`,
        'diffEditor.removedTextBackground': '#f43f5e1f',
      },
    });
    monaco.editor.setTheme?.(this.currentThemeName());
    this.appliedThemeId = theme.id;
  }

  private loadInternal(): Promise<unknown> {
    const global = window as unknown as Record<string, unknown>;
    return new Promise((resolve, reject) => {
      if (global['monaco']) {
        resolve(global['monaco']);
        return;
      }
      global['MonacoEnvironment'] = {
        getWorkerUrl: () => '/monaco/vs/base/worker/workerMain.js',
      };
      const script = document.createElement('script');
      script.src = '/monaco/vs/loader.js';
      script.onload = () => {
        const loader = global['require'] as
          | (((modules: string[], callback: () => void) => void) & {
              config?: (options: unknown) => void;
            })
          | undefined;
        if (!loader) {
          reject(new Error('Monaco loader unavailable'));
          return;
        }
        loader.config?.({ paths: { vs: '/monaco/vs' } });
        loader(['vs/editor/editor.main'], () => resolve(global['monaco']));
      };
      script.onerror = () => reject(new Error('Failed to load Monaco'));
      document.body.appendChild(script);
    });
  }
}
