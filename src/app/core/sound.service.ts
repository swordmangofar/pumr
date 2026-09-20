import { Injectable, inject } from '@angular/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from './api';
import { Settings } from './models';
import { SettingsService } from './settings.service';

export type SoundKind = 'done' | 'permission' | 'error';

export interface SoundPreset {
  id: string;
  labelKey: string;
}

export const SOUND_NONE = 'none';
export const SOUND_CUSTOM = 'custom';

/**
 * Built-in notification sounds. All presets are synthesised at runtime with the
 * Web Audio API, so they are original works with no third-party licensing and
 * can be redistributed freely with the app.
 */
export const SOUND_PRESETS: Record<SoundKind, SoundPreset[]> = {
  done: [
    { id: 'chime', labelKey: 'settings.sounds.presets.chime' },
    { id: 'marimba', labelKey: 'settings.sounds.presets.marimba' },
    { id: 'pop', labelKey: 'settings.sounds.presets.pop' },
    { id: 'bell', labelKey: 'settings.sounds.presets.bell' },
    { id: 'soft', labelKey: 'settings.sounds.presets.soft' },
    { id: 'success', labelKey: 'settings.sounds.presets.success' },
    { id: 'harp', labelKey: 'settings.sounds.presets.harp' },
    { id: 'coin', labelKey: 'settings.sounds.presets.coin' },
    { id: 'droplet', labelKey: 'settings.sounds.presets.droplet' },
    { id: 'xylophone', labelKey: 'settings.sounds.presets.xylophone' },
  ],
  permission: [
    { id: 'ping', labelKey: 'settings.sounds.presets.ping' },
    { id: 'knock', labelKey: 'settings.sounds.presets.knock' },
    { id: 'double', labelKey: 'settings.sounds.presets.double' },
    { id: 'question', labelKey: 'settings.sounds.presets.question' },
    { id: 'ding', labelKey: 'settings.sounds.presets.ding' },
    { id: 'notify', labelKey: 'settings.sounds.presets.notify' },
    { id: 'woodblock', labelKey: 'settings.sounds.presets.woodblock' },
    { id: 'pulse', labelKey: 'settings.sounds.presets.pulse' },
    { id: 'echo', labelKey: 'settings.sounds.presets.echo' },
  ],
  error: [
    { id: 'alert', labelKey: 'settings.sounds.presets.alert' },
    { id: 'thud', labelKey: 'settings.sounds.presets.thud' },
    { id: 'buzz', labelKey: 'settings.sounds.presets.buzz' },
    { id: 'descend', labelKey: 'settings.sounds.presets.descend' },
    { id: 'error', labelKey: 'settings.sounds.presets.error' },
    { id: 'deny', labelKey: 'settings.sounds.presets.deny' },
    { id: 'glitch', labelKey: 'settings.sounds.presets.glitch' },
    { id: 'deep', labelKey: 'settings.sounds.presets.deep' },
    { id: 'horn', labelKey: 'settings.sounds.presets.horn' },
  ],
};

interface Note {
  f: number;
  t: number;
  d: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
}

const PRESET_NOTES: Record<string, Note[]> = {
  // Done — soft, positive, unobtrusive.
  chime: [
    { f: 1046.5, t: 0, d: 0.5, gain: 0.45 },
    { f: 1318.51, t: 0.12, d: 0.6, gain: 0.4 },
  ],
  marimba: [
    { f: 523.25, t: 0, d: 0.35, type: 'triangle', gain: 0.4 },
    { f: 659.25, t: 0.09, d: 0.35, type: 'triangle', gain: 0.35 },
    { f: 783.99, t: 0.18, d: 0.45, type: 'triangle', gain: 0.3 },
  ],
  pop: [{ f: 660, t: 0, d: 0.12, gain: 0.5, slideTo: 330 }],
  bell: [
    { f: 880, t: 0, d: 1.1, gain: 0.38 },
    { f: 1760, t: 0, d: 0.5, gain: 0.1 },
  ],
  soft: [
    { f: 783.99, t: 0, d: 0.5, gain: 0.35 },
    { f: 1046.5, t: 0.14, d: 0.7, gain: 0.32 },
  ],
  success: [
    { f: 523.25, t: 0, d: 0.18, gain: 0.4 },
    { f: 659.25, t: 0.12, d: 0.18, gain: 0.4 },
    { f: 783.99, t: 0.24, d: 0.18, gain: 0.4 },
    { f: 1046.5, t: 0.36, d: 0.5, gain: 0.4 },
  ],
  harp: [
    { f: 587.33, t: 0, d: 0.4, type: 'triangle', gain: 0.35 },
    { f: 880, t: 0.07, d: 0.4, type: 'triangle', gain: 0.32 },
    { f: 1174.66, t: 0.14, d: 0.4, type: 'triangle', gain: 0.3 },
    { f: 1760, t: 0.21, d: 0.6, type: 'triangle', gain: 0.26 },
  ],
  coin: [
    { f: 987.77, t: 0, d: 0.09, type: 'triangle', gain: 0.4 },
    { f: 1318.51, t: 0.07, d: 0.3, type: 'triangle', gain: 0.38 },
  ],
  droplet: [
    { f: 1200, t: 0, d: 0.18, gain: 0.45, slideTo: 600 },
    { f: 600, t: 0.06, d: 0.25, gain: 0.2, slideTo: 300 },
  ],
  xylophone: [
    { f: 1046.5, t: 0, d: 0.16, type: 'triangle', gain: 0.4 },
    { f: 783.99, t: 0.09, d: 0.16, type: 'triangle', gain: 0.35 },
    { f: 1046.5, t: 0.18, d: 0.3, type: 'triangle', gain: 0.35 },
  ],
  // Permission — clear call for attention without being harsh.
  ping: [{ f: 880, t: 0, d: 0.35, gain: 0.45 }],
  knock: [
    { f: 200, t: 0, d: 0.09, type: 'triangle', gain: 0.6 },
    { f: 180, t: 0.14, d: 0.09, type: 'triangle', gain: 0.5 },
  ],
  double: [
    { f: 659.25, t: 0, d: 0.18, gain: 0.45 },
    { f: 987.77, t: 0.16, d: 0.22, gain: 0.4 },
  ],
  question: [
    { f: 587.33, t: 0, d: 0.18, gain: 0.4 },
    { f: 880, t: 0.16, d: 0.3, gain: 0.4 },
  ],
  ding: [
    { f: 1318.51, t: 0, d: 0.9, gain: 0.38 },
    { f: 2637.02, t: 0, d: 0.35, gain: 0.07 },
  ],
  notify: [
    { f: 698.46, t: 0, d: 0.16, gain: 0.42 },
    { f: 880, t: 0.14, d: 0.28, gain: 0.4 },
  ],
  woodblock: [
    { f: 1000, t: 0, d: 0.07, type: 'triangle', gain: 0.5 },
    { f: 1500, t: 0.005, d: 0.05, type: 'triangle', gain: 0.15 },
  ],
  pulse: [
    { f: 880, t: 0, d: 0.08, gain: 0.4 },
    { f: 880, t: 0.14, d: 0.08, gain: 0.4 },
  ],
  echo: [
    { f: 659.25, t: 0, d: 0.16, gain: 0.4 },
    { f: 659.25, t: 0.22, d: 0.16, gain: 0.18 },
  ],
  // Error — negative but not startling.
  alert: [
    { f: 440, t: 0, d: 0.25, type: 'triangle', gain: 0.5 },
    { f: 349.23, t: 0.2, d: 0.4, type: 'triangle', gain: 0.45 },
  ],
  thud: [{ f: 160, t: 0, d: 0.3, gain: 0.6, slideTo: 90 }],
  buzz: [
    { f: 180, t: 0, d: 0.3, type: 'sawtooth', gain: 0.22 },
    { f: 170, t: 0.12, d: 0.3, type: 'sawtooth', gain: 0.2 },
  ],
  descend: [
    { f: 659.25, t: 0, d: 0.2, gain: 0.4 },
    { f: 523.25, t: 0.18, d: 0.2, gain: 0.4 },
    { f: 392, t: 0.36, d: 0.35, gain: 0.4 },
  ],
  error: [
    { f: 392, t: 0, d: 0.22, type: 'triangle', gain: 0.5 },
    { f: 311.13, t: 0.18, d: 0.4, type: 'triangle', gain: 0.45 },
  ],
  deny: [
    { f: 220, t: 0, d: 0.1, type: 'triangle', gain: 0.55 },
    { f: 220, t: 0.16, d: 0.18, type: 'triangle', gain: 0.5 },
  ],
  glitch: [
    { f: 300, t: 0, d: 0.08, type: 'sawtooth', gain: 0.25 },
    { f: 450, t: 0.06, d: 0.08, type: 'sawtooth', gain: 0.22 },
    { f: 280, t: 0.13, d: 0.12, type: 'sawtooth', gain: 0.2 },
  ],
  deep: [{ f: 220, t: 0, d: 0.5, gain: 0.5, slideTo: 110 }],
  horn: [
    { f: 330, t: 0, d: 0.35, type: 'sawtooth', gain: 0.22 },
    { f: 262, t: 0.22, d: 0.5, type: 'sawtooth', gain: 0.2 },
  ],
};

export const SOUND_SELECTION_KEYS: Record<SoundKind, keyof Settings> = {
  done: 'doneSound',
  permission: 'permissionSound',
  error: 'errorSound',
};

export const SOUND_PATH_KEYS: Record<SoundKind, keyof Settings> = {
  done: 'doneSoundPath',
  permission: 'permissionSoundPath',
  error: 'errorSoundPath',
};

@Injectable({ providedIn: 'root' })
export class SoundService {
  private readonly settings = inject(SettingsService);
  private context: AudioContext | null = null;

  constructor() {
    if (typeof window === 'undefined') {
      return;
    }
    // Browsers and webviews suspend audio until the user interacts with the
    // page, so resume the context on the first interaction.
    const unlock = (): void => {
      this.ensureContext();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** Plays the sound configured for a category, if sounds are enabled. */
  play(kind: SoundKind): void {
    const settings = this.settings.settings();
    if (!settings || !settings.soundsEnabled) {
      return;
    }
    const selection = String(settings[SOUND_SELECTION_KEYS[kind]] ?? SOUND_NONE);
    const path = String(settings[SOUND_PATH_KEYS[kind]] ?? '');
    this.playSelection(selection, path, settings.soundVolume);
  }

  /** Plays an explicit selection, used by the settings preview buttons. */
  preview(selection: string, path: string, volume: number): void {
    this.playSelection(selection, path, volume);
  }

  private playSelection(selection: string, path: string, volume: number): void {
    if (!selection || selection === SOUND_NONE) {
      return;
    }
    if (selection === SOUND_CUSTOM) {
      if (path) {
        void this.playFile(path, volume);
      }
      return;
    }
    this.playPreset(selection, volume);
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') {
      return null;
    }
    if (!this.context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        return null;
      }
      this.context = new Ctor();
    }
    if (this.context.state === 'suspended') {
      void this.context.resume();
    }
    return this.context;
  }

  private playPreset(id: string, volume: number): void {
    const notes = PRESET_NOTES[id];
    if (!notes) {
      return;
    }
    const context = this.ensureContext();
    if (!context) {
      return;
    }
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.value = Math.min(1, Math.max(0, volume));
    master.connect(context.destination);

    for (const note of notes) {
      const start = now + note.t;
      const end = start + note.d;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = note.type ?? 'sine';
      oscillator.frequency.setValueAtTime(note.f, start);
      if (note.slideTo) {
        oscillator.frequency.exponentialRampToValueAtTime(note.slideTo, end);
      }
      const peak = note.gain ?? 0.5;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(end + 0.05);
    }
  }

  private async playFile(path: string, volume: number): Promise<void> {
    if (!isTauri()) {
      return;
    }
    const context = this.ensureContext();
    if (!context) {
      return;
    }
    const url = convertFileSrc(path);
    const gainValue = Math.min(1, Math.max(0, volume));
    try {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const decoded = await context.decodeAudioData(buffer);
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = gainValue;
      source.buffer = decoded;
      source.connect(gain);
      gain.connect(context.destination);
      source.start();
    } catch {
      // Fall back to a media element for formats the decoder cannot handle.
      try {
        const audio = new Audio(url);
        audio.volume = gainValue;
        await audio.play();
      } catch {
        // Playback is best-effort; ignore unreadable or unsupported files.
      }
    }
  }
}
