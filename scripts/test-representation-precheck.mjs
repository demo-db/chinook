import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { precheckRepresentation } from './lib/representation-precheck.mjs';
import { parseStrictJson } from './lib/strict-json.mjs';
import { gitRepoFiles } from './lib/ovdb-manifest.mjs';
import { fileURLToPath } from 'node:url';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40);
const sourceRepo = 'https://github.com/example/source';
const providerRepo = 'https://github.com/example/provider';
const ref = (path, bytes) => ({ path, sha256: sha(bytes) });
const external = (path) => ({ path, sha256: 'b'.repeat(64), repository: sourceRepo, revision });
const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

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
  const manifest = { model: { modelspec: targetModel.path }, recordsets: ['Entities', 'Bridge'] };
  const touched = [];
  const reader = {
    kind(path) { return files.has(path) ? 'file' : 'missing'; },
    readBytes(path, limit) { touched.push(path); const data = files.get(path); if (data.length > limit) throw new Error('oversize'); return data; },
  };
  return { files, put, doc, attachment, manifest, reader, touched, contract };
}

function check(f) { return precheckRepresentation(f.attachment, f.reader, f.manifest, providerRepo); }
function repack(f) { f.attachment = f.put('source/contract.json', f.doc); }

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
