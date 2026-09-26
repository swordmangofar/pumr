import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '../../core/api';
import { UpdaterService } from '../../core/updater.service';
import { SettingsDraftService } from './settings-draft.service';

import { TypedInput } from '../typed-input';

@Component({
  selector: 'app-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  template: `
    <section>
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.language' | transloco }}
      </label>
      <select
        class="field field-select w-full max-w-64 rounded-xl py-2 pr-9 pl-4 text-sm"
        [value]="draft.draft().language"
        (typedValue)="draft.patch('language', $event)"
      >
        <option value="en">English</option>
        <option value="bg">Български</option>
        <option value="cs">Čeština</option>
        <option value="da">Dansk</option>
        <option value="de">Deutsch</option>
        <option value="el">Ελληνικά</option>
        <option value="es">Español</option>
        <option value="et">Eesti</option>
        <option value="fi">Suomi</option>
        <option value="fr">Français</option>
        <option value="ga">Gaeilge</option>
        <option value="hr">Hrvatski</option>
        <option value="hu">Magyar</option>
        <option value="it">Italiano</option>
        <option value="lt">Lietuvių</option>
        <option value="lv">Latviešu</option>
        <option value="mt">Malti</option>
        <option value="nl">Nederlands</option>
        <option value="pl">Polski</option>
        <option value="pt">Português</option>
        <option value="ro">Română</option>
        <option value="sk">Slovenčina</option>
        <option value="sl">Slovenščina</option>
        <option value="sv">Svenska</option>
      </select>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.languageHint' | transloco }}</p>
    </section>

    <section class="mt-8 flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.keepAwake' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.keepAwakeHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().keepAwake ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.patch('keepAwake', !draft.draft().keepAwake)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().keepAwake ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    <section class="mt-8 flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.tabsMultiline' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.tabsMultilineHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().tabsMultiline ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.patch('tabsMultiline', !draft.draft().tabsMultiline)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().tabsMultiline ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    <section class="mt-8">
      <h3 class="text-sm font-semibold text-white">
        {{ 'settings.update.title' | transloco }}
      </h3>

      @if (updater.available()) {
        <div class="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <p class="text-sm text-mist">
            {{ 'settings.update.available' | transloco: { version: updater.version() } }}
          </p>
          @if (updater.notes()) {
            <p class="mt-2 whitespace-pre-line text-xs leading-relaxed text-mist/40">
              {{ updater.notes() }}
            </p>
          }
          <button
            type="button"
            class="mt-3 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-ink transition-colors hover:bg-accent/90"
            (click)="updater.install()"
          >
            {{ 'settings.update.download' | transloco }}
          </button>
        </div>
      } @else if (updater.downloading()) {
        <div class="mt-3">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              class="h-full rounded-full bg-accent transition-all"
              [style.width.%]="updater.progress()"
            ></div>
          </div>
          <p class="mt-2 text-xs text-mist/40">
            {{ 'settings.update.downloading' | transloco: { progress: updater.progress() } }}
          </p>
        </div>
      } @else {
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          @if (updater.status() === 'checking') {
            {{ 'settings.update.checking' | transloco }}
          } @else if (updater.status() === 'ready') {
            {{ 'settings.update.restarting' | transloco }}
          } @else if (updater.status() === 'error') {
            {{ 'settings.update.error' | transloco }}
          } @else {
            {{ 'settings.update.upToDate' | transloco }}
          }
        </p>
        @if (tauri) {
          <button
            type="button"
            class="mt-3 rounded-full border border-white/15 px-4 py-1.5 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
            [disabled]="updater.busy()"
            (click)="updater.check()"
          >
            {{ 'settings.update.check' | transloco }}
          </button>
        }
      }

      @if (updater.status() === 'error' && updater.error()) {
        <p class="mt-2 break-words text-xs leading-relaxed text-red-400/80">
          {{ updater.error() }}
        </p>
      }
    </section>

    <section class="mt-8">
      <h3 class="mb-3 text-sm font-semibold text-white">
        {{ 'settings.general.about' | transloco }}
      </h3>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-mist/40">{{ 'settings.general.version' | transloco }}</dt>
          <dd class="text-mist">{{ appVersion() }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-mist/40">{{ 'settings.general.model' | transloco }}</dt>
          <dd class="text-mist">pumr · Angular + Tauri</dd>
        </div>
      </dl>
      <p class="mt-4 text-xs leading-relaxed text-mist/30">
        {{ 'settings.general.storage' | transloco }}
      </p>
    </section>
  `,
})
export class GeneralSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly updater = inject(UpdaterService);
  protected readonly tauri = isTauri();
  protected readonly appVersion = signal('0.1.0');

  constructor() {
    if (this.tauri) {
      void getVersion()
        .then((version) => this.appVersion.set(version))
        .catch(() => undefined);
    }
  }
}
