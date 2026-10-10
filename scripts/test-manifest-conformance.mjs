// The conformance cases of the manifest mapping, run through this repository's offline pre-check. The cases are one file,
// scripts/testdata/manifest-conformance.json, byte for byte the file of openvaultdb/directory (scripts/fixtures/manifest-conformance.json),
// which runs the same cases through the Directory checker; the two checkers must agree on every case. Each case is run twice, against
// the model in ModelSpec's current vocabulary and against the same model in the earlier one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chinookVerdict, conformance, manifestFor } from './conformance-files.mjs';
import { columnModelProblems, formatOf, normalisedMapping } from './lib/manifest-mapping.mjs';

const noticed = (notes) => notes.some((note) => note.includes('recordset_entities is the earlier form of the mapping'));
// Cases that the case file puts at the file stage because the Directory reaches the refusal there, and that this pre-check
// refuses from the manifest's text alone: an old-form recordset that is not named like a record type is refused by the
// identifier rule before any model is read. The two checkers word that refusal differently, and both refuse it.
const refusedWithoutModelHere = new Set(['A4']);
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
          } else if (c.stage === 'file') {
            // Refused only with the model file read: with no model file in the repository its texts are not among the problems.
            const without = chinookVerdict(c.manifest, vocabulary, { withModel: false }).problems;
            const present = c.messageHas.filter((text) => without.join('\n').includes(text));
            assert.deepEqual(present, refusedWithoutModelHere.has(c.id) ? c.messageHas : [], `texts of a file-stage case found with no model file: ${without.join('\n') || '(no problem)'}`);
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

test('a column that holds a path into a component says that no reader reads components yet, and nothing about what the field holds', () => {
  const problems = columnModelProblems({ name: 'payments', recordType: 'Payment', columns: new Map([['amount_minor', 'Amount.Minor']]) }, new Set(['Amount']));
  assert.deepEqual(problems, ['recordsets "payments": column "amount_minor" holds "Amount.Minor": no reader of the model reads a component yet, so "Minor" cannot be read in Amount']);
});

test('a value that refers to itself is reported as a problem and does not throw', () => {
  const list = ['Customer', 'OrderLine'];
  list.push(list);
  const item = { name: 'Customer' };
  item.record_type = item;
  const columns = { name: 'Customer', columns: {} };
  columns.columns.self = columns.columns;
  for (const format of ['ovdb-manifest/draft-1', 'ovdb-manifest/draft-2']) {
    for (const recordsets of [list, ['OrderLine', item], ['OrderLine', columns]]) {
      let result;
      assert.doesNotThrow(() => { result = chinookVerdict({ format, recordsets }); }, `${format}`);
      assert.ok(result.problems.length > 0, `${format}: the manifest is refused`);
    }
  }
});

test('a map that refers to itself under its own key toString is reported as a problem and does not throw', () => {
  const recordType = {};
  recordType.toString = recordType;
  const format = {};
  format.toString = format;
  const cases = [
    ['record_type', { format: 'ovdb-manifest/draft-2', recordsets: ['Customer', { name: 'OrderLine', record_type: recordType }] }],
    ['format, draft-1 spelling', { format, recordsets: ['Customer', 'OrderLine'] }],
  ];
  for (const [label, part] of cases) {
    let result;
    assert.doesNotThrow(() => { result = chinookVerdict(part); }, label);
    assert.ok(result.problems.length > 0, `${label}: the manifest is refused`);
    assert.ok(result.problems.some((problem) => problem.includes('a value that refers to itself')), `${label}: ${result.problems.join('\n')}`);
  }
});

test('a recordset item that has a record type and no name is reported by its position', () => {
  const { problems } = chinookVerdict({ format: 'ovdb-manifest/draft-2', recordsets: [{ record_type: '9x' }] });
  assert.ok(problems.some((problem) => problem.includes('recordsets item 1 needs name:')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('recordsets item 1: record_type must be a ModelSpec record type name')), problems.join('\n'));
  assert.equal(problems.some((problem) => problem.includes('recordsets undefined')), false, problems.join('\n'));
});

test('a name listed twice is reported as that, and not also as two recordsets with one record type', () => {
  const { problems } = chinookVerdict({ format: 'ovdb-manifest/draft-2', recordsets: ['Customer', { name: 'Customer' }, 'OrderLine'] });
  assert.ok(problems.some((problem) => problem.includes('recordsets lists a name twice: "Customer"')), problems.join('\n'));
  assert.equal(problems.some((problem) => problem.includes('both have the record type')), false, problems.join('\n'));
});

// The mapping and the case file are held byte for byte by openvaultdb/directory as well (scripts/lib/manifest-mapping.mjs and
// scripts/fixtures/manifest-conformance.json there), and nothing but these two values shows when the copies drift apart: when
// one is changed, change the other the same way and record the new SHA-256 values in the test of each repository.
const sha256 = (path) => createHash('sha256').update(readFileSync(fileURLToPath(new URL(path, import.meta.url)))).digest('hex');
test('the mapping and the conformance cases are the files that openvaultdb/directory holds a copy of', () => {
  assert.equal(sha256('./lib/manifest-mapping.mjs'), 'f25fbe8aacce3cd7dd2e1418721a4e6de095f68ba1ee9f88249e6a7d5f50c303');
  assert.equal(sha256('./testdata/manifest-conformance.json'), '5a7b576cf5682c19e0d09f7f59843d78b59f0ae4d3beefc899db5570bb2602af');
});
