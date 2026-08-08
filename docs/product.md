# Product decisions

`gutter` is a public MIT self-hosted comic-library foundation. Files are read-only source material:
the application never edits, moves, deletes, renames, or repacks them. M1 lets an operator declare
up to 64 immutable container paths. The worker validates those paths in its own mount namespace and
persists only a PostgreSQL availability snapshot (`ready_nonempty`, `ready_empty`, `missing`,
`unreadable`, `not_directory`, or `unavailable`).

This slice deliberately stops before library discovery: there is no recursive scan, catalog,
watcher, ComicInfo/CBZ processing, reader, auth, upload, mutable registration endpoint/UI, or
external metadata provider. A configured root is not a published library and a ready snapshot does
not claim any content was indexed.

The product boundary preserves future options while preventing source ownership: roots cannot be
`/`, overlap, or resolve through symlinks; the API has no library mount; and worker binds are
explicit and read-only. PostgreSQL plus pg-boss continues to avoid a second queue/Redis service.
