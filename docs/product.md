# Product decisions

`gutter` is a public MIT self-hosted comic-library foundation. Files are read-only source material:
the application never edits, moves, deletes, renames, or repacks them. M1 lets an operator declare
up to 64 immutable container paths. The worker validates those paths in its own mount namespace and
persists a PostgreSQL availability snapshot (`ready_nonempty`, `ready_empty`, `missing`,
`unreadable`, `not_directory`, or `unavailable`) and a rebuildable read-only inventory.

Discovery is a bounded DFS of CBZ archives and innermost directories with direct supported image
files. ZIP metadata is used without extraction, CRC validation, image decoding, ComicInfo, or
watching. Malformed, unsafe, encrypted, over-limit, empty, and duplicate-locator archives are
quarantined. There is no reader, auth, upload, mutable registration endpoint/UI, or external
metadata provider. A configured root is not a published library.

The product boundary preserves future options while preventing source ownership: roots cannot be
`/`, overlap, or resolve through symlinks; the API has no library mount; and worker binds are
explicit and read-only. PostgreSQL plus pg-boss continues to avoid a second queue/Redis service.
