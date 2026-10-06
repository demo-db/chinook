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

The `ingitdb/` directory contains 15,607 source table rows across 11 collections. It is a Git-backed, queryable snapshot prepared from the pinned SQLite fixture. Verify and query it with the installed inGitDB CLI:

```sh
ingitdb validate --path ingitdb
ingitdb select --path ingitdb --from album_f05e840e --limit 1 --format json
```

[`ingitdb/export-manifest.json`](ingitdb/export-manifest.json) maps each native table to its collection, row count, original primary and foreign keys, column types, transport encodings, and SHA-256 of its record file. The source fixture SHA-256 is `7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15`. These bytes were exported against provider commit `26e852cca00101f53a84ef8ee1f1ae389067f5cf`; the source fixture hash also matches this repository's pinned fixture. Record keys encode native primary keys where present; keyless tables use stable ordinal IDs, which are not native keys. Native key relationships are descriptive metadata, not enforced in this snapshot. Exact decimal values travel as strings and binary values as base64 where marked in column metadata. Source view definitions are retained as metadata only; they are not materialized in inGitDB. Source rights and original notices remain in [`data-source/`](data-source/) and [`LICENSE`](LICENSE).
