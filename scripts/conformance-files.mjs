// Runs one conformance case of the manifest mapping (scripts/testdata/manifest-conformance.json, a copy of the file
// in openvaultdb/directory) through this repository's offline pre-check. Test support: scripts/test-manifest-conformance.mjs
// uses it, and so does any script that wants this checker's verdict on the same case files as another checker.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { reportOvdbManifest } from './lib/ovdb-manifest.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const own = (path) => readFileSync(join(root, path), 'utf8');
export const conformance = JSON.parse(own('scripts/testdata/manifest-conformance.json'));

// The manifest of a case: this repository's own manifest with the case's format, recordsets and recordset_entities in place of its own.
export const manifestFor = (part) => {
  const { format: _format, recordsets: _recordsets, recordset_entities: _entities, ...rest } = parseYaml(own('ovdb.yaml'));
  // The case's model is the module shop: the manifest's own address for it is this repository plus that module.
  if (rest.model?.address !== undefined) rest.model = { ...rest.model, address: 'modelspec://github.com/demo-db/chinook/shop' };
  return { ...(Object.hasOwn(part, 'format') ? { format: part.format } : {}), ...rest, ...(Object.hasOwn(part, 'recordsets') ? { recordsets: part.recordsets } : {}), ...(Object.hasOwn(part, 'recordset_entities') ? { recordset_entities: part.recordset_entities } : {}) };
};

// The repository of a case, as the pre-check reads it: OVDB.md, the manifest, the case's model (module shop) and a meaning file that names
// it. `withModel: false` leaves the model file out, to show that a verdict is reached from the manifest's text alone.
export const filesFor = (part, vocabulary, { withModel = true } = {}) => {
  const meaning = parseYaml(own('model/chinook.meaning.yaml'));
  meaning.models = { shop: meaning.models.chinook };
  const files = new Map([
    ['OVDB.md', '---\novdb: 1\npublish: [./ovdb.yaml]\n---\n'],
    ['ovdb.yaml', stringifyYaml(manifestFor(part))],
    ['model/chinook.modelspec.hcl', '# the source of the model\n'],
    ['model/chinook.meaning.yaml', stringifyYaml(meaning)],
    ...(withModel ? [['model/chinook.modelspec.json', JSON.stringify(conformance.models[vocabulary])]] : []),
  ]);
  return {
    problem: () => '',
    read: (path) => { if (!files.has(path)) throw new Error(`${path} cannot be read at HEAD`); return files.get(path); },
    readBytes: (path) => Buffer.from(files.get(path)),
    kind: (path) => (files.has(path) ? 'file' : 'missing'),
  };
};

// This pre-check's verdict on a case: { problems, notes }. The notice about recordset_entities is among the notes.
export const chinookVerdict = (part, vocabulary = 'current', options = {}) => reportOvdbManifest(filesFor(part, vocabulary, options), { repository: 'https://github.com/demo-db/chinook' });
