import { Mode } from './models';

/** The built-in mode a session runs in when its own is gone. */
export const CODING_MODE_ID = 'coding';
/** The built-in plan-only mode. */
export const PLANNING_MODE_ID = 'planning';

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
 * Where the plan hotkey takes a session: from a plan-only mode back to the
 * mode it left for planning (coding when that is not known), and from any
 * other mode to planning. `undefined` when there is no mode to switch to.
 */
export function planToggleTarget(
  modes: readonly Mode[],
  current: Mode | undefined,
  previousId: string | null | undefined,
): Mode | undefined {
  if (current?.planOnly) {
    const working = modes.filter((mode) => !mode.planOnly);
    return (
      working.find((mode) => mode.id === previousId) ??
      working.find((mode) => mode.id === CODING_MODE_ID) ??
      working[0]
    );
  }
  const planning = modes.filter((mode) => mode.planOnly);
  return planning.find((mode) => mode.id === PLANNING_MODE_ID) ?? planning[0];
}
