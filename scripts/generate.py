#!/usr/bin/env python3
"""Derive the versioned Chinook contract from its pinned read-only SQLite source."""
import base64
import hashlib
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text())
source = ROOT / manifest['dataFile']
artifact_root = ROOT / 'artifacts' / 'data'
db = sqlite3.connect(f'file:{source}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
quote = lambda value: '"' + value.replace('"', '""') + '"'
objects = db.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name").fetchall()
tables = []
for obj in objects:
    name, kind = obj['name'], obj['type']
    if kind == 'table':
        raw_columns = db.execute(f'PRAGMA table_info({quote(name)})').fetchall()
        columns = [{
            'name': c['name'], 'type': c['type'] or 'TEXT',
            'nullable': not bool(c['notnull']), 'primaryKey': bool(c['pk']),
            'primaryKeyPosition': c['pk'] or None, 'defaultValue': c['dflt_value'],
        } for c in raw_columns]
        pk = [{'column': c['name'], 'position': c['pk']} for c in raw_columns if c['pk']]
        fks = [{'column': f['from'], 'table': f['table'], 'referencedColumn': f['to'], 'constraint': f['id'], 'position': f['seq']}
               for f in db.execute(f'PRAGMA foreign_key_list({quote(name)})')]
        count = db.execute(f'SELECT count(*) FROM {quote(name)}').fetchone()[0]
    else:
        columns = [{'name': c[0], 'type': c[1] or 'TEXT', 'nullable': True, 'primaryKey': False, 'primaryKeyPosition': None, 'defaultValue': None}
                   for c in db.execute(f'SELECT * FROM {quote(name)} LIMIT 0').description]
        pk, fks, count = [], [], None
    rows = db.execute(f'SELECT * FROM {quote(name)} LIMIT 12').fetchall()
    encode = lambda value: base64.b64encode(value).decode() if isinstance(value, bytes) else value
    tables.append({
        'name': name, 'kind': kind, 'description': manifest.get('tableDescriptions', {}).get(name, ''), 'columns': columns,
        'primaryKey': pk, 'foreignKeys': fks, 'rowCount': count,
        'viewSql': obj['sql'] if kind == 'view' else None,
        'rows': [{key: encode(value) for key, value in dict(row).items()} for row in rows],
    })

schema = {'contractVersion': manifest['contractVersion'], 'database': {'id': manifest['id'], 'name': manifest['name']}, 'source': manifest['source'], 'tables': tables}
exports = []
for path in sorted(p for p in artifact_root.rglob('*') if p.is_file()):
    rel = path.relative_to(ROOT).as_posix()
    exports.append({'path': rel, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
contract = {'contractVersion': manifest['contractVersion'], 'manifest': manifest, 'schema': schema, 'exports': exports}
(ROOT / 'metadata').mkdir(exist_ok=True)
(ROOT / 'metadata/schema.json').write_text(json.dumps(schema, indent=2, ensure_ascii=False) + '\n')
(ROOT / 'metadata/contract.json').write_text(json.dumps(contract, indent=2, ensure_ascii=False) + '\n')
checksums = {}
for path in sorted([ROOT / 'manifest.json', ROOT / 'metadata/contract.json', ROOT / 'metadata/schema.json', *artifact_root.rglob('*')]):
    if path.is_file() and path.name != 'checksums.json':
        checksums[path.relative_to(ROOT).as_posix()] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
(ROOT / 'metadata/checksums.json').write_text(json.dumps({'contractVersion': 1, 'files': checksums}, indent=2) + '\n')
print(f"Generated schema and contract for {len(tables)} tables/views with {len(exports)} exports")
db.close()
