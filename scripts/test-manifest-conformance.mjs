// The conformance cases of the manifest mapping, run through this repository's offline pre-check. The cases are one file,
// scripts/testdata/manifest-conformance.json, byte for byte the file of openvaultdb/directory (scripts/fixtures/manifest-conformance.json),
// which runs the same cases through the Directory checker; the two checkers must agree on every case. Each case is run twice, against
// the model in ModelSpec's current vocabulary and against the same model in the earlier one.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chinookVerdict, conformance, manifestFor } from './conformance-files.mjs';
import { formatOf, normalisedMapping } from './lib/manifest-mapping.mjs';

const noticed = (notes) => notes.some((note) => note.includes('recordset_entities is the earlier form of the mapping'));
const mentions = (lines, texts) => {
  const joined = lines.join('\n');
  for (const text of texts) assert.ok(joined.includes(text), `expected the problems to contain ${JSON.stringify(text)}, got:\n${joined || '(none)'}`);
};

for (const vocabulary of ['current', 'earlier']) {
  describe(`manifest conformance cases, model in the ${vocabulary} vocabulary`, () => {
    for (const c of conformance.cases) {
      test(`${c.id}: ${c.verdict}${c.stage ? ` at the ${c.stage} stage` : c.notice ? ' with a notice' : ''}`, () => {
        const result = chinookVerdict(c.manifest, vocabulary);
        if (c.verdict === 'refuse') {
          assert.notDeepEqual(result.problems, []);
          mentions(result.problems, c.messageHas);
          if (c.stage === 'manifest') {
            // Refused from the manifest's text alone: the verdict is the same with no model file in the repository.
            const without = chinookVerdict(c.manifest, vocabulary, { withModel: false });
            mentions(without.problems, c.messageHas);
          }
        } else {
          assert.deepEqual(result.problems, []);
          assert.equal(noticed(result.notes), c.notice, `the notice about recordset_entities is ${c.notice ? '' : 'not '}reported`);
        }
      });
    }

    for (const pair of conformance.pairs) {
      test(`${pair.id}: ${pair.cases.join(' and ')} are both accepted and give the same normalised mapping`, () => {
        const mappings = pair.cases.map((id) => {
          const part = conformance.cases.find((c) => c.id === id).manifest;
          assert.deepEqual(chinookVerdict(part, vocabulary).problems, []);
          return normalisedMapping(manifestFor(part));
        });
        assert.deepEqual(mappings[0], mappings[1]);
        assert.deepEqual(mappings[0].map(({ name, recordType }) => [name, recordType]), [['Customer', 'Customer'], ['Order Lines', 'OrderLine']]);
      });
    }
  });
}

test('the identifier decides the form', () => {
  assert.equal(formatOf({ format: 'ovdb-manifest/draft-1' }), 'old');
  assert.equal(formatOf({ format: 'ovdb-manifest/draft-2' }), 'new');
  for (const format of [undefined, null, 1, 2, 'ovdb-manifest/draft-3', 'ovdb-manifest/draft-2 ']) assert.equal(formatOf({ format }), null, String(format));
});
