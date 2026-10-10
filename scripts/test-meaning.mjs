// Tests for the stored-value check in scripts/lib/meaning.mjs (valueCoverageProblems): which files it reads and
// which binding key it reads the column from. node --test scripts/test-meaning.mjs. No network.
//
// The check compares the values stored in a bound column with the known values of the concept. It reads the
// format of each meaning file: meaning/draft-1 names the column with `property:`, meaning/draft-2 with `field:`
// (decision 0002 of meaninggraph/core), and a file in any other format is refused instead of passing with
// nothing checked. A list that is open (a value set without `complete: true`) is a separate question that is not
// decided (decision 0003 of meaninggraph/core, N57); every draft-2 case here uses a complete value set, so
// that no case depends on it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexConcepts, valueCoverageProblems } from './lib/meaning.mjs';

const address = 'github.com/example/shop';
const noOtherGraph = () => ({ error: 'no other graph in these tests' });
const check = (docs, data) => valueCoverageProblems({
  local: indexConcepts(docs.map((doc, index) => ({ path: `model/shop-${index}.meaning.yaml`, doc })), address),
  resolve: noOtherGraph,
  data,
});

const countries = [{ id: 'usa', labels: { en: 'USA' } }, { id: 'canada', labels: { en: 'Canada' } }];
const customers = (...values) => ({ Customer: values.map((Country) => ({ Country })) });

// A graph in meaning/draft-1: an attribute that lists its values, bound with `property:`.
const draft1 = (binding = {}) => ({
  format: 'meaning/draft-1',
  id: 'shop',
  name: 'Shop',
  description: 'A shop.',
  concepts: [{
    id: 'billing-country',
    kind: 'attribute',
    labels: { en: 'Billing country' },
    description: 'The country a customer is billed in.',
    values: countries,
    bindings: [{ model: 'modelspec:///shop.Customer', property: 'Country', role: 'value', ...binding }],
  }],
});

// The same graph in meaning/draft-2: a complete value set, and a property that takes its values from it, bound
// with `field:`.
const draft2 = (binding = {}) => ({
  format: 'meaning/draft-2',
  id: 'shop',
  name: 'Shop',
  description: 'A shop.',
  concepts: [
    { id: 'country-list', kind: 'value-set', labels: { en: 'Country' }, description: 'Countries.', complete: true, values: countries },
    {
      id: 'billing-country',
      kind: 'property',
      labels: { en: 'Billing country' },
      description: 'The country a customer is billed in.',
      'values-of': 'country-list',
      bindings: [{ model: 'modelspec:///shop.Customer', field: 'Country', role: 'value', ...binding }],
    },
  ],
});

test('a meaning/draft-1 file is read as before: property: names the column, a stored value that names no known value is a problem', () => {
  assert.deepEqual(check([draft1()], customers('USA', 'Canada', null)), []);
  const problems = check([draft1()], customers('USA', 'Atlantis'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Customer\.Country value "Atlantis" matches no value/);
  assert.match(problems[0], /model\/shop-0\.meaning\.yaml/);
});

test('a meaning/draft-2 file is read: field: names the column, a stored value that names no known value of a complete set is a problem', () => {
  assert.deepEqual(check([draft2()], customers('USA', 'canada', null)), []);
  const problems = check([draft2()], customers('USA', 'Atlantis'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Customer\.Country value "Atlantis" matches no value/);
  assert.match(problems[0], /model\/shop-0\.meaning\.yaml/);
});

test('in a meaning/draft-2 file field: is read for the role display-name and for match: codes.<code> too', () => {
  const coded = [{ id: 'usa', labels: { en: 'United States' }, codes: { iso: 'US' } }];
  const doc = draft2({ role: 'display-name', match: 'codes.iso' });
  doc.concepts[0].values = coded;
  assert.deepEqual(check([doc], customers('US')), []);
  const problems = check([doc], customers('US', 'XX'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Customer\.Country value "XX" matches no value by codes\.iso/);
});

test('in a meaning/draft-2 file a binding with no stored column to read (role instances) checks nothing', () => {
  const doc = draft2({ role: 'instances', field: undefined });
  assert.deepEqual(check([doc], customers('Atlantis')), []);
});

test('a file in a format this check does not know is refused, whatever binding key it uses', () => {
  for (const [format, binding] of [['meaning/draft-3', { field: 'Country' }], ['meaning/draft-3', { property: 'Country' }], ['meaning/1', { field: 'Country' }]]) {
    const doc = draft2();
    doc.format = format;
    Object.assign(doc.concepts[1].bindings[0], binding);
    const problems = check([doc], customers('Atlantis'));
    assert.ok(problems.length >= 1, `${format} with ${Object.keys(binding)[0]}: must be refused, got ${JSON.stringify(problems)}`);
    assert.match(problems.join('\n'), /model\/shop-0\.meaning\.yaml/);
    assert.ok(problems.join('\n').includes(format), `the refusal names the format ${format}: ${JSON.stringify(problems)}`);
  }
});

test('a file with no format is refused', () => {
  const doc = draft2();
  delete doc.format;
  const problems = check([doc], customers('USA'));
  assert.ok(problems.length >= 1, `must be refused, got ${JSON.stringify(problems)}`);
  assert.match(problems.join('\n'), /model\/shop-0\.meaning\.yaml/);
  assert.match(problems.join('\n'), /format/);
});

test('a refused file does not hide a problem of another file of the graph', () => {
  const unknown = draft2();
  unknown.format = 'meaning/draft-3';
  const problems = check([unknown, { ...draft1(), id: 'other', concepts: [{ ...draft1().concepts[0], id: 'shipping-country' }] }], customers('Atlantis'));
  assert.ok(problems.some((problem) => problem.includes('model/shop-0.meaning.yaml') && problem.includes('meaning/draft-3')), JSON.stringify(problems));
  assert.ok(problems.some((problem) => problem.includes('model/shop-1.meaning.yaml') && problem.includes('Atlantis')), JSON.stringify(problems));
});
