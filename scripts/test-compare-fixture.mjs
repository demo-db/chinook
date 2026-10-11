import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertAppendOnly, assertFixtureMetadata, assertPinnedRuntime, BASELINE_BYTES, BASELINE_SHA256, inspectCandidate, loadManifest, QUERY_LIMIT, QUERY_SQL, sha256, verifyFixture } from './lib/compare-fixture.mjs';

const root = new URL('../', import.meta.url).pathname;

test('the pinned official Node and SQLite versions are required', () => {
  assert.doesNotThrow(() => assertPinnedRuntime({ node: '24.20.0', sqlite: '3.53.4' }));
  assert.throws(() => assertPinnedRuntime({ node: '24.20.1', sqlite: '3.53.4' }), /requires Node 24\.20\.0/);
  assert.throws(() => assertPinnedRuntime({ node: '24.20.0', sqlite: '3.53.5' }), /requires SQLite 3\.53\.4/);
});

test('historic fixture manifest entries are append-only', () => {
  const first = { id: 'first', candidate: { sha256: 'a' } };
  const second = { id: 'second', candidate: { sha256: 'b' } };
  assert.doesNotThrow(() => assertAppendOnly({ fixtures: [first] }, { format: 'datatug-compare-fixtures/v1', appendOnly: true, fixtures: [first, second] }));
  assert.throws(() => assertAppendOnly({ fixtures: [first] }, { format: 'datatug-compare-fixtures/v1', appendOnly: true, fixtures: [second] }), /deleted historical entries|modified or reordered/);
  assert.throws(() => assertAppendOnly({ fixtures: [first] }, { format: 'datatug-compare-fixtures/v1', appendOnly: true, fixtures: [{ ...first, id: 'changed' }] }), /modified or reordered/);
});

test('the maintained comparison query has an explicit row bound', () => {
  assert.equal(QUERY_LIMIT, 100);
  assert.match(QUERY_SQL, /\bLIMIT\s+100\s*$/i);
});

test('the generated fixture is distinct from the pinned baseline and reproduces its manifest', async () => {
  assertPinnedRuntime();
  const source = await readFile(join(root, 'data-source/source.sqlite'));
  assert.equal(source.length, BASELINE_BYTES);
  assert.equal(sha256(source), BASELINE_SHA256);
  const { manifest } = await loadManifest(join(root, 'fixtures/compare/manifest.json'));
  assert.ok(manifest.fixtures.length >= 1);
  for (const entry of manifest.fixtures) {
    assert.equal(entry.reproduction.query.limit, 100);
    assert.match(entry.reproduction.query.sql, /\bLIMIT\s+100\s*$/i);
    const candidate = await readFile(join(root, entry.candidate.path));
    assert.notDeepEqual(candidate, source);
    assert.equal(candidate.length, entry.candidate.bytes);
    assert.equal(sha256(candidate), entry.candidate.sha256);
    assert.deepEqual(entry.reproduction.query.expectedDifference, {
      baselineOnly: [121],
      candidateOnly: [97],
      changed: [{ invoiceId: 98, columns: [{ column: 'InvoiceDate', baseline: '2022-03-11 00:00:00', candidate: '2022-03-12 00:00:00' }] }],
      unchanged: [143, 195, 316, 327, 382],
    });
  }
  await verifyFixture({ root });
});

test('top-level fixture claims are checked against inspected data and the versioned contract', async () => {
  assertPinnedRuntime();
  const { manifest } = await loadManifest(join(root, 'fixtures/compare/manifest.json'));
  const entry = manifest.fixtures[0];
  const reproduction = await inspectCandidate(
    join(root, 'data-source/source.sqlite'),
    join(root, entry.candidate.path),
  );
  assert.doesNotThrow(() => assertFixtureMetadata(entry, reproduction));

  const mutations = [
    (changed) => { changed.environment = 'production'; },
    (changed) => { changed.generator.script = 'scripts/other-generator.mjs'; },
    (changed) => { changed.generator.derivationVersion += 1; },
    (changed) => { changed.rowCounts.Invoice += 1; },
    (changed) => { changed.changes[0].to = 2; },
    (changed) => { changed.rights.modificationNotice = 'NOTICE.md'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(entry);
    mutate(changed);
    assert.throws(() => assertFixtureMetadata(changed, reproduction));
  }
});

test('append-only verification detects malformed and missing manifest data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chinook-compare-manifest-'));
  try {
    const path = join(dir, 'manifest.json');
    await writeFile(path, '{"format":"datatug-compare-fixtures/v1","appendOnly":true,"fixtures":[]}\n');
    assert.equal((await loadManifest(path)).manifest.fixtures.length, 0);
    await writeFile(path, '{"fixtures":[]}\n');
    await assert.rejects(loadManifest(path), /datatug-compare-fixtures\/v1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
