#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const separator = process.platform === 'win32' ? ';' : ':';
const cargoBin = join(homedir(), '.cargo', 'bin');
const env = { ...process.env };

if (existsSync(cargoBin)) {
  const parts = (env.PATH ?? '').split(separator).filter(Boolean);
  if (!parts.includes(cargoBin)) {
    env.PATH = [cargoBin, ...parts].join(separator);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// `pnpm dev` gets the DEV-badged icon set so the Dock entry is distinct from
// the installed release. Production builds never see this config.
if (args[0] === 'dev') {
  const devConfig = resolve(root, 'src-tauri', 'tauri.dev.conf.json');
  if (existsSync(devConfig)) {
    args.splice(1, 0, '--config', devConfig);
  }
}

const child = spawn('tauri', args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`Failed to start Tauri CLI: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
