import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.language' | transloco }}
      </label>
      <select
        class="field field-select w-64 rounded-xl py-2 pr-9 pl-4 text-sm"
        [value]="draft.draft().language"
        (change)="draft.patch('language', $any($event.target).value)"
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
      <h3 class="mb-3 text-sm font-semibold text-white">
        {{ 'settings.general.about' | transloco }}
      </h3>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-mist/40">{{ 'settings.general.version' | transloco }}</dt>
          <dd class="text-mist">0.1.0</dd>
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
}
