import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { precheckRepresentation } from './lib/representation-precheck.mjs';
import { parseStrictJson } from './lib/strict-json.mjs';
import { gitRepoFiles, reportOvdbManifest } from './lib/ovdb-manifest.mjs';
import { fileURLToPath } from 'node:url';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40);
const sourceRepo = 'https://github.com/example/source';
const providerRepo = 'https://github.com/example/provider';
const ref = (path, bytes) => ({ path, sha256: sha(bytes) });
const external = (path) => ({ path, sha256: 'b'.repeat(64), repository: sourceRepo, revision });
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

export function fixture(format = 3, prefix = '') {
  const files = new Map();
  const put = (path, value) => { const data = bytes(value); const full = `${prefix}${path}`; files.set(full, data); return ref(full, data); };
  const targetModel = put('model/target.modelspec.json', {
    modelspec: '1.0-draft', module: { name: 'target' }, entities: {
      Entities: { key: ['id'], properties: { id: { type: 'string', required: true }, serving_id: { type: 'string' } } },
      Bridge: { properties: { raw_label: { type: 'string' }, target_key: { type: 'string' } } },
    },
  });
  const binding = put('model/target.meaning.yaml', `format: meaning/draft-1\nconcepts:\n  - id: target-entity\n    extends: meaning://github.com/example/meaning/concept?ref=${revision}\n    bindings:\n      - model: modelspec:///target.Entities\n        property: id\n        role: identifier\n`);
  const dataset = { path: `${prefix}native.sqlite`, sha256: 'c'.repeat(64) };
  const provenance = put('source/provenance.json', {
    native_key: { module: 'target', entity: 'Entities', property: 'id', namespace: 'TEST:ID', model: targetModel, binding, dataset, records: 2, duplicates: 0 },
    snapshot: { outputs: { [dataset.path]: { sha256: dataset.sha256 } }, counts: { Entities: 2 } },
  });
  const bridge = put('source/bridge.json', { table: 'Bridge', rows: [{ raw_label: 'x', target_key: 'id:1' }] });
  const keys = put('source/keys.json', { namespace: 'TEST:ID', keys: ['id:1'] });
  const snapshot = put('source/snapshot.json', {
    generator: { repository: providerRepo, revision },
    artifacts: [targetModel, binding, dataset, provenance, bridge, keys],
  });
  const source = { schema: external('source/schema.json'), module: 'source', entity: 'Rows', property: 'id', datatype: 'string', namespace: 'TEST:ID' };
  if (format === 3) source.data = external('source/input.json');
  const target = {
    snapshot, model: targetModel, module: 'target', entity: 'Entities', property: 'id', datatype: 'string', namespace: 'TEST:ID',
    binding: { document: binding, concept: 'target-entity', role: 'identifier', meaning: { document: { ...external('meaning/core.yaml'), repository: 'https://github.com/example/meaning' }, concept: 'concept' } },
  };
  const contract = {
    source, target, policy: { transform: 'identity', equality: 'utf8-byte-exact', cardinality: 'zero-or-one', unmatched: 'exception', collision: 'ineligible' },
    decision: { document: external(format === 1 ? 'decision.json' : '$records/decision.json'), scope: 'synthetic-fixture' },
  };
  if (format === 1) { target.keys = keys; contract.bridge = { artifact: bridge, table: 'Bridge', raw_label_column: 'raw_label', target_key_column: 'target_key' }; }
  if (format === 2) { target.keys = keys; contract.execution = 'label-bridge'; contract.bridge = { artifact: bridge, table: 'Bridge', raw_label_column: 'raw_label', target_key_column: 'target_key' }; }
  if (format === 3) { contract.execution = 'native-identifier'; contract.native = { dataset, provenance, serving_identity_column: 'serving_id' }; }
  const doc = { format: `ovdb-representation-contract/${format}`, contracts: [contract] };
  const attachment = put('source/contract.json', doc);
  const manifest = { model: { modelspec: targetModel.path }, meaning: { file: binding.path }, recordsets: ['Entities', 'Bridge'] };
  const touched = [];
  const reader = {
    kind(path) { return files.has(path) ? 'file' : 'missing'; },
    readBytes(path, limit) { touched.push(path); const data = files.get(path); if (data.length > limit) throw new Error('oversize'); return data; },
  };
  return { files, put, doc, attachment, manifest, reader, touched, contract };
}

function check(f) { return precheckRepresentation(f.attachment, f.reader, f.manifest, providerRepo); }
function repack(f) { f.attachment = f.put('source/contract.json', f.doc); }

// Complete own-model publisher fixture: regressions must reach the public report API.
function manifestFixture(format = 3) {
  const f = fixture(format);
  const binding = f.contract.target.binding.document;
  replaceMetadata(f, binding, f.files.get(binding.path).toString() + 'id: test-graph\nlicense: CC0-1.0\nmodels:\n  target: target.modelspec.hcl\n');
  if (f.contract.native) {
    const provenance = JSON.parse(f.files.get(f.contract.native.provenance.path));
    provenance.native_key.binding = binding;
    replaceMetadata(f, f.contract.native.provenance, provenance);
  }
  f.put('model/target.modelspec.hcl', 'module "target" {}');
  f.manifest = parseYaml(readFileSync(new URL('../ovdb.yaml', import.meta.url), 'utf8'));
  f.manifest.model = { modelspec: f.contract.target.model.path, hcl: 'model/target.modelspec.hcl', address: 'modelspec://github.com/example/provider/target' };
  f.manifest.meaning = { file: binding.path, graph: { id: 'test-graph', address: 'meaning://github.com/example/provider' } };
  f.manifest.publisher = { name: 'Example', url: 'https://github.com/example', repository: providerRepo };
  f.manifest.recordsets = ['Entities', 'Bridge'];
  f.reader.read = (path) => f.files.get(path).toString('utf8');
  return f;
}

function replaceMetadata(f, ref, value) {
  Object.assign(ref, f.put(ref.path, value));
  if (ref !== f.contract.target.snapshot) {
    const snapshot = JSON.parse(f.files.get(f.contract.target.snapshot.path));
    const entry = snapshot.artifacts.find((artifact) => artifact.path === ref.path);
    if (entry) Object.assign(entry, ref);
    Object.assign(f.contract.target.snapshot, f.put(f.contract.target.snapshot.path, snapshot));
  }
  repack(f);
}

function report(f) {
  f.manifest.representation_contract = f.attachment;
  f.put('ovdb.yaml', f.manifest);
  f.put('OVDB.md', '---\novdb: 1\npublish: [./ovdb.yaml]\n---\n');
  return reportOvdbManifest(f.reader, { repository: providerRepo });
}

function explicitSnapshot(f, original, embedded = original) {
  const source = f.put('source/original.json', original);
  const snapshot = JSON.parse(f.files.get(f.contract.target.snapshot.path));
  snapshot.artifacts.push(source);
  replaceMetadata(f, f.contract.target.snapshot, snapshot);
  const provenance = JSON.parse(f.files.get(f.contract.native.provenance.path));
  provenance.snapshot = structuredClone(embedded);
  provenance.snapshot_association = { source, output_key: 'sqlite' };
  replaceMetadata(f, f.contract.native.provenance, provenance);
  return source;
}

test('public manifest report preserves valid formats and refuses all falsey metadata roots', () => {
  for (const format of [1, 2, 3]) assert.deepEqual(report(manifestFixture(format)).problems, []);
  for (const root of [null, false, 0, '']) {
    for (const artifact of ['snapshot', 'provenance', 'bridge', 'keys', 'model']) {
      const f = manifestFixture(['bridge', 'keys'].includes(artifact) ? 2 : 3);
      const ref = artifact === 'provenance' ? f.contract.native.provenance : artifact === 'bridge' ? f.contract.bridge.artifact : f.contract.target[artifact];
      replaceMetadata(f, ref, JSON.stringify(root));
      const result = report(f);
      assert.match(result.problems.join('\n'), /metadata root must be an object/, `${artifact}: ${JSON.stringify(root)}`);
      assert.doesNotMatch(result.notes.join('\n'), /associations checked/);
    }
    const f = manifestFixture(3);
    const original = { outputs: { sqlite: { file: f.contract.native.dataset.path, sha256: f.contract.native.dataset.sha256 } }, counts: { Entities: 2 } };
    const source = explicitSnapshot(f, original);
    replaceMetadata(f, source, JSON.stringify(root));
    // The provenance association must keep the changed exact reference.
    const provenance = JSON.parse(f.files.get(f.contract.native.provenance.path));
    provenance.snapshot_association.source = source;
    replaceMetadata(f, f.contract.native.provenance, provenance);
    assert.match(report(f).problems.join('\n'), /metadata root must be an object/);
  }
});

test('all short control escapes preserve decoded strings and integrated exact associations', () => {
  for (const [escape, code] of [['b', 8], ['f', 12], ['n', 10], ['r', 13], ['t', 9]]) {
    const unicode = `\\u${code.toString(16).padStart(4, '0')}`;
    const short = `\\${escape}`;
    assert.throws(() => parseStrictJson(bytes(`{"${short}":1,"${unicode}":2}`), 1024), /duplicate JSON key/);
    assert.deepEqual(parseStrictJson(bytes(`{"${short}":1,"${escape}":2}`), 1024), { [String.fromCharCode(code)]: 1, [escape]: 2 });
    assert.equal(parseStrictJson(bytes(`"${short}"`), 1024, 'JSON', { losslessNumbers: true }), String.fromCharCode(code));
    const duplicate = manifestFixture(3);
    const snapshotText = duplicate.files.get(duplicate.contract.target.snapshot.path).toString();
    replaceMetadata(duplicate, duplicate.contract.target.snapshot, `${snapshotText.slice(0, -1)},"${short}":1,"${unicode}":2}`);
    assert.match(report(duplicate).problems.join('\n'), /duplicate JSON key/);
    for (const mismatch of [false, true]) {
      const f = manifestFixture(3);
      const original = { outputs: { sqlite: { file: f.contract.native.dataset.path, sha256: f.contract.native.dataset.sha256 } }, counts: { Entities: 2 }, label: String.fromCharCode(code) };
      explicitSnapshot(f, original, { ...original, label: mismatch ? escape : original.label });
      if (mismatch) assert.match(report(f).problems.join('\n'), /embedded snapshot differs/);
      else assert.deepEqual(report(f).problems, []);
    }
  }
});

test('source scope identity is independent of member order including schema and format3 data', () => {
  const reverse = (value) => Object.fromEntries(Object.entries(value).reverse());
  for (const mode of ['source', 'schema', 'data']) {
    const f = manifestFixture(3);
    const copy = structuredClone(f.contract);
    if (mode === 'source') copy.source = reverse(copy.source);
    else copy.source[mode] = reverse(copy.source[mode]);
    f.doc.contracts.push(copy); repack(f);
    assert.match(report(f).problems.join('\n'), /duplicate source scope/, mode);
  }
  const distinct = manifestFixture(3);
  const copy = structuredClone(distinct.contract);
  copy.source.data.path = 'source/other.json';
  distinct.doc.contracts.push(copy); repack(distinct);
  assert.deepEqual(report(distinct).problems, []);
});

test('public manifest report binds own meaning file and rejects dot repository components', () => {
  const f = manifestFixture(3);
  f.put('model/different.meaning.yaml', f.files.get(f.manifest.meaning.file).toString());
  f.manifest.meaning.file = 'model/different.meaning.yaml';
  assert.match(report(f).problems.join('\n'), /target binding path differs from manifest.meaning.file/);
  for (const repository of ['https://github.com/./source', 'https://github.com/../source', 'https://github.com/example/.', 'https://github.com/example/..']) {
    const g = manifestFixture(3);
    g.contract.source.schema.repository = repository; repack(g);
    assert.match(report(g).problems.join('\n'), /source.schema must name another immutable/);
  }
});

test('malformed bridge rows and binding elements produce bounded report findings without throwing', () => {
  for (const rows of [[null], [false], [0], [''], [{ raw_label: 'x' }], {}, 'rows', null]) {
    const f = manifestFixture(2);
    replaceMetadata(f, f.contract.bridge.artifact, { table: 'Bridge', rows });
    const result = report(f);
    assert.match(result.problems.join('\n'), /bridge .*invalid/);
    assert.ok(result.problems.length < 10);
  }
  for (const concepts of [[null], ['concept'], [{ id: 'target-entity', bindings: [null] }], [{ id: 'target-entity', bindings: {} }]]) {
    const f = manifestFixture(3);
    const binding = parseYaml(f.files.get(f.contract.target.binding.document.path).toString());
    binding.concepts = concepts;
    replaceMetadata(f, f.contract.target.binding.document, binding);
    const result = report(f);
    assert.ok(result.problems.length > 0 && result.problems.length < 10);
  }
});

test('public report preserves raw hash precedence, fatal UTF8, depth bounds and original number tokens', () => {
  const wrongHash = manifestFixture(3);
  wrongHash.files.set(wrongHash.attachment.path, Buffer.from([0xff]));
  const hashProblems = report(wrongHash).problems.join('\n');
  assert.match(hashProblems, /raw-byte SHA-256 mismatch/);
  assert.doesNotMatch(hashProblems, /UTF-8/);
  const invalidUtf8 = manifestFixture(3);
  replaceMetadata(invalidUtf8, invalidUtf8.contract.target.snapshot, Buffer.from([0xff]));
  assert.match(report(invalidUtf8).problems.join('\n'), /invalid UTF-8/);
  for (const depth of [32, 33]) {
    const f = manifestFixture(3);
    replaceMetadata(f, f.contract.target.snapshot, '['.repeat(depth) + '0' + ']'.repeat(depth));
    const problems = report(f).problems.join('\n');
    if (depth === 33) assert.match(problems, /JSON depth exceeds 32/);
    else { assert.match(problems, /metadata root must be an object/); assert.doesNotMatch(problems, /JSON depth/); }
  }
  for (const token of ['1.0', '1e0', '9007199254740993']) {
    const f = manifestFixture(3);
    const embedded = { outputs: { sqlite: { file: f.contract.native.dataset.path, sha256: f.contract.native.dataset.sha256 } }, counts: { Entities: 2 }, extra: token.startsWith('9') ? 9007199254740992 : 1 };
    explicitSnapshot(f, JSON.stringify(embedded).replace(/"extra":\d+/, `"extra":${token}`), embedded);
    assert.match(report(f).problems.join('\n'), /embedded snapshot differs/, token);
  }
});
function resizeLocalArtifact(f, artifact, size) {
  const original = f.files.get(artifact.path);
  assert.ok(size >= original.length);
  const padded = Buffer.concat([original, Buffer.alloc(size - original.length, 0x20)]);
  f.files.set(artifact.path, padded);
  artifact.sha256 = sha(padded);
  const snapshotRef = f.contract.target.snapshot;
  const snapshot = JSON.parse(f.files.get(snapshotRef.path).toString('utf8'));
  snapshot.artifacts.find((entry) => entry.path === artifact.path).sha256 = artifact.sha256;
  const snapshotBytes = bytes(snapshot);
  f.files.set(snapshotRef.path, snapshotBytes);
  snapshotRef.sha256 = sha(snapshotBytes);
  repack(f);
}

test('frozen formats 1, 2 and 3 check local committed bytes and state unresolved proof', () => {
  for (const version of [1, 2, 3]) {
    const f = fixture(version);
    const result = check(f);
    assert.deepEqual(result.problems, [], `${version}: ${result.problems.join('; ')}`);
    assert.match(result.notes.join('\n'), /partial precheck.*admission/);
    assert.equal(f.touched.includes('source/input.json'), false);
    assert.equal(f.touched.includes('native.sqlite'), false);
  }
});

test('format 3 data is mandatory and format 2 cannot carry it', () => {
  const f = fixture(3);
  delete f.contract.source.data; repack(f);
  assert.match(check(f).problems.join('\n'), /data/);
  const old = fixture(2);
  old.contract.source.data = external('source/input.json'); repack(old);
  assert.match(check(old).problems.join('\n'), /additional properties/);
});

test('closed envelope, schema, raw hash, local mode and duplicate JSON refuse', () => {
  const f = fixture(3);
  assert.match(precheckRepresentation({ ...f.attachment, extra: true }, f.reader, f.manifest, providerRepo).problems.join('\n'), /exactly path and sha256/);
  f.attachment.sha256 = '0'.repeat(64);
  assert.match(check(f).problems.join('\n'), /raw-byte SHA-256 mismatch/);
  f.attachment = ref('source/contract.json', f.files.get('source/contract.json'));
  f.reader.kind = (path) => path === 'source/contract.json' ? 'symlink' : 'file';
  assert.match(check(f).problems.join('\n'), /tracked regular file/);
  f.reader.kind = (path) => f.files.has(path) ? 'file' : 'missing';
  const duplicated = Buffer.from('{"format":"ovdb-representation-contract/3","format":"ovdb-representation-contract/3","contracts":[]}');
  f.files.set('source/contract.json', duplicated); f.attachment = ref('source/contract.json', duplicated);
  assert.match(check(f).problems.join('\n'), /duplicate JSON key/);
});

test('local model, provenance, snapshot and exact source coordinates fail closed', () => {
  const f = fixture(3);
  f.contract.target.model.sha256 = '0'.repeat(64); repack(f);
  assert.match(check(f).problems.join('\n'), /target\.model.*SHA-256|target\.model.*mismatch/);
  const g = fixture(3);
  g.contract.source.data.repository = providerRepo; repack(g);
  assert.match(check(g).problems.join('\n'), /source\.data must name another immutable/);
  const h = fixture(3);
  h.contract.native.dataset.sha256 = '0'.repeat(64); repack(h);
  assert.match(check(h).problems.join('\n'), /native\.dataset is not bound/);
});

test('strict JSON refuses malformed UTF-8, BOM, scalar escapes and duplicate decoded keys', () => {
  for (const bad of [Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), bytes('"\\ud800"'), bytes('{"a":1,"\\u0061":2}')]) {
    assert.throws(() => parseStrictJson(bad, 1024), /UTF-8|BOM|surrogate|duplicate/);
  }
});

test('native provenance accepts exactly 2 MiB and refuses one byte over; other metadata retains 4 MiB', () => {
  const native = fixture(3);
  resizeLocalArtifact(native, native.contract.native.provenance, 2 * 1024 * 1024);
  assert.deepEqual(check(native).problems, []);
  resizeLocalArtifact(native, native.contract.native.provenance, 2 * 1024 * 1024 + 1);
  assert.match(check(native).problems.join('\n'), /native\.provenance.*oversize|native\.provenance.*exceeds/);

  const bridge = fixture(2);
  resizeLocalArtifact(bridge, bridge.contract.bridge.artifact, 2 * 1024 * 1024 + 1);
  assert.deepEqual(check(bridge).problems, []);
});

test('committed HEAD fixture exercises the same regular-file reader as the publisher', () => {
  const f = fixture(3, 'scripts/testdata/representation/');
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const files = gitRepoFiles(repositoryRoot);
  const result = precheckRepresentation(f.attachment, files, f.manifest, providerRepo);
  assert.deepEqual(result.problems, [], result.problems.join('; '));
  assert.match(result.notes.join('\n'), /source\.data raw bytes are unresolved offline/);
  const duplicateBytes = Buffer.from('{"format":"ovdb-representation-contract/3","format":"ovdb-representation-contract/3","contracts":[]}');
  const bad = precheckRepresentation(ref('scripts/testdata/representation/duplicate-contract.json', duplicateBytes), files, f.manifest, providerRepo);
  assert.match(bad.problems.join('\n'), /duplicate JSON key/);
});

// ModelSpec JSON in either vocabulary: 1.0-draft (entities, properties, entity) or 1.0-draft-2 (records, fields, record).
const inCurrentSpelling = (text) => text
  .replace('"modelspec":"1.0-draft"', '"modelspec":"1.0-draft-2"')
  .replaceAll('"entities":', '"records":').replaceAll('"properties":', '"fields":').replaceAll('"entity":', '"record":');

// Puts `text` in place of the fixture's target model, keeping the provenance that names it consistent.
function swapModel(f, text) {
  replaceMetadata(f, f.contract.target.model, text);
  if (f.contract.native) {
    const provenance = JSON.parse(f.files.get(f.contract.native.provenance.path));
    provenance.native_key.model = f.contract.target.model;
    replaceMetadata(f, f.contract.native.provenance, provenance);
  }
}

test('the target model is read in the current spelling as in the earlier one, for every contract format', () => {
  for (const format of [1, 2, 3]) {
    const earlier = manifestFixture(format);
    const text = earlier.files.get(earlier.contract.target.model.path).toString();
    assert.match(text, /"modelspec":"1\.0-draft","module"/);
    const current = manifestFixture(format);
    swapModel(current, inCurrentSpelling(text));
    assert.match(current.files.get(current.contract.target.model.path).toString(), /"modelspec":"1\.0-draft-2".*"records":.*"fields":/);
    assert.deepEqual(report(current).problems, report(earlier).problems, `format ${format}`);
    assert.deepEqual(report(current).problems, [], `format ${format}`);
  }
});

test('a target model whose identifier and keys are of different vocabularies, or whose identifier is unknown, is refused', () => {
  for (const [name, change, pattern] of [
    ['1.0-draft-2 with entities', (text) => text.replace('"1.0-draft"', '"1.0-draft-2"'), /target ModelSpec module\/entity\/property\/datatype mismatch/],
    ['1.0-draft with records and fields', (text) => inCurrentSpelling(text).replace('"1.0-draft-2"', '"1.0-draft"'), /target ModelSpec module\/entity\/property\/datatype mismatch/],
    ['an identifier of neither', (text) => text.replace('"1.0-draft"', '"1.0-draft-3"'), /target ModelSpec module\/entity\/property\/datatype mismatch/],
    ['1.0-draft-2 with entities only for the manifest', (text) => inCurrentSpelling(text).replaceAll('"records":', '"entities":'), /has no records|has no entities|mismatch/],
  ]) {
    const f = manifestFixture(3);
    swapModel(f, change(f.files.get(f.contract.target.model.path).toString()));
    assert.match(report(f).problems.join('\n'), pattern, name);
  }
});

test('the recordsets of an own model are the names of its record types, whichever vocabulary names them', () => {
  for (const [identifier, spelling] of [['1.0-draft', (text) => text], ['1.0-draft-2', inCurrentSpelling]]) {
    const f = manifestFixture(3);
    swapModel(f, spelling(f.files.get(f.contract.target.model.path).toString()));
    f.manifest.recordsets = ['Entities'];
    assert.match(report(f).problems.join('\n'), /recordsets lacks ModelSpec entities: Bridge/, identifier);
    f.manifest.recordsets = ['Entities', 'Bridge', 'Extra'];
    assert.match(report(f).problems.join('\n'), /recordsets names things that are not ModelSpec entities: Extra/, identifier);
  }
  const f = manifestFixture(3);
  swapModel(f, inCurrentSpelling(f.files.get(f.contract.target.model.path).toString()).replaceAll('"records":', '"entities":'));
  assert.match(report(f).problems.join('\n'), /target\.modelspec\.json has no records \(an object of ModelSpec records\)|has no records/);
});

test('a contract finds its target among the record types of the recordsets, in either form of the manifest, and a recordset of that record type that lists columns is refused', () => {
  for (const format of [1, 3]) {
    const f = manifestFixture(format);
    assert.deepEqual(report(f).problems, [], `format ${format}`);
    // the new form, own name and record type the same
    f.manifest.format = 'ovdb-manifest/draft-2';
    f.manifest.recordsets = [{ name: 'Entities', record_type: 'Entities' }, 'Bridge'];
    assert.deepEqual(report(f).problems, [], `format ${format}, the new form`);
    // the target is a record type: a recordset of another name whose record type it is, in the new form ...
    f.manifest.recordsets = [{ name: 'orgs', record_type: 'Entities' }, 'Bridge'];
    assert.deepEqual(report(f).problems, [], `format ${format}, new form, a recordset named orgs`);
    f.manifest.recordsets = [{ name: 'Other', record_type: 'Entities' }, 'Bridge'];
    assert.deepEqual(report(f).problems, [], `format ${format}, new form, a recordset named Other`);
    // ... and in the old form, through recordset_entities
    const old = manifestFixture(format);
    old.manifest.recordsets = ['orgs', 'Bridge'];
    old.manifest.recordset_entities = { orgs: 'Entities' };
    assert.deepEqual(report(old).problems, [], `format ${format}, old form`);
    // no recordset has the record type: absent
    f.manifest.recordsets = [{ name: 'Entities', record_type: 'Other' }, 'Bridge'];
    assert.match(report(f).problems.join('\n'), /target entity is absent from manifest recordsets/, `format ${format}`);
    // names swapped: the recordset called Bridge has the record type Entities, so it is the target ...
    f.manifest.recordsets = [{ name: 'Entities', record_type: 'Bridge' }, { name: 'Bridge', record_type: 'Entities' }];
    assert.deepEqual(report(f).problems, [], `format ${format}, swapped names`);
    // ... and a contract reads its columns by the model's names, so that recordset lists none
    f.manifest.recordsets = [{ name: 'Entities', record_type: 'Bridge' }, { name: 'Bridge', record_type: 'Entities', columns: { identifier: { field: 'id' } } }];
    assert.match(report(f).problems.join('\n'), /recordset Bridge lists columns, but a representation contract reads its columns by the model's names/, `format ${format}, swapped names with a column`);
    // a recordset of another record type may list columns, even when it is called like the target
    f.manifest.recordsets = [{ name: 'Entities', record_type: 'Bridge', columns: { identifier: { field: 'id' } } }, { name: 'orgs', record_type: 'Entities' }];
    assert.doesNotMatch(report(f).problems.join('\n'), /lists columns, but a representation contract/, `format ${format}, a recordset called Entities of another record type`);
    // an empty columns says nothing
    f.manifest.recordsets = [{ name: 'orgs', record_type: 'Entities', columns: {} }, 'Bridge'];
    assert.deepEqual(report(f).problems, [], 'an empty columns says nothing');
    f.manifest.recordsets = [{ name: 'orgs', record_type: 'Entities', columns: { identifier: { field: 'id' } } }, 'Bridge'];
    assert.match(report(f).problems.join('\n'), /recordset orgs lists columns/, `format ${format}`);
  }
  // the bridge table keeps its native name, in either form
  const f = manifestFixture(1);
  f.manifest.format = 'ovdb-manifest/draft-2';
  f.manifest.recordsets = ['Entities', { name: 'Bridge', columns: { label: { field: 'raw_label' } } }];
  assert.match(report(f).problems.join('\n'), /recordset Bridge lists columns/);
  f.manifest.recordsets = ['Entities', { name: 'Other', record_type: 'Bridge' }];
  assert.match(report(f).problems.join('\n'), /bridge table is absent from manifest recordsets/);
});
