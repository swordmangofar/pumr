import { confirm } from '@tauri-apps/plugin-dialog';

/** Asks for confirmation in a native warning dialog; false when it cannot be shown. */
export async function confirmWarning(message: string): Promise<boolean> {
  try {
    return await confirm(message, { title: 'pumr', kind: 'warning' });
  } catch {
    return false;
  }
}
