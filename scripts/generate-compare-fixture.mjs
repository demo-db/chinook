#!/usr/bin/env node
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFixture, writeFixture } from './lib/compare-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const check = args.includes('--check');
const baseIndex = args.indexOf('--base-ref');
const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : null;
assert.equal(check ? args.filter((arg) => arg !== '--check' && arg !== '--base-ref' && arg !== baseRef).length : args.length, 0, 'usage: generate-compare-fixture.mjs [--check [--base-ref <git-ref>]]');
if (baseIndex >= 0) assert.ok(baseRef && !baseRef.startsWith('--'), '--base-ref requires a git ref');

if (check) {
  await verifyFixture({ root, baseRef });
  console.log('Verified pinned comparison fixture bytes, append-only manifest, schema, keys, foreign keys and expected query differences.');
} else {
  const entry = await writeFixture({ root });
  console.log(`Generated ${entry.candidate.path} (${entry.candidate.bytes} bytes; sha256 ${entry.candidate.sha256}).`);
  console.log('Re-run with --check to independently regenerate and verify the committed candidate.');
}
