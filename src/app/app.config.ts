import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideTransloco } from '@jsverse/transloco';
import { TranslocoHttpLoader } from './core/transloco.loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideTransloco({
      config: {
        availableLangs: [
          'en',
          'bg',
          'cs',
          'da',
          'de',
          'el',
          'es',
          'et',
          'fi',
          'fr',
          'ga',
          'hr',
          'hu',
          'it',
          'lt',
          'lv',
          'mt',
          'nl',
          'pl',
          'pt',
          'ro',
          'sk',
          'sl',
          'sv',
        ],
        defaultLang: 'en',
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: false,
      },
      loader: TranslocoHttpLoader,
    }),
  ],
};
