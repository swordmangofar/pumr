import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconPath, providerIcon, providerIconName } from './provider-icons';

/** Tile colour per icon (see `providerIconName`); the logo is white on top. */
const COLORS: Record<string, string> = {
  openrouter: '#6467f2',
  anthropic: '#d97757',
  openai: '#0d0d0d',
  gemini: '#1a73e8',
  xai: '#0d0d0d',
  mistral: '#fa520f',
  deepseek: '#4d6bfe',
  groq: '#f55036',
  ollama: '#262626',
  lmstudio: '#4f46e5',
  together: '#0f6fff',
  fireworks: '#5019c5',
  deepinfra: '#1f2937',
  cerebras: '#f15a29',
  huggingface: '#ff9d00',
  nvidia: '#76b900',
  perplexity: '#1f6f6b',
  cohere: '#39594d',
  moonshot: '#16191e',
  kimi: '#16191e',
  zai: '#2d2d2d',
  zhipu: '#3859ff',
  minimax: '#e73562',
  alibaba: '#ff6a00',
  vercel: '#0d0d0d',
  v0: '#0d0d0d',
  opencode: '#211e1e',
  novita: '#16a34a',
  siliconcloud: '#7c3aed',
  nebius: '#052b42',
  venice: '#dc2626',
  chutes: '#0f766e',
  baseten: '#1e293b',
  meta: '#0866ff',
  digitalocean: '#0069ff',
  stepfun: '#005aff',
  volcengine: '#1664ff',
  tencent: '#0052d9',
  poe: '#5d5cde',
};

const SIZES = {
  xs: 'h-4 w-4 rounded p-[2px] text-[8px]',
  sm: 'h-5 w-5 rounded-md p-[3px] text-[9px]',
  md: 'h-8 w-8 rounded-lg p-[6px] text-xs',
};

/**
 * A provider's logo on its colour, drawn inline: the app's CSP does not load
 * remote images. Unknown providers get their initial instead.
 */
@Component({
  selector: 'app-provider-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', 'aria-hidden': 'true' },
  template: `
    <span
      class="inline-flex items-center justify-center font-semibold leading-none text-white ring-1 ring-white/15"
      [class]="sizeClass()"
      [style.background-color]="color()"
    >
      @if (paths(); as paths) {
        <svg class="h-full w-full" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd">
          @for (path of paths; track $index) {
            <path [attr.d]="path.d" [attr.opacity]="path.opacity ?? null" />
          }
        </svg>
      } @else {
        {{ initial() }}
      }
    </span>
  `,
})
export class ProviderMark {
  readonly provider = input.required<string>();
  readonly size = input<keyof typeof SIZES>('sm');

  protected readonly paths = computed<readonly IconPath[] | null>(() =>
    providerIcon(this.provider()),
  );
  protected readonly color = computed(() => COLORS[providerIconName(this.provider())] ?? '#64748b');
  protected readonly initial = computed(() => this.provider().charAt(0).toUpperCase() || '?');
  protected readonly sizeClass = computed(() => SIZES[this.size()]);
}
