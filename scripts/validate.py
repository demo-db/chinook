#!/usr/bin/env python3
"""Check the shipped contract and downloads against the immutable Chinook SQLite input."""
import csv
import hashlib
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text())
source_path = ROOT / manifest['dataFile']
source_bytes = source_path.read_bytes()
digest = hashlib.sha256(source_bytes).hexdigest()
assert digest == manifest['source']['sha256'], f'upstream fixture SHA-256 mismatch: {digest}'
schema = json.loads((ROOT / 'metadata/schema.json').read_text())
contract = json.loads((ROOT / 'metadata/contract.json').read_text())
assert schema == contract['schema']
assert contract['manifest'] == manifest

conn = sqlite3.connect(f'file:{source_path}?mode=ro', uri=True)
assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
assert not conn.execute('PRAGMA foreign_key_check').fetchall()
objects = {row[0]: row[1] for row in conn.execute("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")}
assert len([kind for kind in objects.values() if kind == 'table']) == 11
assert len([kind for kind in objects.values() if kind == 'view']) == 0
for item in schema['tables']:
    name = item['name']
    assert objects[name] == item['kind']
    if item['kind'] == 'table':
        assert conn.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] == item['rowCount']
        actual = conn.execute(f'PRAGMA table_info("{name}")').fetchall()
        expected = [c['name'] for c in item['columns']]
        assert [r[1] for r in actual] == expected, f'{name} column names/order'
        expected_pk = [c['name'] for c in sorted((c for c in item['columns'] if c['primaryKey']), key=lambda c: c['primaryKeyPosition'])]
        actual_pk = [r[1] for r in sorted((r for r in actual if r[5]), key=lambda r: r[5])]
        assert actual_pk == expected_pk, f'{name} primary key order'
        for fmt in ('json', 'yaml', 'csv', 'sql'):
            rel = f'artifacts/data/{fmt}/chinook.{name}.{fmt}'
            path = ROOT / rel
            assert path.is_file(), f'missing {rel}'
        rows = json.loads((ROOT / f'artifacts/data/json/chinook.{name}.json').read_text())
        assert len(rows) == item['rowCount'], f'{name} JSON row count'
        with (ROOT / f'artifacts/data/csv/chinook.{name}.csv').open(encoding='utf-8', newline='') as stream:
            assert sum(1 for _ in csv.reader(stream)) == item['rowCount'] + 1, f'{name} CSV row count'

artifacts = ROOT / 'artifacts/data'
assert (artifacts / 'chinook.sqlite').read_bytes() == source_bytes
for path in ('chinook.json', 'chinook.yaml', 'chinook.mysql.sql', 'chinook.postgresql.sql', 'chinook.sqlserver.sql'):
    assert (artifacts / path).is_file(), f'missing legacy download {path}'
checksums = json.loads((artifacts / 'metadata/checksums.json').read_text())
for rel, item in checksums['files'].items():
    raw = (artifacts / rel).read_bytes()
    assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], f'checksum mismatch: {rel}'
assert checksums['source']['sqliteSha256'] == digest
contract_checksums = json.loads((ROOT / 'metadata/checksums.json').read_text())['files']
for rel, item in contract_checksums.items():
    raw = (ROOT / rel).read_bytes()
    assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], f'contract checksum mismatch: {rel}'

public = json.loads((ROOT / 'ovdb-database.json').read_text())
assert public['format'] == 'ovdb-database/draft-1'
assert public['id'] == public['serverDbBaseUrl'].replace('/ovdb/db/chinook/', '/chinook/')
assert public['id'] == manifest['capabilities']['ovdb']['canonicalUrl'] == 'https://demodb.dev/chinook/'
assert public['localId'] == 'chinook' and public['serverId'] == 'https://demodb.dev/ovdb'
assert public['apiUrl'] == 'https://demodb.dev/ovdb/v1/databases/chinook'
assert public['capabilities'] == {'read': True, 'query': True, 'write': False}
assert [r['name'] for r in public['recordsets']] == [r['name'] for r in schema['tables'] if r['kind'] == 'table']
for recordset in public['recordsets']:
    assert 'rows' not in recordset and 'viewSql' not in recordset
    source_table = next(table for table in schema['tables'] if table['name'] == recordset['name'])
    assert recordset['columns'] == [{key: column[key] for key in ('name', 'type', 'nullable', 'primaryKey', 'primaryKeyPosition', 'defaultValue')} for column in source_table['columns']]
    assert recordset['primaryKey'] == source_table['primaryKey']
    assert recordset['foreignKeys'] == source_table['foreignKeys']
assert contract_checksums['schemas/ovdb-database-draft-1.schema.json']['sha256'] == '2424ef00acd462ab5a8abc546fe2d1fffbbb5397e312332aedc77b3e73109488'

# Validate representative site queries against the canonical database.
for query in manifest['queries']:
    conn.execute(query['sql']).fetchall()
assert conn.execute('SELECT count(*) FROM Artist').fetchone()[0] == 275
assert conn.execute('SELECT count(*) FROM Invoice').fetchone()[0] == 412
assert round(conn.execute('SELECT SUM(Total) FROM Invoice').fetchone()[0], 2) == 2328.60
print('Validated pinned Chinook SQLite, 11 table schemas and keys, legacy exports, checksums and sample queries.')
conn.close()
