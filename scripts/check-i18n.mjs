#!/usr/bin/env node
// Enforces the localisation rules from AGENTS.md:
//   - every locale has exactly the same flat keys as en.json
//   - every value is a string, and is not blank where English is not
//   - interpolation tokens such as {{ count }} survive translation verbatim
//
//   node scripts/check-i18n.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'i18n');
const REFERENCE = 'en.json';

function flatten(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, name, out);
    } else {
      out[name] = value;
    }
  }
  return out;
}

function load(file) {
  return flatten(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
}

/** Interpolation tokens with their inner spacing normalised, sorted. */
function tokens(text) {
  return [...String(text).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]).sort();
}

const reference = load(REFERENCE);
const referenceKeys = Object.keys(reference);
const files = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && file !== REFERENCE)
  .sort();

const problems = [];
for (const file of files) {
  const locale = load(file);
  const keys = new Set(Object.keys(locale));
  const missing = referenceKeys.filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !(key in reference));
  for (const key of missing) problems.push(`${file}: missing key ${key}`);
  for (const key of extra) problems.push(`${file}: extra key ${key}`);

  for (const key of referenceKeys) {
    if (!keys.has(key)) continue;
    const value = locale[key];
    if (typeof value !== 'string') {
      problems.push(`${file}: ${key} is not a string`);
      continue;
    }
    if (value.trim() === '' && String(reference[key]).trim() !== '') {
      problems.push(`${file}: ${key} is empty`);
    }
    const expected = tokens(reference[key]).join(', ');
    const actual = tokens(value).join(', ');
    if (expected !== actual) {
      problems.push(`${file}: ${key} has placeholders [${actual}], expected [${expected}]`);
    }
  }
}

if (files.length === 0) {
  problems.push(`no locale files next to ${REFERENCE}`);
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} i18n problem(s) across ${files.length + 1} locale files.`);
  process.exit(1);
}
console.error(`i18n OK: ${files.length + 1} locales, ${referenceKeys.length} keys each.`);
