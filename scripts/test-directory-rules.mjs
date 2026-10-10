import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { test } from 'node:test';
import { canonicalUrlProblem } from './lib/directory-rules.mjs';
import { checkManifest, licenceIds, reportOvdbManifest } from './lib/ovdb-manifest.mjs';
import { directoryOptInProblem } from './check-directory-opt-in.mjs';

test('database identities accept public root, nested, legacy, and trailing-slash URLs', () => {
  for (const identity of [
    'https://example.com/',
    'https://demodb.dev/chinook/',
    'https://northwind.demodb.dev/',
    'https://chinookdb.com/ovdb/dbs/chinook',
    'https://data.example.com/catalog/samples/northwind/',
  ]) {
    assert.equal(canonicalUrlProblem(identity), null, identity);
  }
});

test('the provider explicitly publishes both the legacy manifest and generated database descriptor', () => {
  assert.equal(directoryOptInProblem(readFileSync(new URL('../OVDB.md', import.meta.url), 'utf8')), null);
  for (const publish of ['[./ovdb.yaml]', '[./ovdb-database.json]', '[./ovdb.yaml, ./ovdb-database.json, ./other.yaml]', '[./ovdb.yaml, ./ovdb-*.json]']) {
    const markdown = `---\novdb: 1\npublish: ${publish}\n---\n`;
    assert.ok(directoryOptInProblem(markdown), `must reject ${publish}`);
  }
});

test('the offline checker validates the public database descriptor with its pinned JSON Schema', () => {
  const descriptor = readFileSync(new URL('../ovdb-database.json', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../schemas/ovdb-database-draft-1.schema.json', import.meta.url), 'utf8');
  const files = (json) => ({
    read(path) {
      if (path === 'ovdb-database.json') return json;
      if (path === 'schemas/ovdb-database-draft-1.schema.json') return schema;
      throw new Error(`unexpected test path ${path}`);
    },
  });
  assert.deepEqual(checkManifest('ovdb-database.json', files(descriptor)), []);
  const unknown = JSON.parse(descriptor);
  unknown.privateDsn = 'sqlite:///private.db';
  assert.match(checkManifest('ovdb-database.json', files(JSON.stringify(unknown))).join('\n'), /invalid ovdb-database\/draft-1 descriptor.*additional properties/i);
  assert.match(checkManifest('ovdb-database.json', files(descriptor.replace('https://demodb.dev/ovdb/v1', 'http://demodb.dev/ovdb/v1'))).join('\n'), /invalid ovdb-database\/draft-1 descriptor/);
});

test('database identities still reject unsafe hosts, paths, and URL components', () => {
  for (const [identity, message] of [
    ['http://demodb.dev/chinook/', /must be https/],
    ['https://user:secret@demodb.dev/chinook/', /credentials/],
    ['https://demodb.dev:443/chinook/', /must not name a port/],
    ['https://demodb.dev/chinook/?query=1', /must not contain a query/],
    ['https://demodb.dev/chinook/#recordset-Artist', /must not contain a fragment/],
    ['https://northwind.local/', /local, internal or reserved/],
    ['https://127.0.0.1/northwind/', /IP address/],
    ['https://demodb.dev//northwind/', /empty path segment/],
    ['https://demodb.dev/northwind%2Fhidden/', /percent escape/],
    ['https://DemoDB.dev/chinook/', /not written canonically/],
    ['https://demodb.dev/northwind\\hidden/', /backslash/],
  ]) {
    assert.match(canonicalUrlProblem(identity), message, identity);
  }
});

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/demo-db/chinook';
const acceptedCompounds = [
  'CC0-1.0 AND CC-BY-4.0',
  'CC-BY-4.0 AND CC0-1.0',
  'MIT AND Apache-2.0',
  'MIT AND ISC AND 0BSD',
  'MIT AND ISC AND 0BSD AND CC0-1.0',
  'AGPL-3.0-only AND BSD-2-Clause AND BSD-3-Clause AND GPL-2.0-only',
];
const over64 = 'AGPL-3.0-only AND GPL-2.0-only AND GPL-3.0-only AND LGPL-3.0-only';
const fiveTerms = 'MIT AND ISC AND 0BSD AND CC0-1.0 AND MPL-2.0';

function licenceFixture(value, { shared = false, field = 'data', encode = stringifyYaml } = {}) {
  const manifest = parseYaml(readFileSync(join(root, 'ovdb.yaml'), 'utf8'));
  if (shared) {
    manifest.model = { address: `modelspec://github.com/example/model/chinook?ref=${'a'.repeat(40)}` };
    manifest.meaning = {
      address: `meaning://github.com/example/graph?ref=${'b'.repeat(40)}`,
      file: 'model/chinook.meaning.yaml', graph: { id: 'chinook' },
    };
  }
  manifest.licences[field] = value;
  const text = encode(manifest);
  const files = {
    kind: () => 'file',
    read: (path) => path === 'ovdb.yaml' ? text
      : path === 'OVDB.md' ? '---\novdb: 1\npublish: [./ovdb.yaml]\n---\n'
        : readFileSync(join(root, path), 'utf8'),
  };
  return { manifest, files };
}

function licenceProblems(value, options) {
  const { files } = licenceFixture(value, options);
  const problems = checkManifest('ovdb.yaml', files, { repository });
  const report = reportOvdbManifest(files, { repository });
  assert.deepEqual(report.problems, problems, 'both public checking paths agree');
  assert.ok(report.notes.some((note) => note.includes('offline pre-check')));
  return problems;
}

test('data licence conjunctions are generic, bounded, and accepted in own/shared JSON/YAML manifests', () => {
  assert.deepEqual(licenceIds, [
    '0BSD', 'AGPL-3.0-only', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0',
    'GPL-2.0-only', 'GPL-3.0-only', 'ISC', 'LGPL-3.0-only', 'MIT', 'MPL-2.0', 'ODC-By-1.0', 'ODbL-1.0', 'PDDL-1.0', 'Unlicense',
  ]);
  assert.equal(Buffer.byteLength(acceptedCompounds.at(-1)), 64);
  assert.equal(Buffer.byteLength(over64), 65);
  assert.ok(Buffer.byteLength(fiveTerms) < 64);
  for (const shared of [false, true]) {
    for (const encode of [stringifyYaml, JSON.stringify]) {
      for (const value of [...licenceIds, ...acceptedCompounds]) {
        assert.deepEqual(licenceProblems(value, { shared, encode }), [], `${shared}: ${value}`);
      }
    }
  }
});

test('data conjunction grammar refuses unsupported expressions and decoded scalar types', () => {
  const invalid = [
    over64, fiveTerms, 'MIT AND MIT', 'MIT AND ISC AND MIT',
    ' MIT AND ISC', 'MIT AND ISC ', 'MIT  AND ISC', 'MIT AND  ISC',
    'MIT AND', 'AND MIT', ' AND MIT', 'MIT AND ', 'MIT AND  AND ISC',
    'mit AND ISC', 'MIT and ISC', 'MIT And ISC', 'MIT AND apache-2.0',
    'MIT\tAND ISC', 'MIT AND\tISC', 'MIT AND ISC\n', 'MIT AND ISC\r',
    'MIT\u00a0AND ISC', 'MIT AND\u2003ISC', 'MIT AND ISC\u0000',
    'MIT OR ISC', 'MIT WITH ISC', '(MIT AND ISC)', 'MIT AND (ISC)',
    'MIT AND ISC OR 0BSD', 'MIT AND ISC WITH 0BSD', 'MIT AND GPL-2.0+',
    'MIT AND LicenseRef-x', 'DocumentRef-x:MIT AND ISC', 'MIT AND Unknown-1.0',
    'MIT AND CC-BY-SA-3.0', 'MIT AND Unlicense-extra',
    ['MIT', 'ISC'], { licence: 'MIT AND ISC' }, 123, null,
  ];
  for (const shared of [false, true]) {
    for (const encode of [stringifyYaml, JSON.stringify]) {
      for (const value of invalid) {
        assert.match(licenceProblems(value, { shared, encode }).join('\n'), /licences\.data/, JSON.stringify(value));
      }
    }
  }
});

test('legacy publisher atoms and model/meaning retain their exact known-ID rules', () => {
  for (const value of ['Unknown-1.0', 'LicenseRef-x', 'GPL-2.0+', 'mit', 'CC-BY-SA-3.0']) {
    for (const field of ['data', 'model', 'meaning']) {
      assert.match(licenceProblems(value, { shared: true, field }).join('\n'), new RegExp(`licences\\.${field}`));
    }
  }
  for (const field of ['model', 'meaning']) {
    for (const value of licenceIds) assert.deepEqual(licenceProblems(value, { shared: true, field }), []);
    for (const shared of [false, true]) {
      for (const value of acceptedCompounds) {
        assert.match(licenceProblems(value, { shared, field }).join('\n'), new RegExp(`licences\\.${field} must be a known SPDX licence id`));
      }
    }
  }
});

test('the public descriptor generator preserves the full authored data expression', (t) => {
  // Run the actual generator against copied inputs, so the provider's real licences stay unchanged.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'chinook-licences-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const path of ['scripts/generate-public-manifest.mjs', 'scripts/lib/manifest-mapping.mjs', 'manifest.json',
    'metadata/schema.json', 'metadata/checksums.json', 'schemas/ovdb-database-draft-1.schema.json']) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
    copyFileSync(join(root, path), join(fixtureRoot, path));
  }
  symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir');
  for (const value of acceptedCompounds) {
    const { manifest } = licenceFixture(value);
    writeFileSync(join(fixtureRoot, 'ovdb.yaml'), stringifyYaml(manifest));
    execFileSync(process.execPath, [join(fixtureRoot, 'scripts/generate-public-manifest.mjs')], { stdio: 'pipe' });
    const descriptor = JSON.parse(readFileSync(join(fixtureRoot, 'ovdb-database.json'), 'utf8'));
    assert.deepEqual(descriptor.licences, manifest.licences);
    const files = { read: (path) => readFileSync(join(fixtureRoot, path), 'utf8') };
    assert.deepEqual(checkManifest('ovdb-database.json', files), []);
    // Verify the generated descriptor and checksum still agree with the unnormalized input.
    execFileSync(process.execPath, [join(fixtureRoot, 'scripts/generate-public-manifest.mjs'), '--check'], { stdio: 'pipe' });
  }
});

test('the public descriptor generator reads a manifest in the form with record_type and columns, and writes the same descriptor as the earlier form', (t) => {
  // The generator is run on copies of the inputs. The same recordsets are written in the earlier form (a list of
  // names and the map recordset_entities) and in ovdb-manifest/draft-2 (an item with name, record_type and
  // columns); the descriptor must be the same bytes, and modelEntity must hold the record type of Album and
  // appear for no other recordset.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'chinook-record-type-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const path of ['scripts/generate-public-manifest.mjs', 'manifest.json', 'metadata/schema.json', 'metadata/checksums.json', 'schemas/ovdb-database-draft-1.schema.json']) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
    copyFileSync(join(root, path), join(fixtureRoot, path));
  }
  // The generator may read the shared mapping module beside it.
  mkdirSync(join(fixtureRoot, 'scripts/lib'), { recursive: true });
  copyFileSync(join(root, 'scripts/lib/manifest-mapping.mjs'), join(fixtureRoot, 'scripts/lib/manifest-mapping.mjs'));
  symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir');
  const provider = parseYaml(readFileSync(join(root, 'ovdb.yaml'), 'utf8'));
  const generate = (manifest, ...args) => {
    writeFileSync(join(fixtureRoot, 'ovdb.yaml'), stringifyYaml(manifest));
    execFileSync(process.execPath, [join(fixtureRoot, 'scripts/generate-public-manifest.mjs'), ...args], { stdio: 'pipe' });
    return readFileSync(join(fixtureRoot, 'ovdb-database.json'), 'utf8');
  };
  assert.ok(provider.recordsets.includes('Album'));

  const earlier = generate({ ...provider, recordset_entities: { Album: 'Disc' } });
  const current = generate({
    ...provider,
    format: 'ovdb-manifest/draft-2',
    recordsets: provider.recordsets.map((name) => (name === 'Album' ? { name, record_type: 'Disc', columns: { Title: { field: 'Title' } } } : name)),
  });
  // In the current form every recordset states its record type (the item's record_type, else its own name), so
  // modelEntity is written for each; apart from that the descriptors are the same.
  const withoutModelEntity = (text) => {
    const descriptor = JSON.parse(text);
    for (const recordset of descriptor.recordsets) delete recordset.modelEntity;
    return descriptor;
  };
  assert.deepEqual(withoutModelEntity(current), withoutModelEntity(earlier));
  const descriptor = JSON.parse(current);
  assert.deepEqual(descriptor.recordsets.map((recordset) => recordset.name), provider.recordsets);
  assert.deepEqual(descriptor.recordsets.map((recordset) => recordset.modelEntity), provider.recordsets.map((name) => (name === 'Album' ? 'Disc' : name)));
  // The earlier form still writes modelEntity for the pair alone.
  assert.deepEqual(JSON.parse(earlier).recordsets.filter((recordset) => recordset.modelEntity !== undefined).map((recordset) => [recordset.name, recordset.modelEntity]), [['Album', 'Disc']]);
  // The descriptor and the checksums that the run wrote agree with the manifest in the current form.
  execFileSync(process.execPath, [join(fixtureRoot, 'scripts/generate-public-manifest.mjs'), '--check'], { stdio: 'pipe' });
  // The columns of a recordset are not part of the descriptor.
  assert.equal(generate({ ...provider, format: 'ovdb-manifest/draft-2', recordsets: provider.recordsets.map((name) => (name === 'Album' ? { name, record_type: 'Disc' } : { name })) }), current);
});

test('the public descriptor generator refuses a manifest it cannot read in one form, instead of half reading it', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'chinook-refused-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  for (const path of ['scripts/generate-public-manifest.mjs', 'scripts/lib/manifest-mapping.mjs', 'manifest.json', 'metadata/schema.json', 'metadata/checksums.json', 'schemas/ovdb-database-draft-1.schema.json']) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
    copyFileSync(join(root, path), join(fixtureRoot, path));
  }
  symlinkSync(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir');
  const provider = parseYaml(readFileSync(join(root, 'ovdb.yaml'), 'utf8'));
  const refusal = (manifest) => {
    writeFileSync(join(fixtureRoot, 'ovdb.yaml'), stringifyYaml(manifest));
    try {
      execFileSync(process.execPath, [join(fixtureRoot, 'scripts/generate-public-manifest.mjs')], { stdio: 'pipe' });
    } catch (error) { return String(error.stderr); }
    assert.fail('the generator must refuse this manifest');
  };
  const item = { name: 'Album', record_type: 'Disc' };
  assert.match(refusal({ ...provider, format: 'ovdb-manifest/draft-3' }), /format must be ovdb-manifest\/draft-1 or ovdb-manifest\/draft-2/);
  assert.match(refusal({ ...provider, recordsets: [item, ...provider.recordsets.slice(1)] }), /is a map, but ovdb-manifest\/draft-1 lists recordsets by name only/);
  assert.match(refusal({ ...provider, format: 'ovdb-manifest/draft-2', recordsets: [item, ...provider.recordsets.slice(1)], recordset_entities: { Album: 'Disc' } }), /recordset_entities and record_type both state the mapping/);
});
