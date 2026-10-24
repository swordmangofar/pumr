import { Mode } from './models';

/** The built-in mode a session runs in when its own is gone. */
export const CODING_MODE_ID = 'coding';

/** The mode with the given id, else coding, else whatever mode there is. */
export function resolveMode(
  modes: readonly Mode[],
  modeId: string | null | undefined,
): Mode | undefined {
  return (
    modes.find((mode) => mode.id === modeId) ??
    modes.find((mode) => mode.id === CODING_MODE_ID) ??
    modes[0]
  );
}

/**
 * Where the mode hotkey takes a session: to the mode after `current` in the
 * order of the mode picker, and from the last back to the first. `undefined`
 * when there is no other mode to switch to.
 */
export function nextMode(modes: readonly Mode[], current: Mode | undefined): Mode | undefined {
  const index = modes.findIndex((mode) => mode.id === current?.id);
  const next = modes[(index + 1) % modes.length];
  return next?.id === current?.id ? undefined : next;
}
