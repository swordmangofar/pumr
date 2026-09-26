import { MonacoLanguage, fenceLanguage } from './monaco.service';

// A subset of Monaco's registry, as returned by `monaco.languages.getLanguages()`.
const LANGUAGES: MonacoLanguage[] = [
  { id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text', 'text'] },
  { id: 'typescript', extensions: ['.ts', '.tsx', '.cts', '.mts'], aliases: ['TypeScript', 'ts'] },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs'], aliases: ['JavaScript', 'js'] },
  { id: 'shell', extensions: ['.sh', '.bash'], aliases: ['Shell', 'sh'] },
  { id: 'python', extensions: ['.py'], aliases: ['Python', 'py'] },
  { id: 'json', extensions: ['.json'], aliases: ['JSON', 'json'] },
  { id: 'cpp', extensions: ['.cpp', '.hpp'], aliases: ['C++', 'Cpp', 'cpp'] },
];

describe('fenceLanguage', () => {
  it('matches language ids, aliases and file extensions', () => {
    expect(fenceLanguage(LANGUAGES, 'typescript')).toBe('typescript');
    expect(fenceLanguage(LANGUAGES, 'ts')).toBe('typescript');
    expect(fenceLanguage(LANGUAGES, 'TSX')).toBe('typescript');
    expect(fenceLanguage(LANGUAGES, 'jsx')).toBe('javascript');
    expect(fenceLanguage(LANGUAGES, 'sh')).toBe('shell');
    expect(fenceLanguage(LANGUAGES, 'bash')).toBe('shell');
    expect(fenceLanguage(LANGUAGES, 'py')).toBe('python');
    expect(fenceLanguage(LANGUAGES, 'c++')).toBe('cpp');
  });

  it('maps common fence names Monaco does not register', () => {
    expect(fenceLanguage(LANGUAGES, 'console')).toBe('shell');
    expect(fenceLanguage(LANGUAGES, 'zsh')).toBe('shell');
  });

  it('colorizes JSON with the JavaScript tokenizer', () => {
    expect(fenceLanguage(LANGUAGES, 'json')).toBe('javascript');
    expect(fenceLanguage(LANGUAGES, 'jsonc')).toBe('javascript');
  });

  it('skips plain text and unknown languages', () => {
    expect(fenceLanguage(LANGUAGES, 'text')).toBeNull();
    expect(fenceLanguage(LANGUAGES, 'txt')).toBeNull();
    expect(fenceLanguage(LANGUAGES, 'toml')).toBeNull();
    expect(fenceLanguage(LANGUAGES, 'constructor')).toBeNull();
  });
});
