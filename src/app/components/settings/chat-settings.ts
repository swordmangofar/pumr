import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-chat-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.chat.pasteWordLimit' | transloco }}
      </label>
      <input
        type="number"
        min="0"
        step="50"
        class="field w-40 rounded-xl px-4 py-2 text-sm"
        [value]="draft.draft().pasteWordLimit"
        (input)="draft.patch('pasteWordLimit', +$any($event.target).value)"
      />
      <p class="mt-2 text-xs leading-relaxed text-mist/30">
        {{ 'settings.chat.pasteWordLimitHint' | transloco }}
      </p>
    </section>
  `,
})
export class ChatSettings {
  protected readonly draft = inject(SettingsDraftService);
}
