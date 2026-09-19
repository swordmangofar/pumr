import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { MonacoService } from '../core/monaco.service';
import { FileDiff } from '../core/models';

interface MonacoEditor {
  setModel(model: unknown): void;
  updateOptions(options: Record<string, unknown>): void;
  dispose(): void;
}

interface MonacoModel {
  dispose(): void;
}

interface MonacoApi {
  editor: {
    createDiffEditor(container: HTMLElement, options: Record<string, unknown>): MonacoEditor;
    createModel(content: string, language: string): MonacoModel;
    defineTheme?(name: string, theme: Record<string, unknown>): void;
  };
}

@Component({
  selector: 'app-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #container class="h-full w-full"></div>`,
})
export class DiffView implements OnDestroy {
  readonly diff = input.required<FileDiff | null>();
  readonly sideBySide = input<boolean>(false);

  private readonly monacoService = inject(MonacoService);
  private readonly container = viewChild<ElementRef<HTMLDivElement>>('container');

  private editor: MonacoEditor | null = null;
  private originalModel: MonacoModel | null = null;
  private modifiedModel: MonacoModel | null = null;

  constructor() {
    effect(() => {
      const diff = this.diff();
      const sideBySide = this.sideBySide();
      const container = this.container()?.nativeElement;
      if (!container) {
        return;
      }
      void this.render(container, diff, sideBySide);
    });
  }

  ngOnDestroy(): void {
    this.editor?.dispose();
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
  }

  private async render(
    container: HTMLElement,
    diff: FileDiff | null,
    sideBySide: boolean,
  ): Promise<void> {
    const monaco = (await this.monacoService.load()) as MonacoApi;
    monaco.editor.defineTheme?.('pumr-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a1120',
        'editorGutter.background': '#0a1120',
        'editorLineNumber.foreground': '#e5e5e533',
        'editorLineNumber.activeForeground': '#fca311',
        'diffEditor.insertedTextBackground': '#fca3111f',
        'diffEditor.removedTextBackground': '#f43f5e1f',
      },
    });
    if (!this.editor) {
      this.editor = monaco.editor.createDiffEditor(container, {
        readOnly: true,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        theme: 'pumr-dark',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: 20,
        renderOverviewRuler: false,
      });
    } else {
      this.editor.updateOptions({ renderSideBySide: sideBySide });
    }
    if (!diff) {
      return;
    }
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.originalModel = monaco.editor.createModel(diff.oldContent, diff.language);
    this.modifiedModel = monaco.editor.createModel(diff.newContent, diff.language);
    this.editor.setModel({ original: this.originalModel, modified: this.modifiedModel });
  }
}
