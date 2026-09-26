#!/usr/bin/env node
// Mirror-CI verification entry point for pumr.
// Runs the same gates locally that define "green" for this repository.
//
//   pnpm verify                 # run every gate
//   pnpm verify --list          # list gate names
//   pnpm verify frontend-build  # run selected gates only

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const gates = [
  { name: 'frontend-build', cmd: 'pnpm', args: ['exec', 'ng', 'build'] },
  { name: 'frontend-test', cmd: 'pnpm', args: ['exec', 'ng', 'test', '--watch=false'] },
  { name: 'rust-test', cmd: 'cargo', args: ['test', '--manifest-path', 'src-tauri/Cargo.toml'] },
];

const argv = process.argv.slice(2);

if (argv.includes('--list')) {
  for (const gate of gates) console.log(gate.name);
  process.exit(0);
}

const requested = argv.filter((arg) => !arg.startsWith('-'));
const selected = requested.length ? gates.filter((gate) => requested.includes(gate.name)) : gates;

if (requested.length && selected.length !== requested.length) {
  const known = new Set(gates.map((gate) => gate.name));
  const unknown = requested.filter((name) => !known.has(name));
  console.error(`Unknown gate(s): ${unknown.join(', ')}`);
  console.error(`Known gates: ${gates.map((gate) => gate.name).join(', ')}`);
  process.exit(2);
}

const binPath = [
  path.join(root, 'node_modules', '.bin'),
  '/opt/homebrew/bin',
  process.env.PATH ?? '',
]
  .filter(Boolean)
  .join(path.delimiter);

const results = [];
for (const gate of selected) {
  console.error(`\n=== ${gate.name} ===`);
  console.error(`$ ${gate.cmd} ${gate.args.join(' ')}\n`);
  const outcome = spawnSync(gate.cmd, gate.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PATH: binPath },
  });
  const passed = outcome.status === 0;
  results.push({ name: gate.name, passed, code: outcome.status });
  if (!passed) {
    console.error(`\n[${gate.name}] FAIL${outcome.status == null ? ' (did not start)' : ''}`);
  }
}

console.error('\n=== summary ===');
for (const result of results) {
  const code = result.code == null ? 'not started' : `exit ${result.code}`;
  console.error(`${result.passed ? 'PASS' : 'FAIL'}\t${result.name}\t(${code})`);
}

const failed = results.filter((result) => !result.passed);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} gate(s) failed.`);
  process.exit(1);
}
console.error(`\nAll ${results.length} gate(s) passed.`);
