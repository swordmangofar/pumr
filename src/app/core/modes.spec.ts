import { Mode } from './models';
import { nextMode, resolveMode } from './modes';

function mode(id: string, planOnly = false): Mode {
  return {
    id,
    name: id,
    description: '',
    systemPrompt: '',
    userPromptIds: [],
    mcpServers: [],
    skills: [],
    includeGlobalPrompts: true,
    includeProjectRules: true,
    planOnly,
    builtin: true,
  };
}

const MODES = [mode('coding'), mode('planning', true), mode('nacked'), mode('outline', true)];

describe('resolveMode', () => {
  it('finds the mode of a session and falls back to coding', () => {
    expect(resolveMode(MODES, 'nacked')?.id).toBe('nacked');
    expect(resolveMode(MODES, 'deleted')?.id).toBe('coding');
    expect(resolveMode(MODES, null)?.id).toBe('coding');
    expect(resolveMode([], 'coding')).toBeUndefined();
  });
});

describe('nextMode', () => {
  it('goes through every mode in order and starts again after the last', () => {
    const visited = [MODES[0]];
    for (let step = 0; step < MODES.length; step++) {
      visited.push(nextMode(MODES, visited[visited.length - 1])!);
    }
    expect(visited.map((mode) => mode.id)).toEqual([
      'coding',
      'planning',
      'nacked',
      'outline',
      'coding',
    ]);
  });

  it('starts at the first mode when the current one is not listed', () => {
    expect(nextMode(MODES, mode('deleted'))?.id).toBe('coding');
    expect(nextMode(MODES, undefined)?.id).toBe('coding');
  });

  it('has nowhere to go without another mode', () => {
    expect(nextMode([mode('coding')], mode('coding'))).toBeUndefined();
    expect(nextMode([], undefined)).toBeUndefined();
  });
});
