# Pinned source data

`source.sqlite` is the byte-for-byte SQLite fixture `ChinookDatabase/DataSources/Chinook_Sqlite.sqlite` from upstream repository `https://github.com/lerocha/chinook-database`, commit `7f67772503d71ba90f19283c38e93923addb43fa`.

SHA-256: `7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15`.

The source SQLite, upstream PostgreSQL, MySQL and SQL Server scripts, and their original MIT notice are retained unchanged. `scripts/generate-data.mjs` derives compatibility data files from this SQLite input. `scripts/generate.py` derives the schema contract and repository checksums. Generated downloads are stored under `artifacts/data/`.

The source database may change only when its upstream revision, digest, and this history change together. If a generator change alters published bytes, add a dated explanation here and regenerate `artifacts/data/metadata/checksums.json`.

Initial source: Chinook at upstream `7f67772503d71ba90f19283c38e93923addb43fa`.
