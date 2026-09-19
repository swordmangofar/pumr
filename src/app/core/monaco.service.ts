import { Injectable } from '@angular/core';

interface MonacoEditorApi {
  colorize(
    text: string,
    languageId: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
  defineTheme?(name: string, theme: Record<string, unknown>): void;
  setTheme?(name: string): void;
}

interface MonacoApi {
  editor: MonacoEditorApi;
}

@Injectable({ providedIn: 'root' })
export class MonacoService {
  private loading: Promise<unknown> | null = null;
  private themeReady = false;

  load(): Promise<unknown> {
    if (!this.loading) {
      this.loading = this.loadInternal();
    }
    return this.loading;
  }

  async colorize(text: string, languageId: string): Promise<string> {
    const monaco = (await this.load()) as MonacoApi;
    this.ensureTheme(monaco);
    return monaco.editor.colorize(text, languageId, { tabSize: 2 });
  }

  private ensureTheme(monaco: MonacoApi): void {
    if (this.themeReady) {
      return;
    }
    monaco.editor.defineTheme?.('pumr-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a1120',
        'editorGutter.background': '#0a1120',
        'editorLineNumber.foreground': '#e5e5e533',
        'editorLineNumber.activeForeground': '#fca311',
      },
    });
    monaco.editor.setTheme?.('pumr-dark');
    this.themeReady = true;
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
