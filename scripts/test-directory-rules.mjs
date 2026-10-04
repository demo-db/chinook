import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalUrlProblem } from './lib/directory-rules.mjs';
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
