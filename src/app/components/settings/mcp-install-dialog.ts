import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { api } from '../../core/api';
import { MarketplaceEnv } from '../../core/models';
import { TypedInput } from '../typed-input';

/** What the user reviews before a directory or registry server is added. */
export interface McpInstallDraft {
  /** Suggested config key; the user may rename it. */
  name: string;
  displayName: string;
  command: string | null;
  args: string[];
  url: string | null;
  transport: string | null;
  env: MarketplaceEnv[];
  /** Tools the host needs, e.g. "node" or "docker". */
  requirements: string[];
  /** Set when the server only installs through its own CLI. */
  cli: string | null;
}

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Turns a registry or directory name into a valid config key. */
export function suggestServerName(name: string): string {
  const last = name.split('/').pop() || name;
  const cleaned = last
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'server';
}

/** The `mcpServers` JSON snippet for a draft, for copying into other tools. */
export function draftConfig(draft: McpInstallDraft, name = draft.name): string {
  if (draft.cli && !draft.command && !draft.url) {
    return draft.cli;
  }
  const entry: Record<string, unknown> = {};
  if (draft.url) {
    entry['url'] = draft.url;
    if (draft.transport) {
      entry['type'] = draft.transport;
    }
  } else if (draft.command) {
    entry['command'] = draft.command;
    if (draft.args.length > 0) {
      entry['args'] = draft.args;
    }
  }
  if (draft.env.length > 0) {
    entry['env'] = Object.fromEntries(draft.env.map((variable) => [variable.name, '']));
  }
  return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);
}

/**
 * Shows exactly what a server will run (or connect to) and asks for the
 * credentials it declares, then writes it to pumr's own MCP config. Nothing is
 * launched here: the server starts only after the per-session approval.
 */
@Component({
  selector: 'app-mcp-install-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  host: {
    '(document:keydown.escape)': 'cancel()',
  },
  template: `
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      (click)="cancel()"
    >
      <div
        class="flex max-h-full w-[32rem] max-w-full flex-col glass-pop rounded-2xl shadow-2xl"
        role="dialog"
        aria-modal="true"
        (click)="$event.stopPropagation()"
      >
        <div class="min-h-0 overflow-y-auto p-6">
          <h2 class="text-base font-semibold text-white">
            {{ 'settings.mcp.install.title' | transloco: { name: draft().displayName } }}
          </h2>
          <p class="mt-1 text-xs leading-relaxed text-mist/50">
            {{
              (cliOnly() ? 'settings.mcp.install.cliOnly' : 'settings.mcp.install.hint') | transloco
            }}
          </p>

          @if (!cliOnly()) {
            <label class="mt-4 block text-xs font-medium text-mist/70" for="mcp-install-name">
              {{ 'settings.mcp.install.name' | transloco }}
            </label>
            <input
              id="mcp-install-name"
              type="text"
              class="field mt-1 w-full rounded-lg px-2.5 py-1.5 font-mono text-[13px]"
              [value]="name()"
              (typedValue)="name.set($event)"
            />
            @if (!nameValid()) {
              <p class="mt-1 text-xs text-rose-400">
                {{ 'settings.mcp.install.invalidName' | transloco }}
              </p>
            } @else if (replaces()) {
              <p class="mt-1 text-xs text-amber-300">
                {{ 'settings.mcp.install.replace' | transloco }}
              </p>
            }
          }

          <p class="mt-4 text-xs font-medium text-mist/70">
            {{
              (draft().url ? 'settings.mcp.install.url' : 'settings.mcp.install.command')
                | transloco
            }}
          </p>
          <pre
            class="mt-1 overflow-x-auto rounded-lg border border-white/10 bg-ink/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-mist"
            >{{ launchLine() }}</pre>

          @if (draft().requirements.length > 0) {
            <p class="mt-2 text-xs text-mist/50">
              {{
                'settings.mcp.install.requirements'
                  | transloco: { names: draft().requirements.join(', ') }
              }}
            </p>
          }

          @if (!cliOnly() && draft().env.length > 0) {
            <p class="mt-4 text-xs font-medium text-mist/70">
              {{ 'settings.mcp.install.env' | transloco }}
            </p>
            <div class="mt-1 space-y-2">
              @for (variable of draft().env; track variable.name) {
                <label class="block">
                  <span class="flex items-center gap-2 font-mono text-[11px] text-mist/60">
                    {{ variable.name }}
                    @if (variable.required) {
                      <span class="font-sans text-[10px] text-amber-300">
                        {{ 'settings.mcp.install.required' | transloco }}
                      </span>
                    }
                  </span>
                  <input
                    class="field mt-0.5 w-full rounded-lg px-2.5 py-1.5 font-mono text-xs"
                    autocomplete="off"
                    spellcheck="false"
                    [type]="variable.secret ? 'password' : 'text'"
                    [value]="envValues()[variable.name] ?? ''"
                    (typedValue)="setEnv(variable.name, $event)"
                  />
                </label>
              }
            </div>
            <p class="mt-2 text-[11px] leading-relaxed text-mist/40">
              {{ 'settings.mcp.install.envHint' | transloco }}
            </p>
          }

          @if (error(); as text) {
            <p class="mt-3 text-xs text-rose-400">{{ text }}</p>
          }
        </div>
        <footer class="flex items-center justify-end gap-2 border-t border-white/5 px-6 py-4">
          <button
            type="button"
            class="mr-auto rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white"
            (click)="copy()"
          >
            {{ (copied() ? 'settings.mcp.copied' : 'settings.mcp.install.copy') | transloco }}
          </button>
          <button
            type="button"
            class="rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
            [disabled]="busy()"
            (click)="cancel()"
          >
            {{ 'common.cancel' | transloco }}
          </button>
          @if (!cliOnly()) {
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              [disabled]="!canInstall()"
              [attr.title]="
                missingRequired() ? ('settings.mcp.install.missingRequired' | transloco) : null
              "
              (click)="install()"
            >
              {{ 'settings.mcp.install.add' | transloco }}
            </button>
          }
        </footer>
      </div>
    </div>
  `,
})
export class McpInstallDialog {
  private readonly transloco = inject(TranslocoService);

  readonly draft = input.required<McpInstallDraft>();
  /** Names already in pumr's config, to warn before replacing one. */
  readonly installedNames = input<string[]>([]);
  readonly installed = output<string>();
  readonly closed = output<void>();

  protected readonly name = linkedSignal(() => this.draft().name);
  protected readonly envValues = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly copied = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly cliOnly = computed(() => {
    const draft = this.draft();
    return !draft.command && !draft.url;
  });
  protected readonly nameValid = computed(() => NAME_PATTERN.test(this.name().trim()));
  protected readonly replaces = computed(() => this.installedNames().includes(this.name().trim()));
  protected readonly missingRequired = computed(() =>
    this.draft().env.some(
      (variable) => variable.required && !(this.envValues()[variable.name] ?? '').trim(),
    ),
  );
  protected readonly canInstall = computed(
    () => !this.busy() && this.nameValid() && !this.missingRequired() && !this.cliOnly(),
  );
  protected readonly launchLine = computed(() => {
    const draft = this.draft();
    if (draft.url) {
      return draft.transport ? `${draft.url}  (${draft.transport})` : draft.url;
    }
    if (draft.command) {
      return [draft.command, ...draft.args.map(quoteArg)].join(' ');
    }
    return draft.cli ?? '';
  });

  protected setEnv(name: string, value: string): void {
    this.envValues.update((values) => ({ ...values, [name]: value }));
  }

  protected cancel(): void {
    if (!this.busy()) {
      this.closed.emit();
    }
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draftConfig(this.draft(), this.name().trim()));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      this.error.set(this.transloco.translate('common.clipboardError'));
    }
  }

  protected async install(): Promise<void> {
    if (!this.canInstall()) {
      return;
    }
    const draft = this.draft();
    const name = this.name().trim();
    this.busy.set(true);
    this.error.set(null);
    try {
      await api.installMcpServer({
        name,
        command: draft.url ? null : draft.command,
        args: draft.url ? [] : draft.args,
        url: draft.url,
        transport: draft.url ? draft.transport : null,
        env: Object.fromEntries(
          Object.entries(this.envValues()).filter(([, value]) => value.trim() !== ''),
        ),
      });
      this.installed.emit(name);
      this.closed.emit();
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
