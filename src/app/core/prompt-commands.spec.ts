import { UserSystemPrompt } from './models';
import { promptCommandName, promptCommands } from './prompt-commands';

function prompt(id: string, name: string): UserSystemPrompt {
  return { id, name, prompt: `Text of ${name}` };
}

describe('promptCommandName', () => {
  it('turns a prompt name into what is typed after the slash', () => {
    expect(promptCommandName('Code Review')).toBe('code-review');
    expect(promptCommandName('UI/UX Designing')).toBe('ui-ux-designing');
    expect(promptCommandName('  Release notes (v2)! ')).toBe('release-notes-v2');
  });

  it('keeps letters of every script', () => {
    expect(promptCommandName('Prüfer für Änderungen')).toBe('prüfer-für-änderungen');
    expect(promptCommandName('Преглед на кода')).toBe('преглед-на-кода');
  });

  it('leaves nothing of a name without letters or digits', () => {
    expect(promptCommandName(' — !? ')).toBe('');
  });
});

describe('promptCommands', () => {
  it('gives every prompt the command of its name', () => {
    const review = prompt('code-review', 'Code Review');
    const notes = prompt('custom-1', 'Release notes');
    expect(promptCommands([review, notes])).toEqual([
      { prompt: review, name: 'code-review' },
      { prompt: notes, name: 'release-notes' },
    ]);
  });

  it('follows the name a prompt was given, not its id', () => {
    expect(promptCommands([prompt('code-review', 'Strict review')])[0].name).toBe('strict-review');
  });

  it('leaves out prompts whose name is taken or cannot be typed', () => {
    const first = prompt('a', 'Review');
    const commands = promptCommands([
      prompt('m', 'Model'),
      prompt('b', 'BTW'),
      first,
      prompt('c', 'review!'),
      prompt('d', '???'),
    ]);
    expect(commands).toEqual([{ prompt: first, name: 'review' }]);
  });
});
