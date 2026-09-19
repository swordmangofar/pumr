#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const separator = process.platform === 'win32' ? ';' : ':';
const cargoBin = join(homedir(), '.cargo', 'bin');
const env = { ...process.env };

if (existsSync(cargoBin)) {
  const parts = (env.PATH ?? '').split(separator).filter(Boolean);
  if (!parts.includes(cargoBin)) {
    env.PATH = [cargoBin, ...parts].join(separator);
  }
}

const child = spawn('tauri', process.argv.slice(2), {
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
