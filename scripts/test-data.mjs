import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { buildChecksums, checksumsPath, listDataFiles, serializeChecksums, sha256Hex, verifyChecksums } from './lib/checksums.mjs';
import { evaluateDrift } from './lib/drift.mjs';

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
