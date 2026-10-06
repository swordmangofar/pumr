import { UserSystemPrompt } from './models';

/** Commands the chat box has of its own; a prompt cannot take their names. */
export const CHAT_BOX_COMMANDS = ['btw', 'effort', 'mode', 'model', 'provider', 'revert'] as const;

/** The command that calls one of the user's prompts. */
export interface PromptCommand {
  prompt: UserSystemPrompt;
  /** What is typed after the slash. */
  name: string;
}

/**
 * The name a prompt of "Your prompts" is called by after a slash: its own name
 * in lower case, with everything that is no letter or digit made a hyphen
 * ("Code Review" is called with `/code-review`).
 */
export function promptCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The commands that call the user's prompts. A prompt has none when its name
 * leaves nothing to type or is taken already, by a command of the chat box or
 * by a prompt listed before it.
 */
export function promptCommands(prompts: readonly UserSystemPrompt[]): PromptCommand[] {
  const taken = new Set<string>(CHAT_BOX_COMMANDS);
  const commands: PromptCommand[] = [];
  for (const prompt of prompts) {
    const name = promptCommandName(prompt.name);
    if (name && !taken.has(name)) {
      taken.add(name);
      commands.push({ prompt, name });
    }
  }
  return commands;
}
