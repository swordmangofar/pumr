import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { MonacoApi as BaseMonacoApi, MonacoService } from '../core/monaco.service';
import { ThemeService } from '../core/theme.service';
import { WorkspaceFile } from '../core/models';

interface MonacoEditor {
  setModel(model: unknown): void;
  updateOptions(options: Record<string, unknown>): void;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

interface MonacoModel {
  getValue(): string;
  setValue(value: string): void;
  dispose(): void;
}

interface MonacoApi extends BaseMonacoApi {
  editor: BaseMonacoApi['editor'] & {
    create(container: HTMLElement, options: Record<string, unknown>): MonacoEditor;
    createModel(content: string, language: string): MonacoModel;
  };
}

@Component({
  selector: 'app-file-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #container class="h-full w-full"></div>`,
})
export class FileView implements OnDestroy {
  readonly file = input.required<WorkspaceFile | null>();
  readonly readOnly = input<boolean>(true);
  readonly contentChange = output<string>();

  private readonly monacoService = inject(MonacoService);
  private readonly themeService = inject(ThemeService);
  private readonly container = viewChild<ElementRef<HTMLDivElement>>('container');

  private editor: MonacoEditor | null = null;
  private model: MonacoModel | null = null;
  private changeSubscription: { dispose(): void } | null = null;
  private currentPath: string | null = null;
  private suppress = false;

  constructor() {
    effect(() => {
      const file = this.file();
      const readOnly = this.readOnly();
      this.themeService.current();
      const container = this.container()?.nativeElement;
      if (!container) {
        return;
      }
      void this.render(container, file, readOnly);
    });
  }

  ngOnDestroy(): void {
    this.changeSubscription?.dispose();
    this.editor?.dispose();
    this.model?.dispose();
  }

  private async render(
    container: HTMLElement,
    file: WorkspaceFile | null,
    readOnly: boolean,
  ): Promise<void> {
    const monaco = (await this.monacoService.load()) as MonacoApi;
    this.monacoService.applyTheme(monaco);
    const themeName = this.monacoService.currentThemeName();
    if (!this.editor) {
      this.editor = monaco.editor.create(container, {
        readOnly,
        automaticLayout: true,
        theme: themeName,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: 20,
        renderOverviewRuler: false,
        wordWrap: 'off',
      });
      this.changeSubscription = this.editor.onDidChangeModelContent(() => {
        if (this.suppress) {
          return;
        }
        this.contentChange.emit(this.model?.getValue() ?? '');
      });
    } else {
      this.editor.updateOptions({ readOnly, theme: themeName });
    }
    if (!file) {
      return;
    }
    if (this.currentPath !== file.path) {
      this.currentPath = file.path;
      this.model?.dispose();
      this.model = monaco.editor.createModel(file.content, file.language);
      this.editor.setModel(this.model);
      return;
    }
    if (this.model && this.model.getValue() !== file.content) {
      this.suppress = true;
      this.model.setValue(file.content);
      this.suppress = false;
    }
  }
}
