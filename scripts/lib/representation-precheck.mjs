import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { parseStrictJson } from './strict-json.mjs';
import { vocabularyOf } from './modelspec.mjs';
import { hasColumns, recordsetNames, recordsetsOfType } from './manifest-mapping.mjs';

const MiB = 1024 * 1024;
const schemaPins = {
  'ovdb-representation-contract/1': ['schema.json', 'c75eb5cae7201a9c10432239ece5ffd93a750f191c9b04129c89169f4449d844'],
  'ovdb-representation-contract/2': ['schema2.json', 'fa281400fbe063d1abbcbf5c7578dd23932dd798ee91810e0906ffa2431dc0bc'],
  'ovdb-representation-contract/3': ['schema3.json', '3f7405034aaad25bc27a347d9cc66a6fab90c7561d8276aa8e97ee0c361ead22'],
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ownRef = (r) => !Object.hasOwn(r, 'repository') && !Object.hasOwn(r, 'revision');
const sameRef = (a, b) => object(a) && object(b) && exactKeys(a, ['path', 'sha256']) && a.path === b.path && a.sha256 === b.sha256;
const exactKeys = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const repository = (s) => {
  const match = typeof s === 'string' && /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/.exec(s);
  return Boolean(match) && ![match[1], match[2]].some((part) => part === '.' || part === '..') && !match[2].endsWith('.git');
};
// Reference property order is not part of a source scope's identity.
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
const path = (s) => typeof s === 'string' && Buffer.byteLength(s) <= 1024 && /^(?:[A-Za-z0-9_.-]+|\$records)(?:\/(?:[A-Za-z0-9_.-]+|\$records))*$/.test(s) && !s.split('/').some((part) => part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes('$') && part !== '$records');

export function checkRepresentationEnvelope(envelope) {
  if (!exactKeys(envelope, ['path', 'sha256'])) throw new Error('representation_contract must have exactly path and sha256');
  if (!path(envelope.path) || !envelope.path.endsWith('.json') || !/^[0-9a-f]{64}$/.test(envelope.sha256)) throw new Error('representation_contract path/hash is invalid');
}

// Only checks committed provider-local bytes and limited locally provable associations.
// External metadata, source data, canonical meaning, semantic admission and runtime remain unresolved.
export function precheckRepresentation(envelope, files, manifest, outerRepository) {
  const problems = [];
  const notes = [];
  const bad = (message) => problems.push(`representation_contract: ${message}`);
  try { checkRepresentationEnvelope(envelope); }
  catch (error) { return { problems: [error.message], notes }; }
  const read = (file, expectedHash, limit, json = false) => {
    const kind = files.kind(file);
    if (kind !== 'file') throw new Error(`${file} must be a tracked regular file, got ${kind}`);
    const bytes = files.readBytes(file, limit);
    if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw new Error(`${file} exceeds ${limit} bytes`);
    if (hash(bytes) !== expectedHash) throw new Error(`${file} raw-byte SHA-256 mismatch`);
    return json ? parseStrictJson(bytes, limit, file) : bytes;
  };
  let doc;
  try { doc = read(envelope.path, envelope.sha256, 2 * MiB, true); }
  catch (error) { return { problems: [`representation_contract: ${error.message}`], notes }; }
  const pin = schemaPins[doc?.format];
  if (!pin) return { problems: [`representation_contract: unsupported format ${JSON.stringify(doc?.format)}`], notes };
  let validate;
  try {
    const schemaBytes = readFileSync(new URL(`../../schemas/representation/${pin[0]}`, import.meta.url));
    if (hash(schemaBytes) !== pin[1]) throw new Error('pinned representation schema hash mismatch');
    const schema = parseStrictJson(schemaBytes, 2 * MiB, pin[0]);
    validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  } catch (error) { return { problems: [`representation_contract: ${error.message}`], notes }; }
  if (!validate(doc)) return { problems: [`representation_contract: invalid ${doc.format}: ${validate.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`], notes };
  if (!repository(outerRepository)) bad('outer publisher repository is invalid');

  const metadata = new Map();
  const rawMetadata = new Map();
  const local = (ref, label, parse = 'json', limit = 4 * MiB) => {
    if (!ownRef(ref)) { bad(`${label} must be provider-local`); return undefined; }
    const key = `${ref.path}:${ref.sha256}:${parse}:${limit}`;
    if (metadata.has(key)) return metadata.get(key);
    try {
      if (!path(ref.path)) throw new Error('unsafe reference path');
      const bytes = read(ref.path, ref.sha256, limit);
      rawMetadata.set(key, bytes);
      const value = parse === 'json' ? parseStrictJson(bytes, limit, ref.path) : parse === 'yaml' ? parseYaml(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), { uniqueKeys: true }) : bytes;
      metadata.set(key, value);
      return value;
    } catch (error) { bad(`${label}: ${error.message}`); return undefined; }
  };
  const external = (ref, label) => {
    if (!repository(ref?.repository) || !/^[0-9a-f]{40}$/.test(ref?.revision ?? '') || ref.repository === outerRepository) bad(`${label} must name another immutable repository/revision`);
    else notes.push(`${label} ${ref.repository}@${ref.revision}:${ref.path} external bytes and meaning unresolved offline`);
  };
  const localObject = (ref, label, parse = 'json', limit = 4 * MiB) => {
    const value = local(ref, label, parse, limit);
    if (value !== undefined && !object(value)) { bad(`${label}: metadata root must be an object`); return undefined; }
    return value;
  };
  const seenSources = new Set();
  for (const [index, c] of doc.contracts.entries()) {
    const label = `contracts[${index}]`;
    const sourceKey = JSON.stringify(canonical(c.source));
    if (seenSources.has(sourceKey)) bad(`${label}: duplicate source scope`);
    seenSources.add(sourceKey);
    external(c.source.schema, `${label}.source.schema`);
    external(c.decision.document, `${label}.decision.document`);
    external(c.target.binding.meaning.document, `${label}.target.binding.meaning.document`);
    if (c.execution === 'native-identifier' && c.source.data) {
      external(c.source.data, `${label}.source.data`);
      notes.push(`${label}.source.data raw bytes are unresolved offline; descriptor syntax alone is not exact input proof`);
    }
    for (const [field, ref] of [['target.model', c.target.model], ['target.snapshot', c.target.snapshot], ['target.binding.document', c.target.binding.document]]) {
      if (!ownRef(ref)) bad(`${label}.${field} must be provider-local`);
    }
    const model = localObject(c.target.model, `${label}.target.model`);
    const snapshot = localObject(c.target.snapshot, `${label}.target.snapshot`);
    const binding = localObject(c.target.binding.document, `${label}.target.binding.document`, 'yaml');
    if (manifest.model?.modelspec && c.target.model.path !== manifest.model.modelspec) bad(`${label}: target model path differs from manifest.model.modelspec`);
    else if (!manifest.model?.modelspec) notes.push(`${label}: shared model target association is unresolved offline`);
    if (manifest.model?.modelspec && c.target.binding.document.path !== manifest.meaning?.file) bad(`${label}: target binding path differs from manifest.meaning.file`);
    else if (!manifest.model?.modelspec) notes.push(`${label}: shared meaning target association is unresolved offline`);
    // A contract's target names a ModelSpec record type, as the Go check reads it: it is found among the record types of the
    // manifest's recordsets (the record_type: of an item, the pair in recordset_entities, else the recordset's own name), in
    // either form. A contract reads the columns of that recordset by the model's names, so the recordset lists none.
    const targetRecordsets = recordsetsOfType(manifest, c.target.entity);
    if (targetRecordsets.length === 0) bad(`${label}: target entity is absent from manifest recordsets`);
    else for (const name of targetRecordsets) if (hasColumns(manifest, name)) bad(`${label}: recordset ${name} lists columns, but a representation contract reads its columns by the model's names`);
    // The model is read in the vocabulary its identifier names: 1.0-draft (entities, properties) or 1.0-draft-2 (records, fields).
    const words = vocabularyOf(model);
    const records = words && model[words.records];
    const property = records?.[c.target.entity]?.[words.fields]?.[c.target.property];
    if (model && (!words || model.module?.name !== c.target.module || !property || property.type !== c.target.datatype)) bad(`${label}: target ModelSpec module/entity/property/datatype mismatch`);
    if (binding) {
      const address = `meaning://${c.target.binding.meaning.document.repository.slice(8)}/${c.target.binding.meaning.concept}?ref=${c.target.binding.meaning.document.revision}`;
      const concepts = binding.concepts;
      if (binding.format !== 'meaning/draft-1' || !Array.isArray(concepts) || !concepts.every((x) => object(x) && (x.bindings === undefined || Array.isArray(x.bindings) && x.bindings.every(object))) || !concepts.some((x) => x.id === c.target.binding.concept && x.extends === address && x.bindings?.some((b) => b.model === `modelspec:///${c.target.module}.${c.target.entity}` && b.property === c.target.property && b.role === c.target.binding.role))) bad(`${label}: local target binding does not identify pinned concept/property/role`);
    }
    const artifacts = new Map();
    if (snapshot) {
      try {
        exactFields(snapshot, ['generator', 'artifacts']);
        exactFields(snapshot.generator, ['repository', 'revision']);
        for (const artifact of snapshot.artifacts ?? []) exactFields(artifact, ['path', 'sha256']);
      } catch (error) { bad(`${label}: snapshot ${error.message}`); }
      if (!repository(snapshot.generator?.repository) || typeof snapshot.generator?.revision !== 'string' || !/^[0-9a-f]{40}$/.test(snapshot.generator.revision) || !Array.isArray(snapshot.artifacts) || snapshot.artifacts.length > 10000) bad(`${label}: snapshot generator/artifact bounds invalid`);
      else for (const artifact of snapshot.artifacts) {
        if (!object(artifact) || !path(artifact.path) || typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256) || artifacts.has(artifact.path)) bad(`${label}: invalid or duplicate snapshot artifact`);
        else artifacts.set(artifact.path, artifact.sha256);
      }
    }
    const associated = (ref, name) => { if (snapshot && artifacts.get(ref.path) !== ref.sha256) bad(`${label}: ${name} is not bound to exact snapshot artifact`); };
    if (c.execution === 'native-identifier') {
      if (c.source.namespace !== c.target.namespace) bad(`${label}: native namespaces differ`);
      for (const [name, ref] of [['native.dataset', c.native.dataset], ['native.provenance', c.native.provenance]]) {
        if (!ownRef(ref)) bad(`${label}.${name} must be provider-local`);
        associated(ref, name);
      }
      associated(c.target.model, 'target.model'); associated(c.target.binding.document, 'target.binding.document');
      if (model) {
        const entity = records?.[c.target.entity];
        if (!Array.isArray(entity?.key) || entity.key.length !== 1 || entity.key[0] !== c.target.property || property?.required !== true) bad(`${label}: native target key must be one required selected property`);
        if (c.native.serving_identity_column && (c.native.serving_identity_column === c.target.property || !entity?.[words.fields]?.[c.native.serving_identity_column])) bad(`${label}: invalid serving identity column`);
      }
      const provenance = localObject(c.native.provenance, `${label}.native.provenance`, 'json', 2 * MiB);
      if (provenance) {
        try {
          // Match Go's open metadata projections; consumed fields keep exact spelling.
          exactFields(provenance, ['native_key', 'snapshot', 'snapshot_association']);
          exactFields(provenance.snapshot, ['outputs', 'counts']);
          if (!object(provenance.snapshot.outputs) || !object(provenance.snapshot.counts)) throw new Error('original outputs/counts must be objects');
          if (!Object.hasOwn(provenance, 'snapshot_association')) for (const output of Object.values(provenance.snapshot.outputs)) exactFields(output, ['sha256']);
        } catch (error) { bad(`${label}: provenance ${error.message}`); }
        if (!object(provenance) || !Object.hasOwn(provenance, 'native_key') || !Object.hasOwn(provenance, 'snapshot')) bad(`${label}: native provenance root fields invalid`);
        const n = provenance.native_key;
        if (!exactKeys(n, ['module', 'entity', 'property', 'namespace', 'model', 'binding', 'dataset', 'records', 'duplicates']) || n.module !== c.target.module || n.entity !== c.target.entity || n.property !== c.target.property || n.namespace !== c.target.namespace || !sameRef(n.model, c.target.model) || !sameRef(n.binding, c.target.binding.document) || !sameRef(n.dataset, c.native.dataset) || !Number.isSafeInteger(n.records) || n.records < 0 || n.duplicates !== 0) bad(`${label}: native provenance scope/refs/counts mismatch`);
        if (Object.hasOwn(provenance, 'snapshot_association')) {
          const association = provenance.snapshot_association;
          const source = association?.source;
          const outputKey = association?.output_key;
          if (!exactKeys(association, ['source', 'output_key']) || !exactKeys(source, ['path', 'sha256']) || !path(source.path) || !/^[0-9a-f]{64}$/.test(source.sha256) || !/^[A-Za-z0-9_-]{1,128}$/.test(outputKey ?? '') || [c.native.provenance.path, c.target.snapshot.path, c.native.dataset.path].includes(source.path) || artifacts.get(source.path) !== source.sha256) {
            bad(`${label}: malformed original snapshot association`);
          } else {
            const original = localObject(source, `${label}.snapshot_association.source`, 'json', 2 * MiB);
            if (original) {
              const selected = original.outputs?.[outputKey];
              try { exactFields(selected, ['file', 'sha256']); }
              catch (error) { bad(`${label}: original output ${error.message}`); }
              if (!object(selected) || selected.file !== c.native.dataset.path || selected.sha256 !== c.native.dataset.sha256 || !Number.isSafeInteger(original.counts?.[c.target.entity]) || original.counts[c.target.entity] < 0 || original.counts[c.target.entity] !== n?.records) bad(`${label}: original snapshot selected output/count mismatch`);
              const originalBytes = rawMetadata.get(`${source.path}:${source.sha256}:json:${2 * MiB}`);
              const provenanceBytes = rawMetadata.get(`${c.native.provenance.path}:${c.native.provenance.sha256}:json:${2 * MiB}`);
              if (originalBytes && provenanceBytes) {
                const originalTokens = parseStrictJson(originalBytes, 2 * MiB, source.path, { losslessNumbers: true });
                const embeddedTokens = parseStrictJson(provenanceBytes, 2 * MiB, c.native.provenance.path, { losslessNumbers: true }).snapshot;
                if (!isDeepStrictEqual(originalTokens, embeddedTokens)) bad(`${label}: embedded snapshot differs from exact original values/number tokens`);
              }
            }
          }
        } else if (provenance.snapshot?.outputs?.[c.native.dataset.path]?.sha256 !== c.native.dataset.sha256 || provenance.snapshot?.counts?.[c.target.entity] !== n?.records) bad(`${label}: native provenance original output/count mismatch`);
      }
      notes.push(`${label}: native.dataset corpus is not read by metadata precheck`);
    } else {
      // The bridge table keeps its native name: it is found by the recordset's own name, and the model is read by that name.
      if (!recordsetNames(manifest).includes(c.bridge.table)) bad(`${label}: bridge table is absent from manifest recordsets`);
      else if (hasColumns(manifest, c.bridge.table)) bad(`${label}: recordset ${c.bridge.table} lists columns, but a representation contract reads its columns by the model's names`);
      if (model) {
        const columns = records?.[c.bridge.table]?.[words.fields];
        if (!columns || c.bridge.raw_label_column === c.bridge.target_key_column || columns[c.bridge.raw_label_column]?.type !== 'string' || columns[c.bridge.target_key_column]?.type !== 'string' || c.bridge.serving_identity_column && (c.bridge.serving_identity_column === c.bridge.raw_label_column || c.bridge.serving_identity_column === c.bridge.target_key_column || !columns[c.bridge.serving_identity_column])) bad(`${label}: bridge columns missing or overlapping in local model`);
      }
      const bridge = localObject(c.bridge.artifact, `${label}.bridge.artifact`);
      const keys = localObject(c.target.keys, `${label}.target.keys`);
      let bridgeRowsValid = false;
      associated(c.bridge.artifact, 'bridge.artifact'); associated(c.target.keys, 'target.keys');
      if (bridge) {
        if (!exactKeys(bridge, ['table', 'rows']) || bridge.table !== c.bridge.table || !Array.isArray(bridge.rows) || bridge.rows.length < 1 || bridge.rows.length > 10000) bad(`${label}: bridge table/rows invalid`);
        else {
          const labels = new Set();
          bridgeRowsValid = true;
          for (const row of bridge.rows) {
            if (!exactKeys(row, ['raw_label', 'target_key']) || typeof row.raw_label !== 'string' || !row.raw_label || typeof row.target_key !== 'string' || !row.target_key || labels.has(row.raw_label)) {
              bad(`${label}: bridge row collision/shape invalid`); bridgeRowsValid = false;
            } else labels.add(row.raw_label);
          }
        }
      }
      if (keys) {
        if (!exactKeys(keys, ['namespace', 'keys']) || keys.namespace !== c.target.namespace || !Array.isArray(keys.keys) || keys.keys.length < 1 || keys.keys.length > 10000 || keys.keys.some((x) => typeof x !== 'string' || !x) || new Set(keys.keys).size !== keys.keys.length) bad(`${label}: target key index invalid`);
        else if (bridgeRowsValid && bridge.rows.some((row) => !keys.keys.includes(row.target_key))) bad(`${label}: bridge target key absent from index`);
      }
    }
  }
  if (problems.length === 0) notes.push(`${doc.format}: provider-local attachment/reference bytes and selected manifest, model, binding, snapshot and provenance associations checked`);
  notes.push('representation_contract is an offline partial precheck: external metadata/data bytes, full ModelSpec and core meaning, immutable dependency readers, independent semantic continuity/admission, Directory publication and runtime remain unresolved');
  return { problems, notes };
}

// Protocol fields are ASCII. Unicode long-s and Kelvin-sign also fold to ASCII
// under Go strings.EqualFold; unrelated metadata names remain unconsumed.
function exactFields(value, fields) {
  if (!object(value)) throw new Error('expected metadata object');
  for (const key of Object.keys(value)) if (!fields.includes(key) && fields.some((field) => field.toLowerCase() === key.toLowerCase().replace(/ſ/g, 's'))) throw new Error(`non-exact JSON field ${key}`);
}
