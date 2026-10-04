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

OVDB’s canonical identity remains `https://chinookdb.com/ovdb/dbs/chinook`; the directory discovery document is served at `chinookdb.com`. Its configured read-only API is `https://cloud.openvaultdb.com/v1/databases/chinook`. The publisher manifest is `ovdb.yaml`. The Chinook site is now `https://chinook.demodb.dev/`; the old domain remains a compatibility alias. DataTug’s static JSON exports are available under `artifacts/data/json/`.

The website registry pins an immutable provider commit and the SHA-256 values from `metadata/checksums.json`. To add a future database such as Sakila, add a provider repository with this contract, preserve its upstream fixture and licence, generate and validate its metadata and exports, then register its immutable commit and contract hash in the website repository. Shared pages and hostname routing need no database-specific branches.
