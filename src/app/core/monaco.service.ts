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

/** A registered language, as listed by `monaco.languages.getLanguages()`. */
export interface MonacoLanguage {
  id: string;
  aliases?: string[];
  extensions?: string[];
}

export interface MonacoApi {
  editor: MonacoEditorApi;
  languages: { getLanguages(): MonacoLanguage[] };
}

/**
 * Fence names colorized as another language. Monaco only sets up its JSON
 * tokenizer for editor models, so `colorize` would leave JSON plain; the
 * JavaScript tokenizer covers JSON syntax.
 */
const FENCE_ALIASES = new Map([
  ['console', 'shell'],
  ['zsh', 'shell'],
  ['json', 'javascript'],
  ['jsonc', 'javascript'],
]);

/**
 * Resolves a markdown code fence name (`ts`, `bash`, `py`, …) to the registered
 * Monaco language that colorizes it, by id, alias or file extension. Plain text
 * resolves to null, as there is nothing to colorize.
 */
export function fenceLanguage(languages: MonacoLanguage[], fence: string): string | null {
  const name = fence.toLowerCase();
  const wanted = FENCE_ALIASES.get(name) ?? name;
  const match =
    languages.find((language) => language.id === wanted) ??
    languages.find((language) =>
      language.aliases?.some((alias) => alias.toLowerCase() === wanted),
    ) ??
    languages.find((language) => language.extensions?.includes(`.${wanted}`));
  return match && match.id !== 'plaintext' ? match.id : null;
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

  async colorize(text: string, languageId: string, tabSize = 2): Promise<string> {
    const monaco = (await this.load()) as MonacoApi;
    this.applyTheme(monaco);
    return monaco.editor.colorize(text, languageId, { tabSize });
  }

  /** Colorizes a markdown code block, or resolves to null for a language Monaco cannot tokenize. */
  async colorizeFence(text: string, fence: string): Promise<string | null> {
    const monaco = (await this.load()) as MonacoApi;
    const language = fenceLanguage(monaco.languages.getLanguages(), fence);
    return language ? this.colorize(text, language) : null;
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
