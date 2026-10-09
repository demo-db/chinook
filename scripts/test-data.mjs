import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { buildChecksums, checksumsPath, listDataFiles, serializeChecksums, sha256Hex, verifyChecksums } from './lib/checksums.mjs';
import { evaluateDrift } from './lib/drift.mjs';
import { vocabularyOf } from './lib/modelspec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const published = join(root, 'artifacts', 'data');

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'chinookdb-checksums-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test('the hero demo file chinook.Invoice.json is pinned to the hash the demo project records', async () => {
  const bytes = await readFile(join(published, 'json', 'chinook.Invoice.json'));
  assert.equal(sha256Hex(bytes), '88eb7faede360988e9c0f8f8d107e5093db5e712141de14d868f8947b43c373c');
  assert.equal(bytes.length, 115781);
  assert.equal(JSON.parse(bytes).length, 412);
  const checksums = JSON.parse(await readFile(join(published, checksumsPath), 'utf8'));
  assert.deepEqual(checksums.files['json/chinook.Invoice.json'], { sha256: '88eb7faede360988e9c0f8f8d107e5093db5e712141de14d868f8947b43c373c', bytes: 115781 });
});

test('invoices stay distinct from orders and both line types share the declared commercial ancestor', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const meaning = parseYaml(await readFile(join(root, 'model', 'chinook.meaning.yaml'), 'utf8'));
  const concepts = Object.fromEntries(meaning.concepts.map((concept) => [concept.id, concept]));
  assert.deepEqual(manifest.semantics.tableConcepts.Invoice, ['invoice']);
  assert.deepEqual(manifest.semantics.tableConcepts.InvoiceLine, ['invoice-line', 'commercial-line-item']);
  assert.equal(manifest.tableDescriptions.Invoice, 'Billing invoices issued to customers for music purchases.');
  assert.equal(concepts.invoice.extends, 'meaning://github.com/meaninggraph/core/invoice?ref=982916d73f0a35ff2558b0062f58aa3ac4f24d97');
  assert.equal(concepts.invoice.synonyms.en.includes('order'), false);
  assert.equal(concepts['invoice-line'].extends, 'meaning://github.com/meaninggraph/core/invoice-line?ref=982916d73f0a35ff2558b0062f58aa3ac4f24d97');
});

test('the published checksums file matches every published data file', async () => {
  const checksums = JSON.parse(await readFile(join(published, checksumsPath), 'utf8'));
  assert.deepEqual(await verifyChecksums(published, checksums), []);
  assert.equal(checksums.source.sqliteSha256, checksums.files['chinook.sqlite'].sha256);
});

test('buildChecksums lists every file except the checksums file, sorted by path, with SHA-256 and size', async () => {
  const dir = await fixture({ 'b.txt': 'bb', 'a/z.txt': 'z', 'a/B.txt': 'upper', [checksumsPath]: 'ignored' });
  try {
    assert.deepEqual(await listDataFiles(dir), ['a/B.txt', 'a/z.txt', 'b.txt']);
    const checksums = await buildChecksums(dir, { revision: 'r' });
    assert.deepEqual(Object.keys(checksums.files), ['a/B.txt', 'a/z.txt', 'b.txt']);
    assert.deepEqual(checksums.files['b.txt'], { sha256: sha256Hex(Buffer.from('bb')), bytes: 2 });
    assert.deepEqual(checksums.source, { revision: 'r' });
    assert.equal(serializeChecksums(checksums), serializeChecksums(await buildChecksums(dir, { revision: 'r' })), 'output is deterministic');
    assert.ok(serializeChecksums(checksums).endsWith('}\n'));
  } finally { await rm(dir, { recursive: true }); }
});

test('verifyChecksums reports changed, resized, missing and unlisted files', async () => {
  const dir = await fixture({ 'a.txt': 'one', 'b.txt': 'two' });
  try {
    const checksums = await buildChecksums(dir, {});
    assert.deepEqual(await verifyChecksums(dir, checksums), []);
    await writeFile(join(dir, 'a.txt'), 'ONE');
    await writeFile(join(dir, 'b.txt'), 'longer');
    await writeFile(join(dir, 'c.txt'), 'new');
    const problems = await verifyChecksums(dir, checksums);
    assert.ok(problems.includes('a.txt SHA-256 differs from metadata/checksums.json'));
    assert.ok(problems.includes('b.txt is 6 bytes, metadata/checksums.json says 3'));
    assert.ok(problems.includes('c.txt is published but not listed in metadata/checksums.json'));
    await rm(join(dir, 'a.txt'));
    assert.ok((await verifyChecksums(dir, checksums)).includes('a.txt is listed in metadata/checksums.json but missing'));
    assert.ok((await verifyChecksums(dir, { files: { 'b.txt': checksums.files['b.txt'], 'a.txt': checksums.files['a.txt'] } })).includes('metadata/checksums.json is not sorted by path'));
  } finally { await rm(dir, { recursive: true }); }
});

test('the drift guard allows changes that leave published data alone', () => {
  assert.deepEqual(evaluateDrift([]), []);
  assert.deepEqual(evaluateDrift(['src/pages/index.astro', 'README.md', '.github/workflows/ci.yml']), []);
  assert.deepEqual(evaluateDrift(['artifacts/data/metadata/checksums.json']), []);
});

test('the drift guard fails when data changes without checksums and a data-source change', () => {
  const data = 'artifacts/data/json/chinook.Invoice.json';
  assert.equal(evaluateDrift([data]).length, 3);
  assert.match(evaluateDrift([data])[0], /checksums\.json did not/);
  assert.match(evaluateDrift([data, 'artifacts/data/metadata/checksums.json'])[0], /nothing under data-source\//);
  assert.equal(evaluateDrift([data, 'artifacts/data/metadata/checksums.json']).length, 2);
  assert.match(evaluateDrift([data, 'data-source/README.md'])[0], /checksums\.json did not/);
  assert.deepEqual(evaluateDrift([data, 'artifacts/data/metadata/checksums.json', 'data-source/README.md']), []);
});

test('the drift guard names at most five changed files', () => {
  const many = Array.from({ length: 8 }, (_, i) => `artifacts/data/csv/f${i}.csv`);
  assert.match(evaluateDrift(many).at(-1), /and 3 more/);
});

// Every table of this database has a primary key, so the record type that describes it must
// declare that key. ModelSpec itself allows a record type without a key, so only this check
// notices when one loses it. `model` is the ModelSpec JSON in either vocabulary; `schema` is
// metadata/schema.json. Returns problems.
function keyProblems(model, schema) {
  const words = vocabularyOf(model);
  if (!words) return [`modelspec "${model?.modelspec}" is neither of the known identifiers`];
  const problems = [];
  const recordTypes = model[words.records] ?? {};
  for (const table of schema.tables) {
    const primaryKey = table.columns.filter((column) => column.primaryKey).sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition).map((column) => column.name);
    if (primaryKey.length === 0) problems.push(`${table.name}: the table has no primary key`);
    const recordType = recordTypes[table.name];
    if (!recordType) { problems.push(`${table.name}: the table has no ${words.record} type in the model`); continue; }
    if (!Array.isArray(recordType.key) || recordType.key.length === 0) problems.push(`${table.name}: the ${words.record} type declares no key`);
    else if (JSON.stringify(recordType.key) !== JSON.stringify(primaryKey)) problems.push(`${table.name}: key [${recordType.key.join(', ')}] differs from the primary key [${primaryKey.join(', ')}]`);
  }
  for (const name of Object.keys(recordTypes)) if (!schema.tables.some((table) => table.name === name)) problems.push(`${name}: the model has a ${words.record} type that describes no table`);
  return problems;
}

test('every record type of the model declares the primary key of its table', async () => {
  const model = JSON.parse(await readFile(join(root, 'model', 'chinook.modelspec.json'), 'utf8'));
  const schema = JSON.parse(await readFile(join(root, 'metadata', 'schema.json'), 'utf8'));
  assert.equal(schema.tables.length, 11);
  assert.deepEqual(keyProblems(model, schema), []);
  assert.deepEqual(model.records.PlaylistTrack.key, ['PlaylistId', 'TrackId']);

  // The check is not vacuous: each way a key can be lost, changed or forgotten is named.
  const without = structuredClone(model);
  delete without.records.Genre.key;
  assert.deepEqual(keyProblems(without, schema), ['Genre: the record type declares no key']);
  const empty = structuredClone(model);
  empty.records.Genre.key = [];
  assert.deepEqual(keyProblems(empty, schema), ['Genre: the record type declares no key']);
  const wrong = structuredClone(model);
  wrong.records.PlaylistTrack.key = ['TrackId', 'PlaylistId'];
  assert.deepEqual(keyProblems(wrong, schema), ['PlaylistTrack: key [TrackId, PlaylistId] differs from the primary key [PlaylistId, TrackId]']);
  const missing = structuredClone(model);
  delete missing.records.Genre;
  assert.deepEqual(keyProblems(missing, schema), ['Genre: the table has no record type in the model']);
  const extra = structuredClone(model);
  extra.records.Shipment = { fields: {} };
  assert.deepEqual(keyProblems(extra, schema), ['Shipment: the model has a record type that describes no table']);
  // The earlier spelling is read as well, in its own words.
  const earlier = { modelspec: '1.0-draft', module: model.module, entities: structuredClone(model.records) };
  delete earlier.entities.Genre.key;
  assert.deepEqual(keyProblems(earlier, schema), ['Genre: the entity type declares no key']);
  assert.deepEqual(keyProblems({ modelspec: '1.0-draft-3' }, schema), ['modelspec "1.0-draft-3" is neither of the known identifiers']);
});
