// What the offline pre-check does with the names of recordsets, apart from the conformance cases shared with
// openvaultdb/directory: the recordset page of a name that is not an identifier, the rule that an unmapped name must look
// like an identifier where the model is in another repository, and the length of a name in either form.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { chinookVerdict, conformance } from './conformance-files.mjs';
import { encodePathSegment, publicHttpsProblem } from './lib/directory-rules.mjs';
import { reportOvdbManifest } from './lib/ovdb-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/demo-db/chinook';

const draft1 = 'ovdb-manifest/draft-1';
const draft2 = 'ovdb-manifest/draft-2';

// A recordset whose name is not an identifier and contains the text %2F. Written into the page it becomes %252F, which a
// second round of decoding turns into a slash, so the Directory refuses the page.
const encodedSeparator = 'a%2Fb';

describe('the recordset page of a name that is not an identifier', () => {
  for (const vocabulary of ['current', 'earlier']) {
    test(`a name whose encoded spelling can become a path separator is refused, in either form, model in the ${vocabulary} vocabulary`, () => {
      const forms = [
        { format: draft2, recordsets: ['Customer', { name: encodedSeparator, record_type: 'OrderLine' }] },
        { format: draft1, recordsets: ['Customer', encodedSeparator], recordset_entities: { [encodedSeparator]: 'OrderLine' } },
      ];
      for (const part of forms) {
        const { problems } = chinookVerdict(part, vocabulary);
        assert.equal(problems.length, 1, `${part.format}: ${problems.join('\n')}`);
        assert.match(problems[0], /the recordset page of a%2Fb, https:\/\/cloud\.openvaultdb\.com\/ovdb\/dbs\/chinook\/collections\/a%252Fb, has a nested percent escape/, part.format);
      }
    });

    test(`a name that is not an identifier and has a safe encoded spelling is accepted without a note about its page, model in the ${vocabulary} vocabulary`, () => {
      for (const name of ['Order Lines', '100%', '%41', 'a.b', "it's"]) {
        const forms = [
          { format: draft2, recordsets: ['Customer', { name, record_type: 'OrderLine' }] },
          { format: draft1, recordsets: ['Customer', name], recordset_entities: { [name]: 'OrderLine' } },
        ];
        for (const part of forms) {
          const { problems, notes } = chinookVerdict(part, vocabulary);
          assert.deepEqual(problems, [], `${part.format} ${JSON.stringify(name)}`);
          assert.equal(notes.some((note) => note.includes('the recordset page of')), false, `${part.format} ${JSON.stringify(name)}: no note about the page`);
        }
      }
    });
  }

  test('the encoded segment is the one the Directory writes, and nothing else in the path may carry an escape', () => {
    assert.equal(encodePathSegment("it's (a) *name*!"), 'it%27s%20%28a%29%20%2Aname%2A%21');
    const page = 'https://cloud.openvaultdb.com/ovdb/dbs/chinook/collections/';
    assert.equal(publicHttpsProblem(`${page}Order%20Lines`, { encodedPathSegment: 'Order%20Lines' }), null);
    assert.match(publicHttpsProblem(`${page}Order%20Lines`), /percent escape/, 'no escape is allowed unless the name asks for it');
    assert.match(publicHttpsProblem(`${page}Order%20Lines`, { encodedPathSegment: 'Other%20Name' }), /percent escape/, 'only the name\'s own escape is allowed');
    assert.match(publicHttpsProblem(`${page}%2e%2e`, { encodedPathSegment: '%2e%2e' }), /non-canonical or unsafe/, 'a lower-case escape is not the canonical spelling');
    assert.match(publicHttpsProblem(`${page}%2E%2E`, { encodedPathSegment: '%2E%2E' }), /non-canonical or unsafe/, 'a segment that decodes to a dot segment is refused');
    assert.match(publicHttpsProblem(`${page}%252E%252E`, { encodedPathSegment: '%252E%252E' }), /nested percent escape/, 'an escape that decodes to a dot segment in a second round is refused');
  });
});

// A manifest whose model is in another repository (a shared model), so that its record types cannot be read here.
function sharedModelProblems(recordsets, format = draft2) {
  const manifest = parseYaml(readFileSync(join(root, 'ovdb.yaml'), 'utf8'));
  manifest.format = format;
  manifest.model = { address: `modelspec://github.com/example/model/chinook?ref=${'a'.repeat(40)}` };
  manifest.meaning = { address: `meaning://github.com/example/graph?ref=${'b'.repeat(40)}`, file: 'model/chinook.meaning.yaml', graph: { id: 'chinook' } };
  manifest.recordsets = recordsets;
  const files = {
    kind: () => 'file',
    read: (path) => (path === 'ovdb.yaml' ? stringifyYaml(manifest) : path === 'OVDB.md' ? '---\novdb: 1\npublish: [./ovdb.yaml]\n---\n' : readFileSync(join(root, path), 'utf8')),
  };
  return reportOvdbManifest(files, { repository }).problems;
}

describe('where the model is in another repository', () => {
  test('a recordset that is not mapped to a record type must be named like one', () => {
    for (const format of [draft1, draft2]) {
      assert.deepEqual(sharedModelProblems(['Customer', 'OrderLine'], format), [], format);
      assert.deepEqual(sharedModelProblems(['Customer', 'Order Lines'], format), ['ovdb.yaml: recordsets names must look like ModelSpec entity names (letters, digits, underscore): "Order Lines"'], format);
    }
  });

  test('a recordset that is mapped to a record type may have the name of its table', () => {
    assert.deepEqual(sharedModelProblems(['Customer', { name: 'Order Lines', record_type: 'OrderLine' }]), []);
  });
});

describe('the length of a recordset name', () => {
  const longName = 'L'.repeat(257);
  const model = (vocabulary) => {
    const current = conformance.models[vocabulary];
    const key = vocabulary === 'current' ? 'records' : 'entities';
    return { ...current, [key]: { Customer: current[key].Customer, [longName]: current[key].OrderLine } };
  };
  for (const vocabulary of ['current', 'earlier']) {
    test(`a name of 257 letters is refused in either form, mapped or not, model in the ${vocabulary} vocabulary`, () => {
      const forms = [
        ['draft-2 unmapped', { format: draft2, recordsets: ['Customer', longName] }],
        ['draft-1 unmapped', { format: draft1, recordsets: ['Customer', longName] }],
        ['draft-2 mapped', { format: draft2, recordsets: ['Customer', { name: longName, record_type: longName }] }],
        ['draft-1 mapped', { format: draft1, recordsets: ['Customer', longName], recordset_entities: { [longName]: longName } }],
      ];
      for (const [label, part] of forms) {
        const { problems } = chinookVerdict(part, vocabulary, { model: model(vocabulary) });
        assert.ok(problems.some((problem) => problem.includes('must be at most 256 characters')), `${label}: ${problems.join('\n') || '(accepted)'}`);
      }
    });

    test(`a name of 256 letters is accepted in either form, model in the ${vocabulary} vocabulary`, () => {
      const name = 'L'.repeat(256);
      const key = vocabulary === 'current' ? 'records' : 'entities';
      const current = conformance.models[vocabulary];
      const accepted = { ...current, [key]: { Customer: current[key].Customer, [name]: current[key].OrderLine } };
      for (const format of [draft1, draft2]) {
        assert.deepEqual(chinookVerdict({ format, recordsets: ['Customer', name] }, vocabulary, { model: accepted }).problems, [], format);
      }
    });
  }
});
