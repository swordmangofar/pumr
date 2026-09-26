/**
 * Runs before every spec file (angular.json `test.options.setupFiles`).
 *
 * Node 25 ships its own Web Storage: `localStorage` and `sessionStorage` are
 * defined on the global object, and without `--localstorage-file`
 * `localStorage` is an empty object with none of the Storage methods. Vitest's
 * jsdom environment only copies window properties the global does not have
 * yet, so specs got Node's objects instead of jsdom's and every
 * `localStorage.getItem` threw. Point both at the current jsdom window, which
 * is what they resolve to on Node 24 and older.
 *
 * The window is looked up on every access because each spec file gets a new
 * one while this global survives between files (tests do not run isolated).
 */
interface JsdomGlobal {
  jsdom?: { window: Pick<Window, 'localStorage' | 'sessionStorage'> };
}

const dom = globalThis as JsdomGlobal;
if (dom.jsdom) {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      get: () => dom.jsdom?.window[name],
    });
  }
}
