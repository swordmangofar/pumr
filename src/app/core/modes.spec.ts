import { Mode } from './models';
import { planToggleTarget, resolveMode } from './modes';

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

describe('planToggleTarget', () => {
  it('goes from a working mode to planning', () => {
    expect(planToggleTarget(MODES, MODES[0], null)?.id).toBe('planning');
    expect(planToggleTarget(MODES, MODES[2], null)?.id).toBe('planning');
  });

  it('goes back to the mode that was left for planning', () => {
    expect(planToggleTarget(MODES, MODES[1], 'nacked')?.id).toBe('nacked');
  });

  it('goes back to coding when the mode before is unknown, gone or plan-only', () => {
    expect(planToggleTarget(MODES, MODES[1], null)?.id).toBe('coding');
    expect(planToggleTarget(MODES, MODES[1], 'deleted')?.id).toBe('coding');
    expect(planToggleTarget(MODES, MODES[3], 'planning')?.id).toBe('coding');
  });

  it('uses another plan-only mode when the built-in one is gone', () => {
    const modes = [mode('coding'), mode('outline', true)];
    expect(planToggleTarget(modes, modes[0], null)?.id).toBe('outline');
  });

  it('has nowhere to go without a mode of the other kind', () => {
    expect(planToggleTarget([mode('coding')], mode('coding'), null)).toBeUndefined();
    expect(
      planToggleTarget([mode('planning', true)], mode('planning', true), null),
    ).toBeUndefined();
  });
});
