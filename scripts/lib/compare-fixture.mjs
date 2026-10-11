import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const NODE_VERSION = '24.20.0';
export const SQLITE_VERSION = '3.53.4';
export const FIXTURE_ENVIRONMENT = 'synthetic fixture environment';
export const GENERATOR_SCRIPT = 'scripts/generate-compare-fixture.mjs';
export const DERIVATION_VERSION = 1;
export const FIXTURE_RIGHTS = {
  upstreamLicense: 'MIT',
  upstreamLicensePath: 'data-source/LICENSE.md',
  modificationNotice: 'fixtures/compare/NOTICE.md',
};
export const EXPECTED_CHANGES = [
  { table: 'Invoice', key: { InvoiceId: 97 }, column: 'CustomerId', from: 59, to: 1 },
  { table: 'Invoice', key: { InvoiceId: 98 }, column: 'InvoiceDate', from: '2022-03-11 00:00:00', to: '2022-03-12 00:00:00' },
  { table: 'Invoice', key: { InvoiceId: 121 }, column: 'CustomerId', from: 1, to: 2 },
];
export const BASELINE_SHA256 = '7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15';
export const BASELINE_BYTES = 1_007_616;
export const MANIFEST_PATH = 'fixtures/compare/manifest.json';
export const SOURCE_PATH = 'data-source/source.sqlite';
export const QUERY_ID = 'invoice-customer-invoices-v1';
export const QUERY_LIMIT = 100;
export const QUERY_SQL = `SELECT i.InvoiceId, i.InvoiceDate, c.CustomerId, c.FirstName, c.LastName
FROM Invoice AS i
JOIN Customer AS c ON c.CustomerId = i.CustomerId
WHERE c.CustomerId = ?
ORDER BY i.InvoiceId
LIMIT ${QUERY_LIMIT}`;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertPinnedRuntime(runtime = process.versions) {
  assert.equal(runtime.node, NODE_VERSION, `fixture generation requires Node ${NODE_VERSION}`);
  assert.equal(runtime.sqlite, SQLITE_VERSION, `fixture generation requires SQLite ${SQLITE_VERSION}`);
}

export function stableJSON(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function schemaSnapshot(db) {
  const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return {
    objects,
    tables: tables.map(({ name }) => ({
      name,
      columns: db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all(),
      indexes: db.prepare(`PRAGMA index_list(${quoteIdentifier(name)})`).all().map((index) => ({
        ...index,
        columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all(),
      })),
      rowCount: db.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(name)}`).get().count,
    })),
  };
}

function schemaFingerprint(snapshot) {
  return sha256(Buffer.from(stableJSON(snapshot)));
}

function keyColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function rowSet(db, table) {
  const keys = keyColumns(db, table);
  assert.ok(keys.length > 0, `${table} must retain a primary key`);
  const order = keys.map(quoteIdentifier).join(', ');
  return db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order}`).all();
}

function jsonRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? value.toString() : Buffer.isBuffer(value) ? { base64: value.toString('base64') } : value,
  ]));
}

function rowKey(row, keys) {
  return JSON.stringify(keys.map((key) => row[key]));
}

function inspectControlledChanges(baseline, candidate) {
  const changes = [];
  for (const { name } of baseline.tables) {
    const beforeRows = rowSet(baseline.db, name);
    const afterRows = rowSet(candidate.db, name);
    assert.equal(afterRows.length, beforeRows.length, `${name}: row count changed`);
    const keys = keyColumns(baseline.db, name);
    const after = new Map(afterRows.map((row) => [rowKey(row, keys), row]));
    for (const beforeRow of beforeRows) {
      const key = rowKey(beforeRow, keys);
      const afterRow = after.get(key);
      assert.ok(afterRow, `${name}: primary key disappeared: ${key}`);
      const fields = Object.keys(beforeRow).filter((field) => beforeRow[field] !== afterRow[field]);
      if (fields.length) {
        for (const column of fields) {
          changes.push({
            table: name,
            key: Object.fromEntries(keys.map((field) => [field, beforeRow[field]])),
            column,
            from: beforeRow[column],
            to: afterRow[column],
          });
        }
      }
    }
  }
  assert.deepEqual(changes, EXPECTED_CHANGES, 'candidate changes differ from the versioned synthetic fixture contract');
  return changes;
}

export function assertFixtureMetadata(entry, reproduction) {
  assert.equal(entry.environment, FIXTURE_ENVIRONMENT, 'fixture environment metadata changed');
  assert.deepEqual(entry.generator, {
    script: GENERATOR_SCRIPT,
    node: NODE_VERSION,
    sqlite: SQLITE_VERSION,
    derivationVersion: DERIVATION_VERSION,
  }, 'fixture generator metadata differs from the versioned contract');
  assert.deepEqual(entry.rowCounts, reproduction.rowCounts, 'top-level row counts differ from inspected database');
  assert.deepEqual(entry.changes, reproduction.changes, 'top-level changes differ from inspected database');
  assert.deepEqual(entry.rights, FIXTURE_RIGHTS, 'fixture rights metadata differs from the versioned contract');
}

function queryRows(db) {
  return db.prepare(QUERY_SQL).all(1).map(jsonRow);
}

function expectedQueryCase(baselineRows, candidateRows) {
  const baselineById = new Map(baselineRows.map((row) => [row.InvoiceId, row]));
  const candidateById = new Map(candidateRows.map((row) => [row.InvoiceId, row]));
  const baselineOnly = [...baselineById.keys()].filter((id) => !candidateById.has(id)).sort((a, b) => a - b);
  const candidateOnly = [...candidateById.keys()].filter((id) => !baselineById.has(id)).sort((a, b) => a - b);
  const changed = [];
  const unchanged = [];
  for (const id of [...baselineById.keys()].filter((value) => candidateById.has(value)).sort((a, b) => a - b)) {
    const before = baselineById.get(id);
    const after = candidateById.get(id);
    const fields = Object.keys(before).filter((field) => before[field] !== after[field]);
    if (fields.length) {
      changed.push({ invoiceId: id, columns: fields.map((column) => ({ column, baseline: before[column], candidate: after[column] })) });
    } else unchanged.push(id);
  }
  return { baselineOnly, candidateOnly, changed, unchanged };
}

function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export async function deriveCandidate(sourcePath, temporaryPath) {
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sourceBytes.length, BASELINE_BYTES, 'baseline byte length changed');
  assert.equal(sha256(sourceBytes), BASELINE_SHA256, 'baseline input hash changed');
  await copyFile(sourcePath, temporaryPath);
  const db = new DatabaseSync(temporaryPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'candidate foreign-key enforcement is disabled');
    db.exec('BEGIN IMMEDIATE');
    const date = db.prepare('UPDATE Invoice SET InvoiceDate = ? WHERE InvoiceId = ? AND InvoiceDate = ?').run('2022-03-12 00:00:00', 98, '2022-03-11 00:00:00');
    const out = db.prepare('UPDATE Invoice SET CustomerId = ? WHERE InvoiceId = ? AND CustomerId = ?').run(2, 121, 1);
    const into = db.prepare('UPDATE Invoice SET CustomerId = ? WHERE InvoiceId = ? AND CustomerId = ?').run(1, 97, 59);
    assert.equal(date.changes, 1, 'expected Invoice 98 date was not present');
    assert.equal(out.changes, 1, 'expected Invoice 121 customer was not present');
    assert.equal(into.changes, 1, 'expected Invoice 97 customer was not present');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    db.close();
  }
}

export async function inspectCandidate(sourcePath, candidatePath) {
  assert.match(QUERY_SQL, new RegExp(`\\bLIMIT\\s+${QUERY_LIMIT}\\s*$`, 'i'), 'comparison query must retain its explicit row bound');
  const baseline = openReadOnly(sourcePath);
  const candidate = openReadOnly(candidatePath);
  try {
    const before = { db: baseline, ...schemaSnapshot(baseline) };
    const after = { db: candidate, ...schemaSnapshot(candidate) };
    assert.deepEqual(after.objects, before.objects, 'SQLite schema objects changed');
    assert.deepEqual(after.tables, before.tables, 'table schema, primary keys, foreign keys, indexes, or row counts changed');
    assert.equal(baseline.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'baseline integrity check failed');
    assert.equal(candidate.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'candidate integrity check failed');
    assert.deepEqual(candidate.prepare('PRAGMA foreign_key_check').all(), [], 'candidate foreign-key check failed');
    const changes = inspectControlledChanges(before, after);

    const baselineRows = queryRows(baseline);
    const candidateRows = queryRows(candidate);
    const expected = expectedQueryCase(baselineRows, candidateRows);
    assert.deepEqual(baselineRows.map((row) => row.InvoiceId), [98, 121, 143, 195, 316, 327, 382]);
    assert.deepEqual(candidateRows.map((row) => row.InvoiceId), [97, 98, 143, 195, 316, 327, 382]);
    assert.deepEqual(expected, {
      baselineOnly: [121],
      candidateOnly: [97],
      changed: [{ invoiceId: 98, columns: [{ column: 'InvoiceDate', baseline: '2022-03-11 00:00:00', candidate: '2022-03-12 00:00:00' }] }],
      unchanged: [143, 195, 316, 327, 382],
    });
    return {
      schemaSha256: schemaFingerprint(before),
      rowCounts: Object.fromEntries(before.tables.map(({ name, rowCount }) => [name, rowCount])),
      changes,
      query: {
        id: QUERY_ID,
        sql: QUERY_SQL,
        limit: QUERY_LIMIT,
        parameter: { CustomerId: 1 },
        baseline: { rowCount: baselineRows.length, invoiceIds: baselineRows.map((row) => row.InvoiceId) },
        candidate: { rowCount: candidateRows.length, invoiceIds: candidateRows.map((row) => row.InvoiceId) },
        expectedDifference: expected,
      },
    };
  } finally {
    baseline.close();
    candidate.close();
  }
}

function manifestObject(fixtures) {
  return { format: 'datatug-compare-fixtures/v1', appendOnly: true, fixtures };
}

export async function loadManifest(path) {
  try {
    const bytes = await readFile(path);
    const manifest = JSON.parse(bytes.toString('utf8'));
    assert.equal(manifest.format, 'datatug-compare-fixtures/v1');
    assert.equal(manifest.appendOnly, true);
    assert.ok(Array.isArray(manifest.fixtures));
    return { bytes, manifest };
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: null, manifest: manifestObject([]) };
    throw error;
  }
}

export function assertAppendOnly(baseManifest, currentManifest) {
  assert.equal(currentManifest.format, 'datatug-compare-fixtures/v1');
  assert.equal(currentManifest.appendOnly, true);
  assert.ok(Array.isArray(baseManifest.fixtures) && Array.isArray(currentManifest.fixtures));
  assert.ok(currentManifest.fixtures.length >= baseManifest.fixtures.length, 'comparison-fixture manifest deleted historical entries');
  assert.deepEqual(currentManifest.fixtures.slice(0, baseManifest.fixtures.length), baseManifest.fixtures, 'comparison-fixture manifest modified or reordered historical entries');
}

async function readBaseManifest(baseRef, root) {
  if (!baseRef) return manifestObject([]);
  const result = spawnSync('git', ['show', `${baseRef}:${MANIFEST_PATH}`], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.format, 'datatug-compare-fixtures/v1');
    assert.equal(parsed.appendOnly, true);
    assert.ok(Array.isArray(parsed.fixtures));
    return parsed;
  }
  const missingPath = result.stderr.includes('does not exist in') || result.stderr.includes('exists on disk, but not in') || result.stderr.includes('Path ') && result.stderr.includes('does not exist in');
  if (missingPath) return manifestObject([]);
  throw new Error(`could not read comparison manifest from git ref ${baseRef}: ${result.stderr || result.stdout}`);
}

export async function verifyFixture({ root, baseRef = null }) {
  assertPinnedRuntime();
  const sourcePath = resolve(root, SOURCE_PATH);
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sourceBytes.length, BASELINE_BYTES, 'baseline byte length changed');
  assert.equal(sha256(sourceBytes), BASELINE_SHA256, 'baseline input hash changed');
  const compareDir = resolve(root, 'fixtures/compare');
  const { manifest } = await loadManifest(join(compareDir, 'manifest.json'));
  assert.ok(manifest.fixtures.length > 0, 'no comparison fixture is recorded');
  assertAppendOnly(await readBaseManifest(baseRef, root), manifest);

  const ids = new Set();
  const paths = new Set();
  for (const entry of manifest.fixtures) {
    assert.ok(entry.id && !ids.has(entry.id), `duplicate fixture id: ${entry.id}`);
    assert.ok(entry.candidate.path && !paths.has(entry.candidate.path), `duplicate candidate path: ${entry.candidate.path}`);
    ids.add(entry.id);
    paths.add(entry.candidate.path);
    assert.equal(entry.baseline.path, SOURCE_PATH);
    assert.equal(entry.baseline.bytes, BASELINE_BYTES);
    assert.equal(entry.baseline.sha256, BASELINE_SHA256);
    assert.equal(entry.generator.node, NODE_VERSION);
    assert.equal(entry.generator.sqlite, SQLITE_VERSION);
    const candidatePath = resolve(root, entry.candidate.path);
    assert.equal(dirname(candidatePath), compareDir, 'candidate must be stored directly under fixtures/compare');
    const candidateBytes = await readFile(candidatePath);
    assert.equal(candidateBytes.length, entry.candidate.bytes, `${entry.id}: candidate byte length mismatch`);
    assert.equal(sha256(candidateBytes), entry.candidate.sha256, `${entry.id}: candidate hash mismatch`);
    assert.equal(basename(candidatePath), `chinook-candidate-${entry.candidate.sha256}.sqlite`, `${entry.id}: candidate name is not content-addressed`);
    assert.equal(entry.schemaSha256, entry.reproduction.schemaSha256, `${entry.id}: schema fingerprint mismatch`);

    const tempDir = await mkdtemp(join(tmpdir(), 'chinook-compare-repro-'));
    const generatedPath = join(tempDir, basename(candidatePath));
    try {
      await deriveCandidate(sourcePath, generatedPath);
      const generated = await readFile(generatedPath);
      assert.equal(generated.length, entry.candidate.bytes, `${entry.id}: regenerated candidate size differs`);
      assert.equal(sha256(generated), entry.candidate.sha256, `${entry.id}: regenerated candidate hash differs`);
      assert.deepEqual(generated, candidateBytes, `${entry.id}: regenerated candidate bytes differ`);
      const reproduction = await inspectCandidate(sourcePath, generatedPath);
      assert.deepEqual(reproduction, entry.reproduction, `${entry.id}: regenerated schema/query results differ from manifest`);
      assertFixtureMetadata(entry, reproduction);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function writeFixture({ root }) {
  assertPinnedRuntime();
  const sourcePath = resolve(root, SOURCE_PATH);
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sourceBytes.length, BASELINE_BYTES, 'baseline byte length changed');
  assert.equal(sha256(sourceBytes), BASELINE_SHA256, 'baseline input hash changed');
  const compareDir = resolve(root, 'fixtures/compare');
  const tempDir = await mkdtemp(join(tmpdir(), 'chinook-compare-create-'));
  const tempPath = join(tempDir, 'candidate.sqlite');
  try {
    await deriveCandidate(sourcePath, tempPath);
    const bytes = await readFile(tempPath);
    const candidateSha256 = sha256(bytes);
    const candidateName = `chinook-candidate-${candidateSha256}.sqlite`;
    const candidatePath = join(compareDir, candidateName);
    const reproduction = await inspectCandidate(sourcePath, tempPath);
    const candidateStat = await stat(tempPath);
    assert.equal(candidateStat.size, bytes.length);
    const entry = {
      id: `chinook-synthetic-${candidateSha256}`,
      createdOn: '2026-10-11',
      environment: FIXTURE_ENVIRONMENT,
      baseline: { path: SOURCE_PATH, sha256: BASELINE_SHA256, bytes: BASELINE_BYTES },
      candidate: { path: `fixtures/compare/${candidateName}`, sha256: candidateSha256, bytes: bytes.length },
      generator: { script: GENERATOR_SCRIPT, node: NODE_VERSION, sqlite: SQLITE_VERSION, derivationVersion: DERIVATION_VERSION },
      schemaSha256: reproduction.schemaSha256,
      rowCounts: reproduction.rowCounts,
      changes: reproduction.changes,
      reproduction,
      rights: FIXTURE_RIGHTS,
    };
    const { manifest } = await loadManifest(join(compareDir, 'manifest.json'));
    const previous = manifest.fixtures.find((item) => item.id === entry.id);
    if (previous) {
      assert.deepEqual(previous, entry, 'existing fixture manifest entry is immutable');
      const existingBytes = await readFile(candidatePath);
      assert.deepEqual(existingBytes, bytes, 'existing content-addressed candidate is immutable');
      return entry;
    }
    await mkdir(compareDir, { recursive: true });
    try {
      const existingBytes = await readFile(candidatePath);
      assert.deepEqual(existingBytes, bytes, 'candidate path already exists with different bytes');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(candidatePath, bytes, { flag: 'wx' });
    }
    manifest.fixtures.push(entry);
    await writeFile(join(compareDir, 'manifest.json'), stableJSON(manifest), { flag: manifest.fixtures.length === 1 ? 'wx' : 'w' });
    return entry;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
