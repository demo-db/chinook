# Chinook DemoDB provider

This repository owns the Chinook SQLite source, its provenance and licences, generated schema and semantic metadata, and the downloadable export files. `manifest.json` is the authored database definition; `metadata/contract.json` is generated from it and the pinned SQLite file. The shared website consumes that versioned contract and the files listed in `metadata/checksums.json`.

The canonical input is the unchanged `Chinook_Sqlite.sqlite` fixture from [`lerocha/chinook-database`](https://github.com/lerocha/chinook-database/tree/7f67772503d71ba90f19283c38e93923addb43fa), copied to `data-source/source.sqlite`. Its SHA-256 is `7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15`. The upstream data and dialect SQL scripts are MIT licensed; the ModelSpec is MIT and MeaningGraph file is CC0-1.0. Original notices are retained in `data-source/`.

Run the deterministic generators and checks with Node.js 22+, pnpm, and Python 3. The MeaningGraph file pins the universal concepts and schema to core commit `982916d73f0a35ff2558b0062f58aa3ac4f24d97`:

```sh
pnpm install --frozen-lockfile
pnpm generate
pnpm validate
pnpm test:data
pnpm lint:model
pnpm check:model-twin
pnpm check:meaning
pnpm check:schema
pnpm test:tools
```

`pnpm generate` derives the compatibility exports in `artifacts/data/`, schema and combined contract in `metadata/`, and the ModelSpec JSON/checksum from the pinned SQLite bytes. `pnpm validate` opens and checks the database and exports, verifies row counts, keys, foreign keys, views and representative SQL, and verifies generated checksums. The pinned ModelSpec and MeaningGraph releases and their archive hashes are in `scripts/tools.json`; install them with `pnpm tools:install` before their checks.

The provider preserves the existing Chinook downloads: `/data/chinook.sqlite`, `/data/chinook.json`, `/data/chinook.yaml`, and `/data/chinook.{mysql,postgresql,sqlserver}.sql`; per-table `/data/{json,csv,yaml,sql}/chinook.<Table>.<format>`; and model files under `/model/`. Their repository equivalents are under `artifacts/data/` and `model/`. The table names and schema are derived from the actual SQLite database.

Chinook invoices remain billing records, distinct from the order concept. The `InvoiceLine` concept also declares the shared `commercial-line-item` ancestor in `manifest.json`, allowing similarity with Northwind order details without equating orders and invoices.

The public OVDB database identity is `https://demodb.dev/chinook/`, with provider-local id `chinook`, shared server `https://demodb.dev/ovdb`, and API `https://demodb.dev/ovdb/v1/databases/chinook`. `ovdb-database.json` is generated from the provider manifest and introspected schema; the shared website serves those same bytes at both `/chinook/ovdb-database.json` and `/ovdb/db/chinook/ovdb-database.json`. Its recordsets expose native table names and schema without sample rows. `ovdb.yaml` remains the backward-compatible `ovdb-manifest/draft-1` publisher input; its local `id` and format are unchanged. The read-only deployment remains at `https://cloud.openvaultdb.com/ovdb/dbs/chinook`, discovered through `https://demodb.dev/.well-known/openvaultdb`. The Chinook site is `https://chinook.demodb.dev/`; `chinookdb.com` remains a compatibility alias. DataTug’s static JSON exports are available under `artifacts/data/json/`.

The website registry pins an immutable provider commit and the SHA-256 values from `metadata/checksums.json`. To add a future database such as Sakila, add a provider repository with this contract, preserve its upstream fixture and licence, generate and validate its metadata and exports, then register its immutable commit and contract hash in the website repository. Shared pages and hostname routing need no database-specific branches.

The offline publisher pre-check (`pnpm check:ovdb`, exercised by `pnpm test:directory-rules`) accepts `licences.data` as one of the 18 SPDX IDs in `scripts/lib/ovdb-manifest.mjs`, or 2–4 distinct IDs from that same list joined with exactly ` AND `, up to 64 ASCII bytes in total. Examples are `CC0-1.0 AND CC-BY-4.0` and `MIT AND Apache-2.0`; either operand order is accepted and the authored scalar string is preserved in the generated descriptor. The conjunction profile requires exact case and spacing, with no normalization; it refuses unknown IDs, repeats, extra terms, other operators, parentheses, references and control or Unicode whitespace. `licences.model` and `licences.meaning` retain their single-ID rules.

This bounded syntax check does not establish legal compatibility or supply attribution. Preserve scoped source rights, licence files, notices and modification statements with served/downloaded material. The checker remains an offline pre-check; the Directory is authoritative and cross-validator/runtime acceptance must be verified before admitting a provider.

## Native inGitDB snapshot

The `ingitdb/` directory contains 15,607 source rows in 11 collections, exported from the pinned SQLite fixture by DataTug's generic DALgo → inGitDB exporter. The source fixture SHA-256 is `7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15`. This Git-backed edition is a queryable snapshot, not a live SQL database.

Use DataTug CLI v0.61.1 or newer to reproduce this export, and inGitDB CLI v0.70.0 or newer to validate and query this edition.

```sh
ingitdb validate --path ingitdb
ingitdb select --path ingitdb --from 'Album' --limit 1 --format json
```

Each source table has a `.collection/definition.yaml` with ordered fields, source primary-key columns, portable indexes and foreign-key groups/actions. `.ingitdb/source-collections.json` maps native collection IDs to exact SQLite table names; names outside inGitDB’s ID alphabet use a deterministic `dt_` UTF-8 hex ID. Its `source_schema.source_definition_json` retains the original SQLite DDL, declared column types, defaults and complete index details. The native record file is `records.json`, keyed by deterministic transport IDs derived from the ordered source primary key; keyless tables use source-row ordinals. These transport IDs are not new SQL columns. Exact decimals are stored as strings, BLOBs as base64, and `source-storage-*.jsonl` sidecars retain decimal SQLite storage classes where needed. This fixture has no source views.

The checked-in Git snapshot is the published inGitDB edition. [`ingitdb/export-manifest.json`](ingitdb/export-manifest.json) records the DataTug version, binary hash, pinned source and record checksums, plus the independent parity receipt at [`ingitdb/native-parity-report.json`](ingitdb/native-parity-report.json). Its `prepared-not-hosted` status describes the generated bundle before repository publication and also covers BigQuery load files; it does not imply a hosted BigQuery service.

The published record format is DataTug's default JSON. To produce another edition from a verified, decoded copy of this pinned SQLite fixture, choose a **new** destination and pass `--records-format json` (default), `jsonl`, `ingr`, `csv`, or `yaml`:

```sh
datatug db export --from sqlite:///absolute/path/to/pinned-source.sqlite \
  --to ingitdb:///absolute/path/to/new-output --records-format json
```

The independent checker in `demo-db/websites/scripts/hosting-tools/validate_datatug_exports.py` compares the native schema and every typed row at its transport ID with this repository's pinned source. Run it from a checkout containing both repositories:

```sh
python3 ../websites/scripts/hosting-tools/validate_datatug_exports.py . ingitdb \
  --report /private/tmp/chinook-ingitdb-parity.json
```

The source primary keys, foreign keys, UNIQUE and CHECK constraints, defaults, collations and SQL actions are preserved as source metadata; inGitDB does not enforce their full SQL behavior on later record edits. Source rights and original notices remain in [`data-source/`](data-source/) and [`LICENSE`](LICENSE).
