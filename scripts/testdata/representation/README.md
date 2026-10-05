# Synthetic representation precheck fixture

These small files exercise the current provider's HEAD-only offline reader. The
contract's external schema, decision, meaning and source-data references are
synthetic and deliberately unresolved. The native dataset is a logical
descriptor; no SQLite corpus is included. A clean precheck result for these
files establishes only local shape, bytes and association checks, never
semantic admission or Directory publication.

The schema copies in `schemas/representation/` are pinned byte-for-byte to
OpenVaultDB representation formats 1 and 2 at
`bb535a658f06a8752688ba36cb4b76ecf0483254` and the frozen format 3
schema SHA-256 `3f7405034aaad25bc27a347d9cc66a6fab90c7561d8276aa8e97ee0c361ead22`.
