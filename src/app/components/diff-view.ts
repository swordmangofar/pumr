import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MonacoApi as BaseMonacoApi, MonacoService } from '../core/monaco.service';
import { ThemeService } from '../core/theme.service';
import { FileDiff } from '../core/models';

interface MonacoCodeEditor {
  onDidChangeModelContent(listener: () => void): { dispose(): void };
}

interface MonacoDiffEditor {
  setModel(model: unknown): void;
  updateOptions(options: Record<string, unknown>): void;
  getModifiedEditor(): MonacoCodeEditor;
  dispose(): void;
}

interface MonacoModel {
  getValue(): string;
  setValue(value: string): void;
  dispose(): void;
}

interface MonacoApi extends BaseMonacoApi {
  editor: BaseMonacoApi['editor'] & {
    createDiffEditor(container: HTMLElement, options: Record<string, unknown>): MonacoDiffEditor;
    createModel(content: string, language: string): MonacoModel;
  };
}

@Component({
  selector: 'app-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="relative h-full w-full">
      <div #container class="h-full w-full" [class.invisible]="placeholder()"></div>
      @if (placeholder(); as key) {
        <div class="absolute inset-0 flex items-center justify-center p-4">
          <p class="text-sm text-mist/40">{{ key | transloco }}</p>
        </div>
      }
    </div>
  `,
})
export class DiffView implements OnDestroy {
  readonly diff = input.required<FileDiff | null>();
  readonly sideBySide = input<boolean>(false);
  readonly editable = input<boolean>(false);
  readonly contentChange = output<string>();

  /** Binary and oversized files arrive without content; say so instead. */
  protected readonly placeholder = computed(() => {
    const diff = this.diff();
    return diff?.binary ? 'common.binaryFile' : diff?.tooLarge ? 'common.fileTooLarge' : null;
  });

  private readonly monacoService = inject(MonacoService);
  private readonly themeService = inject(ThemeService);
  private readonly container = viewChild<ElementRef<HTMLDivElement>>('container');

  private editor: MonacoDiffEditor | null = null;
  private originalModel: MonacoModel | null = null;
  private modifiedModel: MonacoModel | null = null;
  private changeSubscription: { dispose(): void } | null = null;
  private currentPath: string | null = null;
  private suppress = false;

  constructor() {
    effect(() => {
      const diff = this.diff();
      const sideBySide = this.sideBySide();
      const editable = this.editable();
      this.themeService.current();
      const container = this.container()?.nativeElement;
      if (!container) {
        return;
      }
      void this.render(container, diff, sideBySide, editable);
    });
  }

  ngOnDestroy(): void {
    this.changeSubscription?.dispose();
    this.editor?.dispose();
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
  }

  private async render(
    container: HTMLElement,
    diff: FileDiff | null,
    sideBySide: boolean,
    editable: boolean,
  ): Promise<void> {
    const monaco = (await this.monacoService.load()) as MonacoApi;
    this.monacoService.applyTheme(monaco);
    const themeName = this.monacoService.currentThemeName();
    if (!this.editor) {
      this.editor = monaco.editor.createDiffEditor(container, {
        readOnly: !editable,
        originalEditable: false,
        renderSideBySide: sideBySide,
        automaticLayout: true,
        theme: themeName,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: 20,
        renderOverviewRuler: false,
      });
      this.changeSubscription = this.editor.getModifiedEditor().onDidChangeModelContent(() => {
        if (this.suppress) {
          return;
        }
        this.contentChange.emit(this.modifiedModel?.getValue() ?? '');
      });
    } else {
      this.editor.updateOptions({
        renderSideBySide: sideBySide,
        theme: themeName,
        readOnly: !editable,
      });
    }
    if (!diff) {
      return;
    }
    if (this.currentPath !== diff.path) {
      this.currentPath = diff.path;
      this.originalModel?.dispose();
      this.modifiedModel?.dispose();
      this.originalModel = monaco.editor.createModel(diff.oldContent, diff.language);
      this.modifiedModel = monaco.editor.createModel(diff.newContent, diff.language);
      this.editor.setModel({ original: this.originalModel, modified: this.modifiedModel });
      return;
    }
    this.applyValue(this.originalModel, diff.oldContent);
    this.applyValue(this.modifiedModel, diff.newContent);
  }

  private applyValue(model: MonacoModel | null, value: string): void {
    if (!model || model.getValue() === value) {
      return;
    }
    this.suppress = true;
    model.setValue(value);
    this.suppress = false;
  }
}
